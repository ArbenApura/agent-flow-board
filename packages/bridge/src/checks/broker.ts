// THE MACHINE BROKER: HOW MANY RUNS THIS MACHINE TAKES AT ONCE, ACROSS EVERY `check run` AND `check watch` PROCESS.
// A slot is a small file in brokerDir() (slots/slot-N.json) holding the process id, the start time and a heartbeat. A slot whose process is gone, or whose heartbeat
// stopped for the stale window, is reclaimed by the next process that looks. A process that waits for a slot writes a waiter file, so every process sees the same
// queue: the head of the queue is the waiter whose registration runs the fewest slots now (ties by arrival), and only the head may take a slot. The machine check
// (free disk, free memory per run that started in the last 90 s) is part of taking a slot and WAITS instead of failing. Nothing here blocks the event loop for
// longer than a few small file reads.

// IMPORTED DEP-MODULES
import { randomBytes } from 'node:crypto';
import {
	linkSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	statfsSync,
	writeFileSync
} from 'node:fs';
import { cpus, freemem } from 'node:os';
import { join } from 'node:path';
// IMPORTED MODULES
import { pidAlive } from './lock.js';
import { brokerDir, checksHome, ensureDir, poolDir } from './paths.js';

// -- TYPES -- //

export type SlotRequest = {
	runId: string;
	/** What the run is: `check`, `shots`, or the like. Shown in status only. */
	kind: string;
	/** The registration (or board project) the run belongs to, for fairness. */
	registration: string;
};

export type Slot = {
	readonly id: string;
	readonly index: number;
	/** False when the slot was reclaimed from this process (it stalled longer than the stale window). */
	held(): boolean;
	/** Gives the slot back. Safe to call twice, and never removes a slot that now belongs to somebody else. */
	release(): void;
};

export type WaitReason = 'turn' | 'slots' | 'DISK_LOW' | 'MEMORY_LOW';

export type WaitInfo = {
	runId: string;
	registration: string;
	since: number;
	reason: WaitReason;
	/** One plain line for the log or the status line. */
	why: string;
};

export type BrokerDeps = {
	now(): number;
	pidAlive(pid: number): boolean;
	/** Free bytes where the runs live, or null when unreadable (then the check passes). */
	freeDiskBytes(): number | null;
	freeMemBytes(): number;
};

export type AcquireOptions = {
	signal?: AbortSignal;
	deps?: Partial<BrokerDeps>;
	/** How many slots there are. Default maxSlots(). */
	slots?: number;
	/** A slot or waiter whose heartbeat is older than this is dead. */
	staleMs?: number;
	/** How often a waiter looks again. */
	pollMs?: number;
	/** Called when the reason for waiting changes (and once at the start). */
	onWait?(info: WaitInfo): void;
};

export type PreflightResult =
	{ ok: true } | { ok: false; code: 'DISK_LOW' | 'MEMORY_LOW'; why: string };

export type PoolInfo = { name: string; file: string; info: unknown };

type SlotBody = {
	v: 1;
	index: number;
	pid: number;
	token: string;
	runId: string;
	kind: string;
	registration: string;
	startedAt: number;
	beat: number;
};
type WaiterBody = {
	v: 1;
	id: string;
	pid: number;
	runId: string;
	registration: string;
	arrivedAt: number;
	beat: number;
};

// -- CONSTANTS -- //

const GB = 1024 ** 3;
const MB = 1024 ** 2;
/** A run that started this recently has not used its memory yet (browser, preview and database are still starting), so it is counted again. */
export const RECENT_START_MS = 90_000;
const DEFAULT_STALE_MS = 45_000;
const DEFAULT_POLL_MS = 250;
/** A file that cannot be read is only treated as dead after this long (files are created whole, so this means damage). */
const UNREADABLE_GRACE_MS = 2_000;

const num = (name: string, fallback: number) => {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
};

// -- FUNCTIONS: SETTINGS -- //

/** Free disk a new run needs where the tool keeps its runs, in gigabytes. */
export const minFreeDiskGb = () => num('AFB_CHECKS_MIN_FREE_GB', 4);
/** Free memory another run needs, in megabytes. */
export const perRunMemoryMb = () => num('AFB_CHECKS_RUN_MEMORY_MB', 1200);

/** Slots when nothing is set: as many as the machine has processors, at most 8. The memory and disk preflight still holds a run back when the machine is full. */
export const defaultSlots = (): number => Math.max(1, Math.min(cpus().length, 8));

/** The most runs this machine takes at once: AFB_CHECKS_MAX_PARALLEL, else the configured number, else min(processors, 8); never above the number of processors. */
export function maxSlots(configured?: number | null): number {
	const raw = process.env.AFB_CHECKS_MAX_PARALLEL ?? configured;
	const wanted = raw === undefined || raw === null || raw === '' ? NaN : Math.floor(Number(raw));
	const cap = Math.max(1, cpus().length);
	return Math.min(cap, Math.max(1, Number.isFinite(wanted) ? wanted : defaultSlots()));
}

function freeDisk(): number | null {
	try {
		const s = statfsSync(ensureDir(checksHome()));
		return Number(s.bavail) * Number(s.bsize);
	} catch {
		return null;
	}
}

const realDeps = (): BrokerDeps => ({
	now: () => Date.now(),
	pidAlive,
	freeDiskBytes: freeDisk,
	freeMemBytes: () => freemem()
});

const withDeps = (d?: Partial<BrokerDeps>): BrokerDeps => ({ ...realDeps(), ...d });

/**
 * Whether another run may start. `busy` is how many runs hold a slot, `recent` how many of them started in the last 90 s. The first run on a machine is never held
 * back for memory (an unreadable or low reading must not stop all work).
 */
export function preflight(i: {
	busy: number;
	recent: number;
	freeDiskBytes: number | null;
	freeMemBytes: number;
}): PreflightResult {
	const need = minFreeDiskGb();
	if (i.freeDiskBytes !== null && i.freeDiskBytes < need * GB)
		return {
			ok: false,
			code: 'DISK_LOW',
			why: `Only ${(i.freeDiskBytes / GB).toFixed(1)} GB is free where the tool keeps its runs and a run needs ${need} GB. Free some space (agent-flow-board check clear), then it takes runs again.`
		};
	const mem = perRunMemoryMb() * (1 + i.recent);
	if (i.busy > 0 && i.freeMemBytes < mem * MB)
		return {
			ok: false,
			code: 'MEMORY_LOW',
			why: `Only ${Math.round(i.freeMemBytes / MB)} MB of memory is free and another run needs ${mem} MB, so it waits for one of the ${i.busy} running to finish.`
		};
	return { ok: true };
}

// -- FUNCTIONS: FILES -- //

const slotsDir = () => join(brokerDir(), 'slots');
const waitersDir = () => join(brokerDir(), 'waiters');
const slotFile = (index: number) => join(slotsDir(), `slot-${index}.json`);

function readText(file: string): string | null {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

function parse<T extends { v: number }>(text: string | null): T | null {
	if (text === null) return null;
	try {
		const v: unknown = JSON.parse(text);
		return v && typeof v === 'object' && (v as { v?: unknown }).v === 1 ? (v as T) : null;
	} catch {
		return null;
	}
}

/** Creates a file with its whole content at once (a temporary file linked into place). False when it exists. */
function createWhole(file: string, text: string): boolean {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	try {
		linkSync(tmp, file);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw e;
	} finally {
		rmSync(tmp, { force: true });
	}
}

/** Replaces a file whole (a temporary file renamed over it). A failure is ignored: the next beat tries again. */
function replaceWhole(file: string, text: string): void {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	try {
		writeFileSync(tmp, text, { mode: 0o600 });
		renameSync(tmp, file);
	} catch {
		rmSync(tmp, { force: true });
	}
}

/**
 * Removes a dead file the careful way: moved aside under a name of its own, compared with what was seen, and linked back when it turns out to be somebody's fresh
 * file (a dead file that is unlinked and a new one made in between would lose the new one).
 */
function reap(file: string, seen: string | null, stillDead: (moved: string) => boolean): void {
	const aside = `${file}.aside.${process.pid}.${randomBytes(4).toString('hex')}`;
	try {
		renameSync(file, aside);
	} catch {
		return;
	}
	const moved = readText(aside);
	if (moved !== null && moved !== seen && !stillDead(moved)) {
		try {
			linkSync(aside, file);
		} catch {
			/* A newer file is already there */
		}
	}
	rmSync(aside, { force: true });
}

function listJson(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith('.json'))
			.map((f) => join(dir, f));
	} catch {
		return [];
	}
}

function unreadableAndOld(file: string, now: number): boolean {
	try {
		return now - statSync(file).mtimeMs > UNREADABLE_GRACE_MS;
	} catch {
		return false;
	}
}

type View = { slots: SlotBody[]; waiters: WaiterBody[] };

/** Reads the slots and waiters that are alive, and removes the dead ones. */
function readView(deps: BrokerDeps, staleMs: number): View {
	const now = deps.now();
	const slots: SlotBody[] = [];
	for (const file of listJson(slotsDir())) {
		const text = readText(file);
		const body = parse<SlotBody>(text);
		const dead = (b: SlotBody | null, t: string | null) =>
			b
				? !deps.pidAlive(b.pid) || now - b.beat > staleMs
				: t === null
					? false
					: unreadableAndOld(file, now);
		if (dead(body, text)) {
			reap(file, text, (moved) => dead(parse<SlotBody>(moved), moved));
			continue;
		}
		if (body) slots.push(body);
	}
	const waiters: WaiterBody[] = [];
	for (const file of listJson(waitersDir())) {
		const text = readText(file);
		const body = parse<WaiterBody>(text);
		const dead = (b: WaiterBody | null, t: string | null) =>
			b
				? !deps.pidAlive(b.pid) || now - b.beat > staleMs
				: t === null
					? false
					: unreadableAndOld(file, now);
		if (dead(body, text)) {
			reap(file, text, (moved) => dead(parse<WaiterBody>(moved), moved));
			continue;
		}
		if (body) waiters.push(body);
	}
	return { slots, waiters };
}

/** The waiter that goes first: the registration with the fewest running slots, then the earliest arrival. */
function head(view: View): WaiterBody | null {
	const running = new Map<string, number>();
	for (const s of view.slots) running.set(s.registration, (running.get(s.registration) ?? 0) + 1);
	const sorted = [...view.waiters].sort(
		(a, b) =>
			(running.get(a.registration) ?? 0) - (running.get(b.registration) ?? 0) ||
			a.arrivedAt - b.arrivedAt ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
	return sorted[0] ?? null;
}

// -- FUNCTIONS: STATUS -- //

const inProcessWaiting = new Map<string, WaitInfo>();

/** The runs of this process that wait for a slot right now, so the caller can keep the board told that they are alive. */
export const waiting = (): WaitInfo[] => [...inProcessWaiting.values()];

/** How many slots there are and how many are held right now by every process on this machine. */
export function machineTotals(
	o: { slots?: number; deps?: Partial<BrokerDeps>; staleMs?: number } = {}
): {
	slots: number;
	busy: number;
} {
	const slots = o.slots ?? maxSlots();
	const view = readView(withDeps(o.deps), o.staleMs ?? DEFAULT_STALE_MS);
	return { slots, busy: Math.min(slots, view.slots.length) };
}

/** The value of the x-afb-tool-slots header. */
export const slotsHeader = (o: Parameters<typeof machineTotals>[0] = {}): string => {
	const t = machineTotals(o);
	return `${t.slots}:${t.busy}`;
};

/** Whether the machine could take another run now, without waiting: for a scheduler that leaves a run unclaimed when the answer is no. */
export function canTake(
	o: { slots?: number; deps?: Partial<BrokerDeps>; staleMs?: number } = {}
): PreflightResult {
	const deps = withDeps(o.deps);
	const view = readView(deps, o.staleMs ?? DEFAULT_STALE_MS);
	const now = deps.now();
	return preflight({
		busy: view.slots.length,
		recent: view.slots.filter((s) => now - s.startedAt < RECENT_START_MS).length,
		freeDiskBytes: deps.freeDiskBytes(),
		freeMemBytes: deps.freeMemBytes()
	});
}

/** The pools (browser, database) other processes of this machine left a file for in poolDir(). The warm folder is the warm store's. */
export function listPools(): PoolInfo[] {
	const out: PoolInfo[] = [];
	for (const file of listJson(poolDir())) {
		const text = readText(file);
		let info: unknown = null;
		try {
			info = text === null ? null : JSON.parse(text);
		} catch {
			/* A damaged file is listed without its content */
		}
		out.push({ name: file.slice(poolDir().length + 1).replace(/\.json$/, ''), file, info });
	}
	return out;
}

// -- FUNCTIONS: ACQUIRE -- //

const held = new Set<{ file: string; token: string }>();
let exitHook = false;

function dropHeldOnExit() {
	if (exitHook) return;
	exitHook = true;
	process.once('exit', () => {
		for (const h of held) {
			const body = parse<SlotBody>(readText(h.file));
			if (body?.token === h.token) rmSync(h.file, { force: true });
		}
	});
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal?.removeEventListener('abort', done);
			resolve();
		}
		signal?.addEventListener('abort', done, { once: true });
	});

export const abortError = () =>
	Object.assign(new Error('Waiting for a slot was stopped.'), { name: 'AbortError' });

function tryTake(req: SlotRequest, slots: number, deps: BrokerDeps, staleMs: number): Slot | null {
	ensureDir(slotsDir());
	for (let index = 0; index < slots; index++) {
		const file = slotFile(index);
		const token = randomBytes(8).toString('hex');
		const now = deps.now();
		const body: SlotBody = {
			v: 1,
			index,
			pid: process.pid,
			token,
			runId: req.runId,
			kind: req.kind,
			registration: req.registration,
			startedAt: now,
			beat: now
		};
		if (!createWhole(file, JSON.stringify(body) + '\n')) continue;
		// Slots with a number above the limit (the limit was lowered) still count: when the machine is over the limit now, this one goes back
		if (readView(deps, staleMs).slots.length > slots) {
			rmSync(file, { force: true });
			return null;
		}
		return makeSlot(file, body, deps, staleMs);
	}
	return null;
}

function makeSlot(file: string, body: SlotBody, deps: BrokerDeps, staleMs: number): Slot {
	const handle = { file, token: body.token };
	held.add(handle);
	dropHeldOnExit();
	let released = false;
	let lost = false;
	const beat = () => {
		if (released || lost) return;
		const current = parse<SlotBody>(readText(file));
		if (!current || current.token !== body.token) {
			lost = true;
			return;
		}
		replaceWhole(file, JSON.stringify({ ...current, beat: deps.now() }) + '\n');
	};
	const timer = setInterval(beat, Math.max(20, Math.floor(staleMs / 3)));
	timer.unref();
	return {
		id: body.token,
		index: body.index,
		held: () => !released && !lost,
		release() {
			if (released) return;
			released = true;
			clearInterval(timer);
			held.delete(handle);
			const text = readText(file);
			if (parse<SlotBody>(text)?.token === body.token) reap(file, text, () => true);
		}
	};
}

/**
 * Waits for a slot and returns it. Waits (never fails) while the machine has no free slot, while other registrations go first, and while the disk or memory check
 * says no. Rejects with an AbortError when the signal aborts. The caller releases the slot in a finally. The waiter file is beaten while waiting, and `waiting()`
 * lists what this process waits for, so the caller keeps the board told that the run is alive.
 */
export async function acquireSlot(req: SlotRequest, opts: AcquireOptions = {}): Promise<Slot> {
	const deps = withDeps(opts.deps);
	const slots = opts.slots ?? maxSlots();
	const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
	const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
	const { signal } = opts;
	ensureDir(waitersDir());
	const id = `${req.runId}-${randomBytes(3).toString('hex')}`;
	const file = join(waitersDir(), `${id}.json`);
	const arrivedAt = deps.now();
	let lastBeat = 0;
	const writeWaiter = (force = false) => {
		const now = deps.now();
		if (!force && now - lastBeat < staleMs / 3) return;
		lastBeat = now;
		const body: WaiterBody = {
			v: 1,
			id,
			pid: process.pid,
			runId: req.runId,
			registration: req.registration,
			arrivedAt,
			beat: now
		};
		replaceWhole(file, JSON.stringify(body) + '\n');
	};
	writeWaiter(true);
	const since = arrivedAt;
	let said: WaitReason | null = null;
	try {
		for (;;) {
			if (signal?.aborted) throw abortError();
			writeWaiter();
			const view = readView(deps, staleMs);
			let reason: WaitReason | null = null;
			let why = '';
			if (view.slots.length >= slots) {
				reason = 'slots';
				why = `All ${slots} slot${slots === 1 ? ' is' : 's are'} busy, so this run waits for one.`;
			} else if (head(view)?.id !== id) {
				reason = 'turn';
				why =
					'Another run goes first (the registrations take turns), so this run waits for its turn.';
			} else {
				const now = deps.now();
				const pf = preflight({
					busy: view.slots.length,
					recent: view.slots.filter((s) => now - s.startedAt < RECENT_START_MS).length,
					freeDiskBytes: deps.freeDiskBytes(),
					freeMemBytes: deps.freeMemBytes()
				});
				if (!pf.ok) {
					reason = pf.code;
					why = pf.why;
				}
			}
			if (!reason) {
				const slot = tryTake(req, slots, deps, staleMs);
				if (slot) return slot;
				reason = 'slots';
				why = 'Another process took the slot first, so this run waits for the next one.';
			}
			const info: WaitInfo = {
				runId: req.runId,
				registration: req.registration,
				since,
				reason,
				why
			};
			inProcessWaiting.set(id, info);
			if (said !== reason) {
				said = reason;
				opts.onWait?.(info);
			}
			await sleep(pollMs, signal);
		}
	} finally {
		inProcessWaiting.delete(id);
		rmSync(file, { force: true });
	}
}
