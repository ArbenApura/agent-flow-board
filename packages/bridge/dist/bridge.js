// THE BRIDGE CORE (ADR-030): READS JSON-RPC LINES FROM A TOOL'S STDIN, FORWARDS EACH TO THE SERVER'S /mcp, WRITES THE REPLIES TO STDOUT.
// It holds no tool code, schemas or workflow text, so a server update never needs a reconnect. It only adds three things:
// sign in by device code, an offline queue for writes, and a protocol version check on start.
// -- DEP-MODULES -- //
import { createInterface } from 'node:readline';
// -- CONSTANTS -- //
export const BRIDGE_PROTOCOL_MAX = 1;
// -- FUNCTIONS -- //
const isNetworkError = (e) => e instanceof TypeError ||
    e?.code === 'ECONNREFUSED' ||
    /fetch failed|network|ENOTFOUND|ECONN/i.test(String(e?.message));
/** Runs until stdin closes. */
export async function runBridge(o) {
    let token = o.getToken() ?? (await o.login());
    const protocolMax = o.protocolMax ?? BRIDGE_PROTOCOL_MAX;
    let warnedProtocol = false;
    /** Tool names known to only read, from the server's own annotations. Anything else is treated as a write. */
    let readOnly = new Set();
    let toolsKnown = false;
    const write = (msg) => o.stdout.write(JSON.stringify(msg) + '\n');
    const post = async (body) => {
        const send = () => o.fetch(`${o.server}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: `Bearer ${token}`
            },
            body: JSON.stringify(body)
        });
        let res = await send();
        if (res.status === 401) {
            // The token expired or was revoked: sign in again once and retry
            o.log('The saved sign in is no longer valid. Signing in again.');
            token = await o.login();
            res = await send();
        }
        return res;
    };
    const parse = async (res) => {
        const text = await res.text();
        if (!text.trim())
            return null;
        if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
            const line = text.split('\n').find((l) => l.startsWith('data:'));
            return line ? JSON.parse(line.slice(5)) : null;
        }
        return JSON.parse(text);
    };
    const checkProtocol = (res) => {
        const v = Number(res.headers.get('x-afb-protocol') ?? 0);
        if (v > protocolMax && !warnedProtocol) {
            warnedProtocol = true;
            o.log(`This server speaks protocol ${v} and the bridge understands up to ${protocolMax}. Update it with: npx -y @agent-flow-board/bridge@latest`);
        }
    };
    /** Sends one queued write as a real tools/call and says whether the board took it. */
    const sendQueued = async (e) => {
        try {
            const res = await post({
                jsonrpc: '2.0',
                id: `replay-${Date.now()}`,
                method: 'tools/call',
                params: { name: e.name, arguments: e.args }
            });
            const body = await parse(res);
            const result = body?.result;
            if (res.status >= 500)
                return { kind: 'offline' };
            if (!res.ok || body?.error || result?.isError)
                return {
                    kind: 'refused',
                    reason: result?.structuredContent?.error?.message ?? `The board answered ${res.status}.`
                };
            return { kind: 'ok' };
        }
        catch (err) {
            if (isNetworkError(err))
                return { kind: 'offline' };
            return { kind: 'refused', reason: String(err.message) };
        }
    };
    const replay = async () => {
        if (o.queue.list().length === 0)
            return;
        const r = await o.queue.replay(sendQueued);
        if (r.sent || r.held)
            o.log(`Replayed ${r.sent} queued write${r.sent === 1 ? '' : 's'}${r.held ? `, ${r.held} held back (see: agent-flow-board queue list)` : ''}.`);
    };
    async function handle(msg) {
        try {
            const res = await post(msg);
            checkProtocol(res);
            const body = await parse(res);
            if (msg.id === undefined)
                return;
            if (body) {
                if (msg.method === 'tools/list') {
                    const tools = body.result?.tools;
                    if (tools) {
                        readOnly = new Set(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name));
                        toolsKnown = true;
                    }
                }
                write(body);
                void replay();
            }
            else
                write({
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32603, message: `The board answered ${res.status} with no body.` }
                });
        }
        catch (err) {
            if (msg.id === undefined)
                return;
            if (!isNetworkError(err)) {
                write({
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32603, message: String(err.message) }
                });
                return;
            }
            // The board cannot be reached. Reads say so, writes are queued and say they are queued.
            const name = msg.params?.name;
            if (msg.method === 'tools/call' && name && toolsKnown && !readOnly.has(name)) {
                const q = o.queue.enqueue(name, msg.params?.arguments ?? {});
                const out = {
                    queued: true,
                    queueId: q.id,
                    message: 'The board cannot be reached. This write was saved on this computer and will be sent when it is back, in order. Nothing was recorded yet.'
                };
                write({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out }
                });
            }
            else {
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
    let chain = Promise.resolve();
    rl.on('line', (line) => {
        if (!line.trim())
            return;
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
        }
        // One message at a time keeps the order of writes exactly as the tool sent them
        chain = chain.then(() => handle(msg));
    });
    const timer = o.replayEveryMs === 0 ? null : setInterval(() => void replay(), o.replayEveryMs ?? 15_000);
    await new Promise((resolve) => rl.on('close', resolve));
    await chain;
    if (timer)
        clearInterval(timer);
}
