// BACKGROUND JOBS (5.13). EVERY JOB CARRIES ITS ORG AND PROJECT IDS, AND ITS HANDLER CAN QUERY ONLY THROUGH THE TENANT CONTEXT
// The handler is never given a database handle. It gets `tenant(fn)`, which sets the tenant before the first query (L5).
// Adapters: memory (tests) and pg-boss (a real PostgreSQL server).

// IMPORTED TYPES
import type { DbHandle, Tx } from '../db/client';
// IMPORTED DEP-MODULES
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
// IMPORTED MODULES
import { org } from '../db/schema';
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
	readonly kind: 'memory' | 'pg-boss';
	register(name: string, handler: JobHandler): void;
	/** Queues a job. `runAt` delays it (a delayed job uses this). Returns an id. */
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

/**
 * Wraps a handler so the tenant context is set from the payload before any query. A job of an org that an owner deleted is
 * refused before its first query, unless the payload says `allowLocked` (the purge of that very org).
 */
export function contextFor(handle: DbHandle, payload: JobPayload): JobContext {
	assertPayload(payload);
	return {
		payload,
		tenant: (fn) =>
			withTenant(handle, { orgId: payload.orgId, projectId: payload.projectId }, async (tx) => {
				if (payload.allowLocked !== true) {
					const [o] = await tx
						.select({ deletedAt: org.deletedAt })
						.from(org)
						.where(eq(org.id, payload.orgId));
					if (o?.deletedAt) throw new Error('This organisation is scheduled for deletion');
				}
				return fn(tx);
			})
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
