// THE BRIDGE CORE (ADR-030): READS JSON-RPC LINES FROM A TOOL'S STDIN, FORWARDS EACH TO THE SERVER'S /mcp, WRITES THE REPLIES TO STDOUT.
// It holds no tool code, schemas or workflow text, so a server update never needs a reconnect. It only adds three things:
// sign in by device code, an offline queue for writes, and a protocol version check on start.

// IMPORTED TYPES
import type { Readable, Writable } from 'node:stream';
import type { Fetch } from './device.js';
import type { Queue, SendResult } from './queue.js';
// IMPORTED DEP-MODULES
import { createInterface } from 'node:readline';

// -- TYPES -- //

export type BridgeOptions = {
	server: string;
	/** The organisation slug: the bridge then talks to /mcp/<slug> instead of the plain /mcp. */
	org?: string;
	fetch: Fetch;
	/** The stored token, or null when none is saved. */
	getToken(): string | null;
	/** Signs in again (device code) and returns the new token. Called on first use and on a 401. */
	login(): Promise<string>;
	queue: Queue;
	stdin: Readable;
	stdout: Writable;
	log(line: string): void;
	/** The newest server protocol this bridge understands. */
	protocolMax?: number;
	/** How often to try replaying the queue while idle, in ms. 0 turns the timer off (tests). */
	replayEveryMs?: number;
	/** How long one request to the board may take before the bridge gives up on it, in ms. */
	postTimeoutMs?: number;
};
type Rpc = {
	jsonrpc: '2.0';
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: unknown;
};

// -- CONSTANTS -- //

export const BRIDGE_PROTOCOL_MAX = 2;
/** The longest one request may take. A tool call can wait up to 50 seconds for a run, so this sits above that. */
export const POST_TIMEOUT_MS = 90_000;
const NETWORK_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ENOTFOUND',
	'EAI_AGAIN',
	'ETIMEDOUT',
	'ENETUNREACH',
	'EHOSTUNREACH',
	'EPIPE',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_SOCKET'
]);

// -- FUNCTIONS -- //

/** A request that timed out: the board may or may not have taken it, so it is never treated as offline. */
const isTimeout = (e: unknown) =>
	(e as { name?: string } | null)?.name === 'TimeoutError' ||
	(e as { name?: string } | null)?.name === 'AbortError';

/** Only a real failure to reach the board counts. Any other TypeError is a bug and must be shown, not hidden as offline. */
export const isNetworkError = (e: unknown) => {
	if (!e || typeof e !== 'object') return false;
	const err = e as { code?: string; cause?: { code?: string }; message?: string };
	if (err.code && NETWORK_CODES.has(err.code)) return true;
	if (err.cause?.code && NETWORK_CODES.has(err.cause.code)) return true;
	// Node's fetch reports a failed connection as a TypeError whose message is exactly this
	return (
		e instanceof TypeError &&
		/^(fetch failed|failed to fetch|network request failed)/i.test(String(err.message))
	);
};

/** The board refused the saved sign in. The person has to sign in again, which the bridge starts in the background. */
class SignInNeeded extends Error {}

/** Runs until stdin closes. */
export async function runBridge(o: BridgeOptions): Promise<void> {
	let token: string | null = o.getToken();
	const postTimeout = o.postTimeoutMs ?? POST_TIMEOUT_MS;
	let loginRunning: Promise<void> | null = null;
	/** Starts the device code sign in once. It runs in the background, so no call waits for the person to type a code. */
	const startLogin = () => {
		if (loginRunning) return;
		loginRunning = o
			.login()
			.then((t) => {
				token = t;
			})
			.catch((err) => o.log(`Sign in failed: ${String((err as Error)?.message ?? err)}`))
			.finally(() => {
				loginRunning = null;
			});
	};
	if (!token) {
		o.log('No saved sign in. Starting the sign in.');
		startLogin();
	}
	const protocolMax = o.protocolMax ?? BRIDGE_PROTOCOL_MAX;
	let warnedProtocol = false;
	/** Tool names known to only read, from the server's own annotations. Anything else is treated as a write. */
	let readOnly = new Set<string>();
	let toolsKnown = false;

	const write = (msg: Rpc) => o.stdout.write(JSON.stringify(msg) + '\n');
	const post = async (body: unknown): Promise<Response> => {
		const send = () =>
			o.fetch(`${o.server}/mcp${o.org ? `/${o.org}` : ''}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					authorization: `Bearer ${token}`
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(postTimeout)
			});
		if (!token) throw new SignInNeeded();
		const res = await send();
		if (res.status === 401) {
			// The token expired or was revoked. The sign in starts in the background and this call says so, instead of waiting for it
			o.log('The saved sign in is no longer valid. Starting the sign in.');
			token = null;
			startLogin();
			throw new SignInNeeded();
		}
		return res;
	};
	const parse = async (res: Response): Promise<Rpc | null> => {
		const text = await res.text();
		if (!text.trim()) return null;
		if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
			const line = text.split('\n').find((l) => l.startsWith('data:'));
			return line ? (JSON.parse(line.slice(5)) as Rpc) : null;
		}
		return JSON.parse(text) as Rpc;
	};
	const checkProtocol = (res: Response) => {
		const v = Number(res.headers.get('x-afb-protocol') ?? 0);
		if (v > protocolMax && !warnedProtocol) {
			warnedProtocol = true;
			o.log(
				`This server speaks protocol ${v} and the bridge understands up to ${protocolMax}. Update it with: npx -y @agent-flow-board/bridge@latest`
			);
		}
	};

	/** Sends one queued write as a real tools/call and says whether the board took it. */
	const sendQueued = async (e: {
		name: string;
		args: Record<string, unknown>;
	}): Promise<SendResult> => {
		try {
			const res = await post({
				jsonrpc: '2.0',
				id: `replay-${Date.now()}`,
				method: 'tools/call',
				params: { name: e.name, arguments: e.args }
			});
			const body = await parse(res);
			const result = body?.result as
				{ isError?: boolean; structuredContent?: { error?: { message?: string } } } | undefined;
			if (res.status >= 500) return { kind: 'offline' };
			if (!res.ok || body?.error || result?.isError)
				return {
					kind: 'refused',
					reason: result?.structuredContent?.error?.message ?? `The board answered ${res.status}.`
				};
			return { kind: 'ok' };
		} catch (err) {
			if (err instanceof SignInNeeded || isTimeout(err) || isNetworkError(err))
				return { kind: 'offline' };
			return { kind: 'refused', reason: String((err as Error).message) };
		}
	};
	const replay = async () => {
		if (o.queue.list().length === 0) return;
		const r = await o.queue.replay(sendQueued);
		if (r.sent || r.held)
			o.log(
				`Replayed ${r.sent} queued write${r.sent === 1 ? '' : 's'}${r.held ? `, ${r.held} held back (see: agent-flow-board queue list)` : ''}.`
			);
	};

	async function handle(msg: Rpc) {
		try {
			const res = await post(msg);
			checkProtocol(res);
			const body = await parse(res);
			if (msg.id === undefined) return;
			if (body) {
				if (msg.method === 'tools/list') {
					const tools = (
						body.result as
							{ tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[] } | undefined
					)?.tools;
					if (tools) {
						readOnly = new Set(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name));
						toolsKnown = true;
					}
				}
				// An answer that failed before the server read the request (a refusal such as FORBIDDEN) carries no id: it answers this one
				write(body.error && body.id == null ? { ...body, id: msg.id } : body);
				void replay();
			} else
				write({
					jsonrpc: '2.0',
					id: msg.id,
					error: { code: -32603, message: `The board answered ${res.status} with no body.` }
				});
		} catch (err) {
			if (msg.id === undefined) return;
			if (err instanceof SignInNeeded) {
				const text =
					'The board did not accept the saved sign in. A sign in was started: open the address printed by the agent-flow-board bridge (or run "agent-flow-board login" in a terminal), type the code, then try again.';
				if (msg.method === 'tools/call')
					write({
						jsonrpc: '2.0',
						id: msg.id,
						result: {
							isError: true,
							content: [{ type: 'text', text }],
							structuredContent: { error: { code: 'SIGN_IN_NEEDED', message: text } }
						}
					});
				else write({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: text } });
				return;
			}
			if (isTimeout(err)) {
				write({
					jsonrpc: '2.0',
					id: msg.id,
					error: {
						code: -32000,
						message: `The board did not answer within ${Math.round(postTimeout / 1000)} seconds. The request may or may not have been applied: read the item before sending it again.`
					}
				});
				return;
			}
			if (!isNetworkError(err)) {
				write({
					jsonrpc: '2.0',
					id: msg.id,
					error: { code: -32603, message: String((err as Error).message) }
				});
				return;
			}
			// The board cannot be reached. Reads say so, writes are queued and say they are queued.
			const name = msg.params?.name as string | undefined;
			if (msg.method === 'tools/call' && name && toolsKnown && !readOnly.has(name)) {
				const q = o.queue.enqueue(name, (msg.params?.arguments as Record<string, unknown>) ?? {});
				const out = {
					queued: true,
					queueId: q.id,
					message:
						'The board cannot be reached. This write was saved on this computer and will be sent when it is back, in order. Nothing was recorded yet.'
				};
				write({
					jsonrpc: '2.0',
					id: msg.id,
					result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out }
				});
			} else {
				write({
					jsonrpc: '2.0',
					id: msg.id,
					error: {
						code: -32000,
						message: 'offline: the board cannot be reached, so this cannot be read right now.'
					}
				});
			}
		}
	}

	const rl = createInterface({ input: o.stdin });
	let chain: Promise<void> = Promise.resolve();
	rl.on('line', (line) => {
		if (!line.trim()) return;
		let msg: Rpc;
		try {
			msg = JSON.parse(line) as Rpc;
		} catch {
			write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
			return;
		}
		// One message at a time keeps the order of writes exactly as the tool sent them
		chain = chain.then(() => handle(msg));
	});
	const timer =
		o.replayEveryMs === 0 ? null : setInterval(() => void replay(), o.replayEveryMs ?? 15_000);
	await new Promise<void>((resolve) => rl.on('close', resolve));
	await chain;
	if (timer) clearInterval(timer);
}
