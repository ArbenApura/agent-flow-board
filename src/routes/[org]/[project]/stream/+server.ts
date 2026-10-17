// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- DEP-MODULES -- //
import { error } from '@sveltejs/kit';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import { latestEventId, mayReceive } from '#lib/server/ops/board.js';
import { OpError } from '#lib/server/ops/context.js';
import { listEvents } from '#lib/server/ops/history.js';
import { getProject } from '#lib/server/ops/projects.js';
import { getHub } from '#lib/server/realtime/hub.js';
import { orgContext } from '#lib/server/web/ctx.js';

// -- CONSTANTS -- //

const REPLAY_LIMIT = 200;
const HEARTBEAT_MS = 20_000;

// -- FUNCTIONS -- //

/**
 * One Server-Sent Events stream per open page and project. It tells the page that something changed (ids only, never
 * content), and the page refetches through its normal load. Membership is checked when the stream opens and on every
 * change. A reconnecting page sends Last-Event-ID, and gets what it missed, or `refetch` when that is too much.
 */
export const GET: RequestHandler = async ({ params, locals, request, url }) => {
	const { ctx } = await orgContext(locals, params.org, url.pathname);
	let project;
	try {
		project = await getProject(ctx, params.project);
	} catch (e) {
		if (e instanceof OpError) error(404, 'Not found');
		throw e;
	}
	const hub = await getHub(await getDb());
	const encoder = new TextEncoder();
	const header = request.headers.get('last-event-id') ?? url.searchParams.get('after');
	const lastId = header !== null && /^\d+$/.test(header) ? Number(header) : null;
	let cleanup = () => {};

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			let closed = false;
			const send = (name: string, data: unknown, id?: number) => {
				if (closed) return;
				controller.enqueue(
					encoder.encode(
						`${id !== undefined ? `id: ${id}\n` : ''}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
					)
				);
			};
			const close = () => {
				if (closed) return;
				closed = true;
				cleanup();
				try {
					controller.close();
				} catch {
					/* The client already went away */
				}
			};
			// A dropped page reconnects after a second, not the browser's slower default
			controller.enqueue(encoder.encode('retry: 1000\n\n'));
			let sent = lastId ?? 0;
			let replaying = true;
			// Ids the reconnect replay already sent, so a change that arrived while it ran is not sent twice
			const replayed = new Set<number>();
			const buffered: ({ e?: number; i?: string | null; k: string; v?: string } | null)[] = [];

			const deliver = async (c: (typeof buffered)[number]) => {
				if (closed) return;
				// The listening connection dropped, so changes may have been missed
				if (c === null) return send('refetch', {});
				if (!(await mayReceive(ctx, project.id, c.i))) {
					// A person who lost access to the whole project gets the stream closed
					if (!(await mayReceive(ctx, project.id))) close();
					return;
				}
				if (c.e !== undefined) {
					// Ids are taken when a row is written but announced when it commits, so two writes in flight can arrive out of
					// order. Only a change the replay already sent is skipped; a lower id arriving live is still news.
					if (replayed.delete(c.e)) return;
					sent = Math.max(sent, c.e);
				}
				send('change', { kind: c.k, verb: c.v ?? null, item: c.i ?? null }, c.e);
			};

			const unsubscribe = hub.subscribe(project.id, (c) => {
				if (replaying) buffered.push(c);
				else void deliver(c).catch(close);
			});
			const beat = setInterval(() => {
				if (!closed) controller.enqueue(encoder.encode(': ping\n\n'));
			}, HEARTBEAT_MS);
			cleanup = () => {
				clearInterval(beat);
				unsubscribe();
			};
			request.signal.addEventListener('abort', close);

			try {
				const latest = await latestEventId(ctx, project.id);
				if (lastId === null) {
					sent = latest;
				} else if (latest > lastId) {
					const missed = await listEvents(ctx, {
						project: project.id,
						afterId: lastId,
						limit: REPLAY_LIMIT
					});
					if (missed.length >= REPLAY_LIMIT) {
						send('refetch', {});
						sent = latest;
					} else {
						for (const m of missed.reverse()) {
							sent = Math.max(sent, m.id);
							replayed.add(m.id);
							send('change', { kind: 'event', verb: m.verb, item: m.itemId ?? null }, m.id);
						}
					}
				}
				send('ready', { latest: sent }, sent);
				replaying = false;
				for (const c of buffered.splice(0)) await deliver(c);
				replayed.clear();
			} catch (e) {
				if (!(e instanceof OpError)) console.error('Stream error', e);
				close();
			}
		},
		cancel() {
			cleanup();
		}
	});

	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store, no-transform',
			'x-accel-buffering': 'no'
		}
	});
};
