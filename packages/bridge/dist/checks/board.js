// THE BOARD, SEEN FROM THE CHECK COMMANDS: THE RUNNER API WITH THE TOOL'S OWN RUNNER TOKEN
// A runner token is not a personal token. It can take a queued run, beat for it, upload evidence and report a result, and nothing else.
// -- MODULES -- //
import { TOOL_PROTOCOL } from './paths.js';
// -- CONSTANTS -- //
/** One call to the board may take this long, uploads included. A half open connection must not hang the run for ever. */
export const CALL_TIMEOUT_MS = 120_000;
/** Asking for a run waits a short while only. */
export const CLAIM_TIMEOUT_MS = 20_000;
/** Raised when the board refuses a call. Carries the board's own words, code and optional details. */
export class BoardError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
        this.name = 'BoardError';
    }
}
// -- FUNCTIONS -- //
/** The calls of the runner API, as the check commands make them. */
export class RunnerBoard {
    server;
    token;
    doFetch;
    extraHeaders;
    constructor(server, token, doFetch = (input, init) => fetch(input, init), 
    /** Extra headers sent with every call: the audit head and the slots, built by the caller, never required. */
    extraHeaders = () => ({})) {
        this.server = server;
        this.token = token;
        this.doFetch = doFetch;
        this.extraHeaders = extraHeaders;
    }
    async call(method, path, body, type, timeoutMs = CALL_TIMEOUT_MS) {
        let res;
        let text;
        try {
            res = await this.doFetch(`${this.server.replace(/\/$/, '')}/api/v1/runner${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${this.token}`,
                    'x-afb-tool-protocol': String(TOOL_PROTOCOL),
                    ...this.extraHeaders(),
                    ...(type ? { 'content-type': type } : {})
                },
                body: body,
                signal: AbortSignal.timeout(timeoutMs)
            });
            text = await res.text();
        }
        catch (e) {
            const name = e?.name;
            if (name === 'TimeoutError' || name === 'AbortError')
                throw new BoardError(0, 'TIMEOUT', `The board did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
            throw e;
        }
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        }
        catch {
            /* Not JSON */
        }
        if (!res.ok) {
            const err = json?.error;
            if (res.status === 401)
                throw new BoardError(401, 'UNAUTHENTICATED', 'The board no longer accepts this machine for checks. Run: agent-flow-board check connect --server <url> --org <slug> --json');
            throw new BoardError(res.status, err?.code ?? 'ERROR', err?.message ?? `The board answered ${res.status}.`, err?.details);
        }
        return json;
    }
    /** Takes the run with this id, and no other. Null when it is not queued for this runner. */
    async claim(runId) {
        const out = await this.call('POST', '/claim', JSON.stringify({ runId }), 'application/json', CLAIM_TIMEOUT_MS);
        return out.job;
    }
    /** Takes the oldest queued run this runner may take, for `check watch`. */
    async claimNext() {
        const out = await this.call('POST', '/claim', undefined, undefined, CLAIM_TIMEOUT_MS);
        return out.job;
    }
    /** How many runs wait for this runner. Nothing is taken. */
    async peek() {
        return (await this.call('POST', '/peek')).waiting;
    }
    /** Says the process is alive and still on this run. A conflict means the board gave up on it. */
    beat(runId) {
        return this.call('POST', `/runs/${encodeURIComponent(runId)}/beat`);
    }
    /** Gives back the named runs only, never the runs of another process of the same runner. */
    async release(runIds) {
        if (!runIds.length)
            return 0;
        return (await this.call('POST', '/release', JSON.stringify({ runIds }), 'application/json')).released;
    }
    /** Stores a file of a run as evidence and returns its attachment id. */
    async upload(runId, file) {
        let q = `filename=${encodeURIComponent(file.filename)}&caption=${encodeURIComponent(file.caption)}`;
        if (file.signedIn !== undefined)
            q += `&signedIn=${file.signedIn ? '1' : '0'}`;
        if (file.uploadSignedInPictures !== undefined)
            q += `&uploadSignedInPictures=${file.uploadSignedInPictures ? '1' : '0'}`;
        const out = await this.call('POST', `/runs/${encodeURIComponent(runId)}/artifacts?${q}`, file.bytes, 'application/octet-stream');
        return out.attachmentId;
    }
    // -- OWNER APPROVALS ASKED ON THE BOARD -- //
    /** Files a request (one entry, or up to 20 as one batch). The board normalises each target and returns the rows and the page link. */
    requestApprovals(input) {
        return this.call('POST', '/approvals', JSON.stringify(input), 'application/json');
    }
    /** The state of requests of this machine. */
    async pollApprovals(ids) {
        return (await this.call('POST', '/approvals/poll', JSON.stringify({ ids }), 'application/json')).requests;
    }
    /** Withdraws waiting requests, so no card stays for an agent that gave up. */
    cancelApprovals(ids) {
        return this.call('POST', '/approvals/cancel', JSON.stringify({ ids }), 'application/json');
    }
    /** Claims approved decisions, once: the board answers only the rows that were approved, unexpired and not claimed. */
    async claimApprovals(ids) {
        return (await this.call('POST', '/approvals/claim', JSON.stringify({ ids }), 'application/json')).claimed;
    }
    // -- TEST ACCOUNT SIGN INS TYPED ON THE BOARD -- //
    /** Publishes this machine's public sign in key (only this runner token may). */
    publishSigninKey(input) {
        return this.call('POST', '/signins/key', JSON.stringify(input), 'application/json');
    }
    /** Leases the waiting ciphertext of one registration for two minutes. */
    leaseSignins(registration) {
        return this.call('POST', '/signins/lease', JSON.stringify({ registration }), 'application/json');
    }
    /** Says the attempt is over; the board keeps pass or fail only and wipes the ciphertext. */
    ackSignin(input) {
        return this.call('POST', '/signins/ack', JSON.stringify(input), 'application/json');
    }
    finish(runId, report) {
        return this.call('POST', `/runs/${encodeURIComponent(runId)}/finish`, JSON.stringify(report), 'application/json');
    }
    /** Mints a short-lived signed mockup URL via the runner token for a project this runner serves. */
    mintMockupUrl(mockupId, opts = {}) {
        return this.call('POST', `/mockups/${encodeURIComponent(mockupId)}/url`, JSON.stringify(opts), 'application/json');
    }
}
