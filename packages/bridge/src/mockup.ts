// agent-flow-board mockup push <file.html>: UPLOADS ONE MOCKUP FILE TO THE BOARD OVER /api/v1 WITH THE BRIDGE'S OWN SIGN IN
// It reads the file by path from the agent's own folder, so the HTML never passes through a model's output. It is never queued, never
// goes through the MCP forwarder and changes nothing in the bridge protocol: a failed push says so and the agent runs it again.

// -- DEP-MODULES -- //
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
// -- MODULES -- //
import type { Fetch } from './device.js';

// -- TYPES -- //

export type PushOptions = {
	server: string;
	org: string;
	token: string;
	fetch: Fetch;
	/** The HTML file to upload. */
	file: string;
	/** The plan it belongs to (a reference), a project key for a mockup that has no plan, or an existing mockup for a new version. */
	item?: string;
	project?: string;
	mockup?: string;
	/** A second mockup on a plan that already has one, only when the person asked for it. */
	another?: boolean;
	title?: string;
	keepNotes?: string;
	freeNotes?: string;
	screenshot?: string;
	log: (line: string) => void;
	/** For tests: how long to wait between tries. */
	wait?: (ms: number) => Promise<unknown>;
};
export type PushResult = {
	mockupId: string;
	version: number;
	url: string;
	notes: boolean;
	screenshot: boolean;
};

// -- CONSTANTS -- //

/** The server's own cap for one version (50 MB). The server checks it again, this only stops a hopeless upload early. */
export const MAX_MOCKUP_BYTES = 50 * 1024 * 1024;
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const TRIES = 3;

// -- FUNCTIONS -- //

/** The message of a failed call: the server's own words when it sent them. */
async function failure(res: Response): Promise<string> {
	try {
		const j = (await res.json()) as { error?: { message?: string } };
		if (j.error?.message) return `${j.error.message} (${res.status})`;
	} catch {
		/* Not JSON */
	}
	return `The server answered ${res.status}.`;
}

/** Only a plain HTML or PNG file of a sane size is read: never a link, a folder or some other file an agent was talked into naming. */
function readFileChecked(path: string, kinds: string[], max: number, what: string): Uint8Array {
	const st = lstatSync(path, { throwIfNoEntry: false });
	if (!st) throw new Error(`The ${what} file ${path} does not exist.`);
	if (!st.isFile()) throw new Error(`The ${what} path ${path} is not a plain file.`);
	if (!kinds.includes(extname(path).toLowerCase()))
		throw new Error(`The ${what} must be a ${kinds.join(' or ')} file.`);
	if (st.size === 0) throw new Error(`The ${what} file is empty.`);
	if (st.size > max)
		throw new Error(
			`The ${what} is ${Math.ceil(st.size / 1024 / 1024)} MB, more than the ${Math.floor(max / 1024 / 1024)} MB limit.`
		);
	return new Uint8Array(readFileSync(path));
}

/** One call, tried again on a network failure or a 5xx with the same request id, so a repeat can never publish twice. */
async function call(
	o: PushOptions,
	method: string,
	path: string,
	body: BodyInit | undefined,
	headers: Record<string, string>,
	requestId: string
): Promise<Response> {
	let last = 'The server could not be reached.';
	for (let i = 0; i < TRIES; i++) {
		try {
			const res = await o.fetch(`${o.server}/api/v1${path}`, {
				method,
				body,
				headers: {
					authorization: `Bearer ${o.token}`,
					'idempotency-key': requestId,
					...headers
				}
			});
			if (res.status < 500) return res;
			last = await failure(res);
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
		}
		if (i < TRIES - 1)
			await (o.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(500 * (i + 1));
	}
	throw new Error(last);
}

export async function pushMockup(o: PushOptions): Promise<PushResult> {
	if (!o.token)
		throw new Error('Not signed in. Run: agent-flow-board login --server <url> --org <slug>');
	if (!o.item && !o.project && !o.mockup)
		throw new Error('Name the plan (--item), a project (--project) or the mockup (--mockup).');
	const html = readFileChecked(o.file, ['.html', '.htm'], MAX_MOCKUP_BYTES, 'mockup');
	const shot = o.screenshot
		? readFileChecked(o.screenshot, ['.png'], MAX_SCREENSHOT_BYTES, 'screenshot')
		: null;
	const id = randomBytes(8).toString('hex');
	const base = `/orgs/${encodeURIComponent(o.org)}`;
	const q = new URLSearchParams();
	for (const [k, v] of [
		['item', o.item],
		['project', o.project],
		['mockup', o.mockup],
		['title', o.title]
	] as const)
		if (v) q.set(k, v);
	if (o.another) q.set('another', 'true');
	const res = await call(
		o,
		'POST',
		`${base}/mockups?${q}`,
		html as BodyInit,
		{ 'content-type': 'text/html' },
		`mockup-push-${id}`
	);
	if (!res.ok) throw new Error(await failure(res));
	const made = (await res.json()) as {
		mockup: { id: string };
		version: { number: number };
		projectKey: string;
	};
	const at = `${base}/mockups/${made.mockup.id}/versions/${made.version.number}`;
	let notes = false;
	if (o.keepNotes || o.freeNotes) {
		const n = await call(
			o,
			'PUT',
			`${at}/notes`,
			JSON.stringify({ keepNotes: o.keepNotes ?? '', freeNotes: o.freeNotes ?? '' }),
			{ 'content-type': 'application/json' },
			`mockup-notes-${id}`
		);
		if (!n.ok) o.log(`The mockup is published, but its notes were not saved: ${await failure(n)}`);
		else notes = true;
	}
	let screenshot = false;
	if (shot) {
		const s = await call(
			o,
			'PUT',
			`${at}/screenshot`,
			shot as BodyInit,
			{ 'content-type': 'image/png' },
			`mockup-shot-${id}`
		);
		if (!s.ok)
			o.log(`The mockup is published, but its screenshot was not saved: ${await failure(s)}`);
		else screenshot = true;
	}
	return {
		mockupId: made.mockup.id,
		version: made.version.number,
		url: `${o.server}/${o.org}/${made.projectKey}/mockups/${made.mockup.id}`,
		notes,
		screenshot
	};
}
