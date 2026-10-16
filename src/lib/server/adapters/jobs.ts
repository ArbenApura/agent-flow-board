// BACKGROUND JOBS (5.13). EVERY JOB CARRIES ITS ORG AND PROJECT IDS, AND ITS HANDLER CAN QUERY ONLY THROUGH THE TENANT CONTEXT
// The handler is never given a database handle. It gets `tenant(fn)`, which sets the tenant before the first query (L5).
// Adapters: memory (PGlite, local and tests), pg-boss (a real PostgreSQL server), Cloudflare Queues (Workers).

// -- TYPES -- //
import type { DbHandle, Tx } from '../db/client';
// -- DEP-MODULES -- //
import { randomUUID } from 'node:crypto';
// -- MODULES -- //
import { withTenant } from '../db/tenant';

// -- TYPES -- //

export type JobPayload = { orgId: string; projectId?: string } & Record<string, unknown>;
export type JobContext = {
	payload: JobPayload;
	/** Runs queries inside this job's own org (and project). The only way a job reaches the database. */
	tenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};
export type JobHandler = (job: JobContext) => Promise<void>;
export interface JobRunner {
	readonly kind: 'memory' | 'pg-boss' | 'queues';
	register(name: string, handler: JobHandler): void;
	/** Queues a job. `runAt` delays it (the cancellable publish delay uses this). Returns an id. */
	enqueue(name: string, payload: JobPayload, options?: { runAt?: Date }): Promise<string>;
	/**
	 * Runs a job on a repeating schedule, "minute hour * * *" in UTC (a number, a star, or a star and a step in the first two
	 * fields only). Calling it again with the same name replaces the schedule, so every process can call it at start.
	 */
	schedule(name: string, cron: string, payload: JobPayload): Promise<void>;
	start(): Promise<void>;
	stop(): Promise<void>;
}

// -- CONSTANTS -- //

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -- FUNCTIONS -- //

/** True when `date` (UTC, to the minute) matches the schedule. Only the minute and hour fields may vary. */
export function cronDue(cron: string, date: Date): boolean {
	const f = cron.trim().split(/\s+/);
	if (f.length !== 5 || f.slice(2).some((x) => x !== '*'))
		throw new Error(`Unsupported schedule "${cron}". Use "minute hour * * *".`);
	const hit = (field: string, value: number, max: number) => {
		if (field === '*') return true;
		const step = /^\*\/([0-9]+)$/.exec(field);
		if (step) return Number(step[1]) > 0 && value % Number(step[1]) === 0;
		const n = Number(field);
		if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`Bad schedule field "${field}"`);
		return n === value;
	};
	return hit(f[0], date.getUTCMinutes(), 59) && hit(f[1], date.getUTCHours(), 23);
}

/** Refuses a payload with no valid org id, so a job can never run outside a tenant. */
export function assertPayload(payload: JobPayload): void {
	if (!payload || typeof payload.orgId !== 'string' || !UUID.test(payload.orgId))
		throw new Error('A job needs a valid orgId');
	if (payload.projectId !== undefined && !UUID.test(payload.projectId))
		throw new Error('A job projectId must be a UUID');
}

/** Wraps a handler so the tenant context is set from the payload before any query. */
export function contextFor(handle: DbHandle, payload: JobPayload): JobContext {
	assertPayload(payload);
	return {
		payload,
		tenant: (fn) => withTenant(handle, { orgId: payload.orgId, projectId: payload.projectId }, fn)
	};
}

/** An in process runner. Jobs wait their turn, delayed ones wait for their time, and `drain()` runs everything due now (tests). */
export function memoryJobs(handle: DbHandle): JobRunner & {
	drain(now?: Date): Promise<string[]>;
	cancel(id: string): boolean;
	failures: { id: string; name: string; error: string }[];
} {
	const handlers = new Map<string, JobHandler>();
	const queue: { id: string; name: string; payload: JobPayload; runAt: Date }[] = [];
	const failures: { id: string; name: string; error: string }[] = [];
	const schedules = new Map<string, { cron: string; payload: JobPayload; lastMinute: number }>();
	let timer: ReturnType<typeof setInterval> | null = null;

	/** Queues the scheduled jobs that are due this minute, once each. */
	function tickSchedules(now = new Date()) {
		const minute = Math.floor(now.getTime() / 60_000);
		for (const [name, s] of schedules) {
			if (s.lastMinute === minute || !cronDue(s.cron, now)) continue;
			s.lastMinute = minute;
			queue.push({ id: randomUUID(), name, payload: s.payload, runAt: now });
		}
	}

	async function drain(now = new Date()) {
		const ran: string[] = [];
		for (;;) {
			const i = queue.findIndex((j) => j.runAt <= now);
			if (i < 0) break;
			const [job] = queue.splice(i, 1);
			const handler = handlers.get(job.name);
			try {
				if (!handler) throw new Error(`No handler for job "${job.name}"`);
				await handler(contextFor(handle, job.payload));
				ran.push(job.id);
			} catch (e) {
				failures.push({
					id: job.id,
					name: job.name,
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}
		return ran;
	}

	return {
		kind: 'memory',
		failures,
		register: (name, handler) => void handlers.set(name, handler),
		async enqueue(name, payload, options) {
			assertPayload(payload);
			const id = randomUUID();
			queue.push({ id, name, payload, runAt: options?.runAt ?? new Date() });
			return id;
		},
		async schedule(name, cron, payload) {
			assertPayload(payload);
			cronDue(cron, new Date());
			schedules.set(name, { cron, payload, lastMinute: -1 });
		},
		cancel(id) {
			const i = queue.findIndex((j) => j.id === id);
			if (i < 0) return false;
			queue.splice(i, 1);
			return true;
		},
		drain: async (now) => {
			tickSchedules(now);
			return drain(now);
		},
		async start() {
			timer ??= setInterval(() => {
				tickSchedules();
				void drain();
			}, 1000);
		},
		async stop() {
			if (timer) clearInterval(timer);
			timer = null;
		}
	};
}

/** pg-boss on a real PostgreSQL server. The connection must be able to create its own schema. */
export async function pgBossJobs(handle: DbHandle, connectionString: string): Promise<JobRunner> {
	const { PgBoss } = await import('pg-boss');
	const boss = new PgBoss(connectionString);
	const handlers = new Map<string, JobHandler>();
	return {
		kind: 'pg-boss',
		register(name, handler) {
			handlers.set(name, handler);
		},
		async enqueue(name, payload, options) {
			assertPayload(payload);
			await boss.createQueue(name).catch(() => undefined);
			const id = await boss.send(
				name,
				payload,
				options?.runAt ? { startAfter: options.runAt } : {}
			);
			if (!id) throw new Error('The job could not be queued');
			return id;
		},
		async schedule(name, cron, payload) {
			assertPayload(payload);
			cronDue(cron, new Date());
			await boss.createQueue(name).catch(() => undefined);
			// pg-boss keeps schedules in the database by name, so every process can call this at start
			await boss.schedule(name, cron, payload, { tz: 'UTC' });
		},
		async start() {
			await boss.start();
			for (const [name, handler] of handlers) {
				await boss.createQueue(name).catch(() => undefined);
				await boss.work<JobPayload>(name, async (jobs) => {
					for (const j of jobs) await handler(contextFor(handle, j.data));
				});
			}
		},
		async stop() {
			await boss.stop({ graceful: true, timeout: 5000 });
		}
	};
}

/** The shape of a Cloudflare Queues producer binding. */
/** Cloudflare Queues refuse a delay over 12 hours, so a later time travels in the message and is waited out in hops. */
const MAX_QUEUE_DELAY_SECONDS = 12 * 3600;

export type QueueLike = {
	send(
		message: { name: string; payload: JobPayload; runAt?: string },
		options?: { delaySeconds?: number }
	): Promise<void>;
};

/** Cloudflare Queues. Delays use delaySeconds. The consumer calls `runQueued` for each message. */
export function queuesJobs(
	handle: DbHandle,
	queue: QueueLike
): JobRunner & {
	runQueued(message: { name: string; payload: JobPayload; runAt?: string }): Promise<void>;
} {
	const handlers = new Map<string, JobHandler>();
	return {
		kind: 'queues',
		register: (name, handler) => void handlers.set(name, handler),
		async enqueue(name, payload, options) {
			assertPayload(payload);
			const wait = options?.runAt
				? Math.max(0, Math.ceil((options.runAt.getTime() - Date.now()) / 1000))
				: 0;
			await queue.send(
				{
					name,
					payload,
					...(wait > MAX_QUEUE_DELAY_SECONDS ? { runAt: options!.runAt!.toISOString() } : {})
				},
				wait ? { delaySeconds: Math.min(wait, MAX_QUEUE_DELAY_SECONDS) } : undefined
			);
			return randomUUID();
		},
		async schedule() {
			// Cloudflare runs scheduled jobs from cron triggers in the Worker configuration, not from here
		},
		async runQueued(message) {
			// Not yet time: send it on for the next hop and finish this one
			if (message.runAt) {
				const left = Math.ceil((new Date(message.runAt).getTime() - Date.now()) / 1000);
				if (left > 5) {
					await queue.send(message, { delaySeconds: Math.min(left, MAX_QUEUE_DELAY_SECONDS) });
					return;
				}
			}
			const handler = handlers.get(message.name);
			if (!handler) throw new Error(`No handler for job "${message.name}"`);
			await handler(contextFor(handle, message.payload));
		},
		async start() {},
		async stop() {}
	};
}
