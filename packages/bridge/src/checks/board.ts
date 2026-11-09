// THE BOARD, SEEN FROM THE CHECK COMMANDS: THE RUNNER API WITH THE TOOL'S OWN RUNNER TOKEN
// A runner token is not a personal token. It can take a queued run, beat for it, upload evidence and report a result, and nothing else.

// -- TYPES -- //
import type { Fetch } from '../device.js';

export type CheckJob = {
	kind: 'check';
	id: string;
	project: { id: string; key: string };
	item: { id: string; ref: string };
	check: { key: string; script: string | null; coveredPaths: string[]; requiredTarget: string };
	target: string;
	environment: {
		name: string;
		url: string;
		kind: string;
		production: boolean;
		writeAllowed: boolean;
	};
	readOnly: boolean;
	accounts: string[];
	stepKey: string | null;
	registration: string | null;
};

export type RunReport = {
	result: 'pass' | 'fail' | 'error';
	reason?: string;
	durationMs?: number;
	url?: string;
	commit?: string | null;
	diffHash?: string | null;
	unverified?: boolean;
	log?: string;
	evidence?: string[];
	/** The registration that ran (the bare NAME the board knows), the folder name and the branch. The board refuses a pass from a registration it did not ask for. */
	registration?: string;
	repoName?: string;
	branch?: string;
};

export type ApprovalState = {
	id: string;
	batchId: string | null;
	action: string;
	target: string;
	status: 'pending' | 'approved' | 'refused' | 'expired' | 'cancelled' | 'claimed';
	expiresAt: string;
};
export type ApprovalRequested = {
	batchId: string | null;
	requests: ApprovalState[];
	link: string | null;
};
export type ClaimedFromBoard = {
	id: string;
	action: string;
	target: string;
	decidedBy: string;
	decidedAt: string;
};

// -- MODULES -- //
import { TOOL_PROTOCOL } from './paths.js';

// -- CONSTANTS -- //

/** One call to the board may take this long, uploads included. A half open connection must not hang the run for ever. */
export const CALL_TIMEOUT_MS = 120_000;
/** Asking for a run waits a short while only. */
export const CLAIM_TIMEOUT_MS = 20_000;

/** Raised when the board refuses a call. Carries the board's own words and code. */
export class BoardError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'BoardError';
	}
}

// -- FUNCTIONS -- //

/** The calls of the runner API, as the check commands make them. */
export class RunnerBoard {
	constructor(
		private readonly server: string,
		private readonly token: string,
		private readonly doFetch: Fetch = (input, init) => fetch(input, init),
		/** Extra headers sent with every call: the audit head and the slots, built by the caller, never required. */
		private readonly extraHeaders: () => Record<string, string> = () => ({})
	) {}

	private async call<T>(
		method: string,
		path: string,
		body?: string | Uint8Array,
		type?: string,
		timeoutMs = CALL_TIMEOUT_MS
	): Promise<T> {
		let res: Response;
		let text: string;
		try {
			res = await this.doFetch(`${this.server.replace(/\/$/, '')}/api/v1/runner${path}`, {
				method,
				headers: {
					authorization: `Bearer ${this.token}`,
					'x-afb-tool-protocol': String(TOOL_PROTOCOL),
					...this.extraHeaders(),
					...(type ? { 'content-type': type } : {})
				},
				body: body as BodyInit | undefined,
				signal: AbortSignal.timeout(timeoutMs)
			});
			text = await res.text();
		} catch (e) {
			const name = (e as { name?: string } | null)?.name;
			if (name === 'TimeoutError' || name === 'AbortError')
				throw new BoardError(
					0,
					'TIMEOUT',
					`The board did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
				);
			throw e;
		}
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			/* Not JSON */
		}
		if (!res.ok) {
			const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
			if (res.status === 401)
				throw new BoardError(
					401,
					'UNAUTHENTICATED',
					'The board no longer accepts this machine for checks. Run: agent-flow-board check connect --server <url> --org <slug> --json'
				);
			throw new BoardError(
				res.status,
				err?.code ?? 'ERROR',
				err?.message ?? `The board answered ${res.status}.`
			);
		}
		return json as T;
	}

	/** Takes the run with this id, and no other. Null when it is not queued for this runner. */
	async claim(runId: string): Promise<CheckJob | null> {
		const out = await this.call<{ job: CheckJob | null }>(
			'POST',
			'/claim',
			JSON.stringify({ runId }),
			'application/json',
			CLAIM_TIMEOUT_MS
		);
		return out.job;
	}

	/** Takes the oldest queued run this runner may take, for `check watch`. */
	async claimNext(): Promise<CheckJob | null> {
		const out = await this.call<{ job: CheckJob | null }>(
			'POST',
			'/claim',
			undefined,
			undefined,
			CLAIM_TIMEOUT_MS
		);
		return out.job;
	}

	/** How many runs wait for this runner. Nothing is taken. */
	async peek(): Promise<number> {
		return (await this.call<{ waiting: number }>('POST', '/peek')).waiting;
	}

	/** Says the process is alive and still on this run. A conflict means the board gave up on it. */
	beat(runId: string) {
		return this.call<{ ok: boolean }>('POST', `/runs/${encodeURIComponent(runId)}/beat`);
	}

	/** Gives back the named runs only, never the runs of another process of the same runner. */
	async release(runIds: string[]): Promise<number> {
		if (!runIds.length) return 0;
		return (
			await this.call<{ released: number }>(
				'POST',
				'/release',
				JSON.stringify({ runIds }),
				'application/json'
			)
		).released;
	}

	/** Stores a file of a run as evidence and returns its attachment id. */
	async upload(
		runId: string,
		file: { filename: string; caption: string; bytes: Uint8Array }
	): Promise<string> {
		const q = `filename=${encodeURIComponent(file.filename)}&caption=${encodeURIComponent(file.caption)}`;
		const out = await this.call<{ attachmentId: string }>(
			'POST',
			`/runs/${encodeURIComponent(runId)}/artifacts?${q}`,
			file.bytes,
			'application/octet-stream'
		);
		return out.attachmentId;
	}

	// -- OWNER APPROVALS ASKED ON THE BOARD -- //

	/** Files a request (one entry, or up to 20 as one batch). The board normalises each target and returns the rows and the page link. */
	requestApprovals(input: {
		requestId: string;
		entries: { action: string; target: string }[];
		why?: string;
		project?: string;
	}) {
		return this.call<ApprovalRequested>(
			'POST',
			'/approvals',
			JSON.stringify(input),
			'application/json'
		);
	}

	/** The state of requests of this machine. */
	async pollApprovals(ids: string[]): Promise<ApprovalState[]> {
		return (
			await this.call<{ requests: ApprovalState[] }>(
				'POST',
				'/approvals/poll',
				JSON.stringify({ ids }),
				'application/json'
			)
		).requests;
	}

	/** Withdraws waiting requests, so no card stays for an agent that gave up. */
	cancelApprovals(ids: string[]) {
		return this.call<{ cancelled: number }>(
			'POST',
			'/approvals/cancel',
			JSON.stringify({ ids }),
			'application/json'
		);
	}

	/** Claims approved decisions, once: the board answers only the rows that were approved, unexpired and not claimed. */
	async claimApprovals(ids: string[]): Promise<ClaimedFromBoard[]> {
		return (
			await this.call<{ claimed: ClaimedFromBoard[] }>(
				'POST',
				'/approvals/claim',
				JSON.stringify({ ids }),
				'application/json'
			)
		).claimed;
	}

	// -- TEST ACCOUNT SIGN INS TYPED ON THE BOARD -- //

	/** Publishes this machine's public sign in key (only this runner token may). */
	publishSigninKey(input: { keyId: string; publicKey: string }) {
		return this.call<{ changed: boolean; fingerprint: string }>(
			'POST',
			'/signins/key',
			JSON.stringify(input),
			'application/json'
		);
	}

	/** Leases the waiting ciphertext of one registration for two minutes. */
	leaseSignins(registration: string) {
		return this.call<{
			orgId: string;
			runnerId: string;
			signins: {
				id: string;
				registration: string;
				keyId: string;
				alg: string;
				ciphertext: string;
			}[];
		}>('POST', '/signins/lease', JSON.stringify({ registration }), 'application/json');
	}

	/** Says the attempt is over; the board keeps pass or fail only and wipes the ciphertext. */
	ackSignin(input: { id: string; result: 'pass' | 'fail' }) {
		return this.call<{ acknowledged: number }>(
			'POST',
			'/signins/ack',
			JSON.stringify(input),
			'application/json'
		);
	}

	finish(runId: string, report: RunReport) {
		return this.call<unknown>(
			'POST',
			`/runs/${encodeURIComponent(runId)}/finish`,
			JSON.stringify(report),
			'application/json'
		);
	}
}
