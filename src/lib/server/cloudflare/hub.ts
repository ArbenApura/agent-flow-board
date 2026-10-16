// THE REALTIME HUB ON CLOUDFLARE: ONE DURABLE OBJECT FOR EACH PROJECT, FED BY THE WORKER THAT MADE A CHANGE (SPEC 4, 12)
// Hyperdrive cannot carry LISTEN and NOTIFY, so a change is not announced by the database. The Worker that committed it tells the
// project's Durable Object after the request has finished, and every open stream of that project is a subscription to the same
// object. The object holds ids only, never content, and it is reachable only through the binding, so it trusts the Worker that
// already checked the viewer may see the project (the stream route does that before it subscribes).

// -- TYPES -- //
import type { Change } from '../realtime/notify';
import type { Listener, RealtimeHub } from '../realtime/hub';

/** The part of a Durable Object namespace binding this file uses. */
export type HubNamespace = {
	idFromName(name: string): unknown;
	get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
};

// -- FUNCTIONS -- //

const HEARTBEAT_MS = 15_000;

/** Tells each project's object about its changes. Failures are logged and never fail the request that made the change. */
export async function publishChanges(ns: HubNamespace, changes: Change[]): Promise<void> {
	const byProject = new Map<string, Change[]>();
	for (const c of changes) byProject.set(c.p, [...(byProject.get(c.p) ?? []), c]);
	await Promise.all(
		[...byProject].map(async ([project, list]) => {
			try {
				await ns.get(ns.idFromName(project)).fetch('https://hub/publish', {
					method: 'POST',
					body: JSON.stringify(list)
				});
			} catch (e) {
				console.error('Could not tell the hub about a change', e);
			}
		})
	);
}

/** The hub interface over the Durable Objects. A stream that ends tells its page to refetch, as a lost database connection does. */
export function workersHub(ns: HubNamespace): RealtimeHub {
	return {
		subscribe(projectId, fn: Listener) {
			const abort = new AbortController();
			void (async () => {
				try {
					const res = await ns.get(ns.idFromName(projectId)).fetch('https://hub/subscribe', {
						signal: abort.signal
					});
					const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
					if (!reader) return;
					let buffer = '';
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						buffer += value;
						let at: number;
						while ((at = buffer.indexOf('\n\n')) >= 0) {
							const block = buffer.slice(0, at);
							buffer = buffer.slice(at + 2);
							const data = /^data: (.*)$/m.exec(block)?.[1];
							if (!data) continue;
							try {
								fn(JSON.parse(data) as Change);
							} catch {
								/* A damaged line is skipped */
							}
						}
					}
				} catch {
					/* Ended or aborted */
				} finally {
					if (!abort.signal.aborted) fn(null);
				}
			})();
			return () => abort.abort();
		},
		// Background workers do not exist on Workers: queues and cron do their work
		subscribeAll: () => () => undefined,
		close: async () => undefined
	};
}

/** The Durable Object class. Exported by the Worker entry under the name the wrangler configuration binds. */
export class HubObject {
	private readonly subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly encoder = new TextEncoder();

	private send(text: string) {
		const bytes = this.encoder.encode(text);
		for (const w of [...this.subscribers])
			w.write(bytes).catch(() => {
				this.subscribers.delete(w);
			});
		if (!this.subscribers.size && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/publish' && request.method === 'POST') {
			const changes = (await request.json()) as Change[];
			for (const c of changes) this.send(`data: ${JSON.stringify(c)}\n\n`);
			return new Response('ok');
		}
		if (url.pathname === '/subscribe') {
			const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
			const writer = writable.getWriter();
			this.subscribers.add(writer);
			request.signal.addEventListener('abort', () => {
				this.subscribers.delete(writer);
				void writer.close().catch(() => undefined);
			});
			// A comment line now and then keeps every proxy on the way from closing an idle stream
			this.timer ??= setInterval(() => this.send(': ping\n\n'), HEARTBEAT_MS);
			return new Response(readable, {
				headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }
			});
		}
		return new Response('Not found', { status: 404 });
	}
}
