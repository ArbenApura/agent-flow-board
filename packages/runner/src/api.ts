// THE RUNNER'S VIEW OF THE SERVER: THE FEW CALLS IT MAKES WITH ITS OWN TOKEN (SPEC 10)

// IMPORTED TYPES
import type { CheckJob } from '../../../src/lib/server/ops/checks';

export type Job = CheckJob;
export type Account = { email: string; password: string };
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// -- CONSTANTS -- //

/** How long one call may take before it is given up, in ms. A half open connection would otherwise hang the loop for good. */
export const CALL_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

// -- FUNCTIONS -- //

/** The wait before the next try after `failures` calls in a row failed: 5 s, doubling, at most 60 s. */
export const retryDelay = (failures: number) =>
	Math.min(60_000, 5000 * 2 ** Math.max(0, failures - 1));

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'ApiError';
	}
}

/** The calls of the runner API. A refusal becomes an ApiError that carries the server's own words. */
export class RunnerApi {
	constructor(
		private readonly server: string,
		private readonly token: string,
		private readonly doFetch: Fetch = fetch
	) {}

	private async call<T>(
		method: string,
		path: string,
		body?: BodyInit,
		type?: string,
		timeoutMs = CALL_TIMEOUT_MS
	): Promise<T> {
		// One signal covers the answer and the reading of its body
		const signal = AbortSignal.timeout(timeoutMs);
		let text: string;
		let res: Response;
		try {
			res = await this.doFetch(`${this.server.replace(/\/$/, '')}/api/v1/runner${path}`, {
				method,
				headers: {
					authorization: `Bearer ${this.token}`,
					...(type ? { 'content-type': type } : {})
				},
				body,
				signal
			});
			text = await res.text();
		} catch (e) {
			const name = (e as { name?: string } | null)?.name;
			if (name === 'TimeoutError' || name === 'AbortError')
				throw new ApiError(
					0,
					'TIMEOUT',
					`The server did not answer ${method} ${path.split('?')[0]} within ${Math.round(timeoutMs / 1000)} seconds.`
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
			const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
			throw new ApiError(
				res.status,
				e?.code ?? 'ERROR',
				e?.message ?? `The server answered ${res.status}.`
			);
		}
		return json as T;
	}

	/** The next queued run this runner may take, or null. */
	async claim(): Promise<Job | null> {
		return (await this.claimWithKey()).job;
	}

	/** Like claim, with the key of that one run, for a supervisor that hands the run to a throwaway container. */
	async claimWithKey(): Promise<{ job: Job | null; runKey: string | null }> {
		const out = await this.call<{ job: Job | null; runKey?: string | null }>('POST', '/claim');
		return { job: out.job, runKey: out.runKey ?? null };
	}

	/** How many runs wait for this runner. Nothing is taken. */
	async peek(): Promise<number> {
		return (await this.call<{ waiting: number }>('POST', '/peek')).waiting;
	}

	/** Gives back the runs this runner holds, for a restart. */
	async release(): Promise<number> {
		return (await this.call<{ released: number }>('POST', '/release')).released;
	}

	/** The test accounts of the run's project, opened for this run only. */
	async accounts(kind: 'runs', id: string): Promise<Record<string, Account>> {
		return (
			await this.call<{ accounts: Record<string, Account> }>('GET', `/${kind}/${id}/accounts`)
		).accounts;
	}

	/** Stores a file of a run. Check run files are stored as artifacts. */
	async upload(
		kind: 'runs',
		id: string,
		file: { filename: string; caption: string; bytes: Uint8Array }
	): Promise<string> {
		const q = `filename=${encodeURIComponent(file.filename)}&caption=${encodeURIComponent(file.caption)}`;
		const out = await this.call<{ attachmentId: string }>(
			'POST',
			`/${kind}/${id}/artifacts?${q}`,
			file.bytes as unknown as BodyInit,
			'application/octet-stream',
			UPLOAD_TIMEOUT_MS
		);
		return out.attachmentId;
	}

	async finish<T = unknown>(kind: 'runs', id: string, report: unknown): Promise<T> {
		return this.call<T>(
			'POST',
			`/${kind}/${id}/finish`,
			JSON.stringify(report),
			'application/json'
		);
	}
}
