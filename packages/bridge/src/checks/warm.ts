// WARM PREVIEWS: A PREVIEW THAT STAYS UP A FEW MINUTES SO THE NEXT CHECK ON THE SAME TREE USES IT WITH A FRESH BROWSER CONTEXT.
// Opt in only (the recipe says "warm": true) and only for an app that cannot leak or lose anything: no database, no mail, no sealed secrets, no adopted .env.
// The key is a hash of the registration, the tree, the pin, the recipe and the environment, so a changed tree or pin is a different key and never finds the old
// preview. Each warm preview has a marker under poolDir()/warm (owner process, preview process, port, expiry) and one small file per user, so the count of users
// survives separate processes. The preview is stopped by its owner when it expires, when the worker stops (stopAll), and by doctor (sweepWarm) when its owner is
// gone or it expired. Only process ids recorded in a marker are ever killed, and only with killTree.

// IMPORTED DEP-MODULES
import { createHash, randomBytes } from 'node:crypto';
import { linkSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// IMPORTED MODULES
import { pidAlive } from './lock.js';
import { ensureDir, poolDir } from './paths.js';
import { renameRetry } from './fsretry.js';
import { killTree } from './scope.js';

// -- TYPES -- //

export type WarmKeyParts = {
	registration: string;
	/** The tree the preview was built from (commit plus a hash of the working-tree changes). */
	treeId: string;
	/** The registration's pin: the hash of the files that decide what runs. */
	pin: string;
	recipeHash: string;
	envHash: string;
};

/** What the preview module hands over when it registers a running preview. */
export type WarmPreview = {
	baseUrl: string;
	port: number;
	/** The process of the preview, recorded so doctor can stop it when its owner died. */
	pid?: number | null;
	/** Stops the preview and gives back everything it holds. Called by the owner only. */
	stop(): Promise<void>;
};

export type WarmLease = {
	readonly key: string;
	readonly baseUrl: string;
	readonly port: number;
	/** Gives the preview back. The last one to give it back starts its time to live. */
	release(): void;
};

export type WarmMarker = {
	v: 1;
	key: string;
	registration: string;
	baseUrl: string;
	port: number;
	previewPid: number | null;
	ownerPid: number;
	/** When the owner started (milliseconds), so a reused process id is told from the owner. */
	ownerStart: number;
	createdAt: number;
	expiresAt: number;
};

export type WarmDeps = {
	dir: string;
	now(): number;
	pidAlive(pid: number): boolean;
	kill(pid: number): Promise<void>;
	ttlMs: number;
};

export type WarmAllowedInput = {
	recipeWarm: boolean;
	adoptEnv: boolean;
	sealed: boolean;
	hasDatabase: boolean;
	hasMailOrDbVars: boolean;
	/** False when the check writes: warm previews are for read-only checks. Left out, it is not judged. */
	readOnly?: boolean;
};

// -- CONSTANTS -- //

/** How long a warm preview stays up after its last user, 5 minutes. AFB_CHECKS_WARM_TTL_MS overrides. */
export const warmTtlMs = () => {
	const v = Number(process.env.AFB_CHECKS_WARM_TTL_MS);
	return Number.isFinite(v) && v > 0 ? v : 5 * 60_000;
};

const OWNER_START = Date.now() - Math.round(process.uptime() * 1000);

// -- FUNCTIONS -- //

/** The key of a warm preview. Any part empty (the registration, the tree or the recipe) is refused: such a key would match too much. */
export function warmKey(p: WarmKeyParts): string {
	if (!p.registration || !p.treeId || !p.recipeHash)
		throw new Error('A warm key needs a registration, a tree and a recipe.');
	const h = createHash('sha256');
	for (const part of [p.registration, p.treeId, p.pin ?? '', p.recipeHash, p.envHash ?? ''])
		h.update(`${part.length}:${part}\n`);
	return h.digest('hex').slice(0, 40);
}

/** Whether a run may use a warm preview, and the plain reason when it may not. */
export function warmAllowed(
	i: WarmAllowedInput
): { allowed: true } | { allowed: false; why: string } {
	if (!i.recipeWarm) return { allowed: false, why: 'The recipe does not ask for a warm preview.' };
	if (i.adoptEnv)
		return {
			allowed: false,
			why: 'A warm preview is never used when the registration adopts its .env.'
		};
	if (i.sealed) return { allowed: false, why: 'A warm preview is never used with sealed secrets.' };
	if (i.hasDatabase)
		return { allowed: false, why: 'A warm preview is never used for an app with a database.' };
	if (i.hasMailOrDbVars)
		return {
			allowed: false,
			why: 'A warm preview is never used when the app has mail or database settings.'
		};
	if (i.readOnly === false)
		return { allowed: false, why: 'A warm preview is only used for read-only checks.' };
	return { allowed: true };
}

const KEY = /^[a-f0-9]{40}$/;

function readText(file: string): string | null {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

function parseMarker(text: string | null): WarmMarker | null {
	if (text === null) return null;
	try {
		const v = JSON.parse(text) as Partial<WarmMarker> | null;
		if (!v || v.v !== 1 || typeof v.key !== 'string' || !KEY.test(v.key)) return null;
		if (
			typeof v.ownerPid !== 'number' ||
			typeof v.expiresAt !== 'number' ||
			typeof v.port !== 'number'
		)
			return null;
		if (typeof v.baseUrl !== 'string') return null;
		return v as WarmMarker;
	} catch {
		return null;
	}
}

function writeWhole(file: string, text: string, exclusive: boolean): boolean {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	try {
		if (exclusive) linkSync(tmp, file);
		else renameRetry(tmp, file);
		return true;
	} catch (e) {
		if (exclusive && (e as NodeJS.ErrnoException).code === 'EEXIST') return false;
		if (!exclusive) return false;
		throw e;
	} finally {
		rmSync(tmp, { force: true });
	}
}

export class WarmStore {
	private readonly deps: WarmDeps;
	/** The previews this process started and still owns. Only the owner stops one through its handle. */
	private readonly owned = new Map<string, WarmPreview>();
	private timer: NodeJS.Timeout | null = null;

	constructor(deps: Partial<WarmDeps> = {}) {
		this.deps = {
			dir: deps.dir ?? join(poolDir(), 'warm'),
			now: deps.now ?? (() => Date.now()),
			pidAlive: deps.pidAlive ?? pidAlive,
			kill: deps.kill ?? killTree,
			ttlMs: deps.ttlMs ?? warmTtlMs()
		};
	}

	private marker = (key: string) => join(this.deps.dir, `${key}.json`);
	private useDir = (key: string) => join(this.deps.dir, `${key}.use`);

	private assertKey(key: string) {
		if (!KEY.test(key)) throw new Error('That is not a warm key.');
	}

	/** How many live users the preview has. A use file of a dead process is removed. */
	users(key: string): number {
		this.assertKey(key);
		let n = 0;
		let names: string[];
		try {
			names = readdirSync(this.useDir(key));
		} catch {
			return 0;
		}
		for (const name of names) {
			const file = join(this.useDir(key), name);
			let pid: number;
			try {
				pid = (JSON.parse(readText(file) ?? '{}') as { pid?: number }).pid ?? 0;
			} catch {
				pid = 0;
			}
			if (pid && this.deps.pidAlive(pid)) n++;
			else rmSync(file, { force: true });
		}
		return n;
	}

	private addUser(key: string): string {
		ensureDir(this.useDir(key));
		const id = randomBytes(6).toString('hex');
		writeFileSync(join(this.useDir(key), `${id}.json`), JSON.stringify({ pid: process.pid }), {
			mode: 0o600
		});
		return id;
	}

	private lease(m: WarmMarker, id: string): WarmLease {
		let released = false;
		return {
			key: m.key,
			baseUrl: m.baseUrl,
			port: m.port,
			release: () => {
				if (released) return;
				released = true;
				rmSync(join(this.useDir(m.key), `${id}.json`), { force: true });
				// The last user starts the time to live
				if (this.users(m.key) === 0) {
					const cur = parseMarker(readText(this.marker(m.key)));
					if (cur)
						writeWhole(
							this.marker(m.key),
							JSON.stringify({ ...cur, expiresAt: this.deps.now() + this.deps.ttlMs }) + '\n',
							false
						);
				}
			}
		};
	}

	/** Whether the marker describes a preview that can be used right now. */
	private usable(m: WarmMarker): boolean {
		if (!this.deps.pidAlive(m.ownerPid)) return false;
		if (m.previewPid && !this.deps.pidAlive(m.previewPid)) return false;
		return this.deps.now() < m.expiresAt || this.users(m.key) > 0;
	}

	/** The warm preview of this exact key, or null. A different tree, pin, recipe or environment is a different key and finds nothing. */
	acquire(key: string): WarmLease | null {
		this.assertKey(key);
		const m = parseMarker(readText(this.marker(key)));
		if (!m || m.key !== key || !this.usable(m)) return null;
		const id = this.addUser(key);
		// The marker may have been swept between the look and the use file: then there is nothing to use
		const again = parseMarker(readText(this.marker(key)));
		if (!again || again.key !== key) {
			rmSync(join(this.useDir(key), `${id}.json`), { force: true });
			return null;
		}
		return this.lease(again, id);
	}

	/**
	 * Records a running preview as the warm preview of `key` and counts the caller as its first user. Returns null when a usable one is there already (two runs built
	 * the same tree at once): the caller keeps its own preview as a plain one and stops it when it is done.
	 */
	register(key: string, preview: WarmPreview, registration: string): WarmLease | null {
		this.assertKey(key);
		ensureDir(this.deps.dir);
		const existing = parseMarker(readText(this.marker(key)));
		if (existing && this.usable(existing)) return null;
		if (existing) rmSync(this.marker(key), { force: true });
		const now = this.deps.now();
		const m: WarmMarker = {
			v: 1,
			key,
			registration,
			baseUrl: preview.baseUrl,
			port: preview.port,
			previewPid: preview.pid ?? null,
			ownerPid: process.pid,
			ownerStart: OWNER_START,
			createdAt: now,
			expiresAt: now + this.deps.ttlMs
		};
		if (!writeWhole(this.marker(key), JSON.stringify(m) + '\n', true)) return null;
		this.owned.set(key, preview);
		this.watch();
		return this.lease(m, this.addUser(key));
	}

	/** Looks at every marker: an expired preview with no user, or one whose owner is gone, is stopped and forgotten. Returns how many were stopped. */
	async sweep(): Promise<number> {
		let names: string[];
		try {
			names = readdirSync(this.deps.dir).filter((f) => f.endsWith('.json'));
		} catch {
			return 0;
		}
		let stopped = 0;
		for (const name of names) {
			const key = name.slice(0, -'.json'.length);
			if (!KEY.test(key)) continue;
			const m = parseMarker(readText(this.marker(key)));
			if (!m || m.key !== key) {
				// Damaged: no pid can be trusted, so only the file goes
				rmSync(this.marker(key), { force: true });
				continue;
			}
			const ownerGone = !this.deps.pidAlive(m.ownerPid);
			const previewGone = m.previewPid !== null && !this.deps.pidAlive(m.previewPid);
			const expired = this.deps.now() >= m.expiresAt && this.users(key) === 0;
			if (!ownerGone && !previewGone && !expired) continue;
			await this.stop(key, m);
			stopped++;
		}
		return stopped;
	}

	private async stop(key: string, m: WarmMarker): Promise<void> {
		const handle = this.owned.get(key);
		this.owned.delete(key);
		try {
			if (handle) await handle.stop();
			else if (m.previewPid && m.previewPid !== process.pid && this.deps.pidAlive(m.previewPid))
				await this.deps.kill(m.previewPid);
		} catch {
			/* A preview that will not stop is left to the next sweep: the marker is kept */
			if (handle || (m.previewPid && this.deps.pidAlive(m.previewPid))) {
				if (handle) this.owned.set(key, handle);
				return;
			}
		}
		rmSync(this.marker(key), { force: true });
		rmSync(this.useDir(key), { recursive: true, force: true });
	}

	/** Stops every preview this process owns (the worker is stopping). */
	async stopAll(): Promise<number> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		let n = 0;
		for (const [key, handle] of [...this.owned]) {
			this.owned.delete(key);
			try {
				await handle.stop();
			} catch {
				/* The sweep of the next worker or doctor stops it by its recorded process id */
				continue;
			}
			rmSync(this.marker(key), { force: true });
			rmSync(this.useDir(key), { recursive: true, force: true });
			n++;
		}
		return n;
	}

	/** The owner looks at its previews now and then, so an expired one is stopped without anybody asking. */
	private watch() {
		if (this.timer) return;
		const every = Math.max(1_000, Math.min(30_000, Math.floor(this.deps.ttlMs / 4)));
		this.timer = setInterval(() => void this.sweep().catch(() => undefined), every);
		this.timer.unref();
	}

	/** The markers on disk, for doctor and status. */
	list(): WarmMarker[] {
		try {
			return readdirSync(this.deps.dir)
				.filter((f) => f.endsWith('.json'))
				.map((f) => parseMarker(readText(join(this.deps.dir, f))))
				.filter((m): m is WarmMarker => m !== null);
		} catch {
			return [];
		}
	}
}

const stores = new Map<string, WarmStore>();

/** The warm store of this machine's pool folder. One object per folder, so the previews this process owns are found again. */
export function warmStore(): WarmStore {
	const dir = join(poolDir(), 'warm');
	let s = stores.get(dir);
	if (!s) {
		s = new WarmStore({ dir });
		stores.set(dir, s);
	}
	return s;
}

export const acquireWarm = (key: string, store: WarmStore = warmStore()): WarmLease | null =>
	store.acquire(key);
export const releaseWarm = (lease: WarmLease): void => lease.release();
export const registerWarm = (
	key: string,
	preview: WarmPreview,
	registration: string,
	store: WarmStore = warmStore()
): WarmLease | null => store.register(key, preview, registration);
/** Called when the worker stops. */
export const stopAll = (store: WarmStore = warmStore()): Promise<number> => store.stopAll();
/** Called by doctor: stops expired previews and the previews of owners that are gone. */
export const sweepWarm = (store: WarmStore = warmStore()): Promise<number> => store.sweep();
