// WARM PREVIEWS: A CHANGED TREE OR PIN NEVER FINDS AN OLD PREVIEW, A PREVIEW EXPIRES, AND ONLY RECORDED PROCESSES ARE EVER STOPPED

// -- DEP-MODULES -- //
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { WarmStore, warmAllowed, warmKey, type WarmKeyParts, type WarmPreview } from './warm.js';

// -- CONSTANTS -- //

const parts: WarmKeyParts = {
	registration: 'WEB',
	treeId: 'abc123+d1',
	pin: 'pin1',
	recipeHash: 'rec1',
	envHash: 'env1'
};
const allowed = {
	recipeWarm: true,
	adoptEnv: false,
	sealed: false,
	hasDatabase: false,
	hasMailOrDbVars: false
};

// -- FUNCTIONS -- //

describe('warm previews', () => {
	let dir = '';
	let clock = 1_000_000;
	const alive = new Set<number>();
	const killed: number[] = [];
	const store = (ttlMs = 60_000) =>
		new WarmStore({
			dir,
			ttlMs,
			now: () => clock,
			pidAlive: (pid) => alive.has(pid),
			kill: async (pid) => {
				killed.push(pid);
				alive.delete(pid);
			}
		});
	const preview = (pid: number | null = 4242): WarmPreview & { stopped: number } => {
		const p = {
			baseUrl: 'http://127.0.0.1:5301',
			port: 5301,
			pid,
			stopped: 0,
			async stop() {
				p.stopped++;
				if (pid) alive.delete(pid);
			}
		};
		if (pid) alive.add(pid);
		return p;
	};

	beforeEach(() => {
		dir = join(mkdtempSync(join(tmpdir(), 'afb-warm-')), 'warm');
		clock = 1_000_000;
		alive.clear();
		killed.length = 0;
		alive.add(process.pid);
	});
	afterEach(() => {
		rmSync(join(dir, '..'), { recursive: true, force: true });
	});

	it('makes a key that changes with every part and cannot be confused by moving text between parts', () => {
		const base = warmKey(parts);
		expect(base).toMatch(/^[a-f0-9]{40}$/);
		expect(warmKey({ ...parts })).toBe(base);
		for (const k of Object.keys(parts) as (keyof WarmKeyParts)[])
			expect(warmKey({ ...parts, [k]: `${parts[k]}x` }), k).not.toBe(base);
		expect(warmKey({ ...parts, registration: 'ab', treeId: 'c' })).not.toBe(
			warmKey({ ...parts, registration: 'a', treeId: 'bc' })
		);
		expect(() => warmKey({ ...parts, treeId: '' })).toThrow();
		expect(() => warmKey({ ...parts, registration: '' })).toThrow();
	});

	it('refuses a warm preview in every case that could leak or lose something', () => {
		expect(warmAllowed(allowed)).toEqual({ allowed: true });
		expect(warmAllowed({ ...allowed, readOnly: true })).toEqual({ allowed: true });
		for (const bad of [
			{ recipeWarm: false },
			{ adoptEnv: true },
			{ sealed: true },
			{ hasDatabase: true },
			{ hasMailOrDbVars: true },
			{ readOnly: false }
		]) {
			const r = warmAllowed({ ...allowed, ...bad });
			expect(r.allowed, JSON.stringify(bad)).toBe(false);
			if (!r.allowed) expect(r.why.length).toBeGreaterThan(10);
		}
	});

	it('hands the same preview to the next run on the same key and counts its users', () => {
		const s = store();
		const key = warmKey(parts);
		expect(s.acquire(key)).toBeNull();
		const first = s.register(key, preview(), 'WEB');
		expect(first).not.toBeNull();
		expect(s.users(key)).toBe(1);
		const second = s.acquire(key);
		expect(second?.baseUrl).toBe('http://127.0.0.1:5301');
		expect(second?.port).toBe(5301);
		expect(s.users(key)).toBe(2);
		second?.release();
		second?.release();
		expect(s.users(key)).toBe(1);
		first?.release();
		expect(s.users(key)).toBe(0);
	});

	it('never reuses a preview for a changed tree, pin, recipe, environment or registration', () => {
		const s = store();
		s.register(warmKey(parts), preview(), 'WEB');
		for (const changed of [
			{ treeId: 'abc123+d2' },
			{ pin: 'pin2' },
			{ recipeHash: 'rec2' },
			{ envHash: 'env2' },
			{ registration: 'LANDING' }
		])
			expect(s.acquire(warmKey({ ...parts, ...changed })), JSON.stringify(changed)).toBeNull();
		expect(s.acquire(warmKey(parts))).not.toBeNull();
	});

	it('keeps the preview for the time to live after the last user, then expires it', async () => {
		const s = store(60_000);
		const p = preview();
		const key = warmKey(parts);
		const lease = s.register(key, p, 'WEB');
		lease?.release();
		clock += 59_000;
		const again = s.acquire(key);
		expect(again).not.toBeNull();
		again?.release();
		// the time to live starts again at the last release
		clock += 59_000;
		s.acquire(key)?.release();
		clock += 61_000;
		expect(s.acquire(key)).toBeNull();
		expect(p.stopped).toBe(0);
		expect(await s.sweep()).toBe(1);
		expect(p.stopped).toBe(1);
	});

	it('stops an expired preview with no user, through its own handle, and removes its marker', async () => {
		const s = store(60_000);
		const p = preview();
		const key = warmKey(parts);
		s.register(key, p, 'WEB')?.release();
		clock += 61_000;
		expect(s.acquire(key)).toBeNull();
		expect(await s.sweep()).toBe(1);
		expect(p.stopped).toBe(1);
		expect(killed).toEqual([]);
		expect(existsSync(join(dir, `${key}.json`))).toBe(false);
		expect(s.list()).toEqual([]);
	});

	it('keeps an expired preview while a run still uses it', async () => {
		const s = store(60_000);
		const p = preview();
		const key = warmKey(parts);
		const lease = s.register(key, p, 'WEB');
		clock += 600_000;
		expect(await s.sweep()).toBe(0);
		expect(p.stopped).toBe(0);
		expect(s.acquire(key)).not.toBeNull();
		lease?.release();
	});

	it('does not count a user whose process is gone', () => {
		const s = store();
		const key = warmKey(parts);
		s.register(key, preview(), 'WEB');
		expect(s.users(key)).toBe(1);
		alive.delete(process.pid);
		expect(s.users(key)).toBe(0);
	});

	it('refuses to register over a usable preview, so two builds of one tree keep one', () => {
		const s = store();
		const key = warmKey(parts);
		expect(s.register(key, preview(4001), 'WEB')).not.toBeNull();
		expect(s.register(key, preview(4002), 'WEB')).toBeNull();
		expect(s.list()).toHaveLength(1);
		expect(s.list()[0]?.previewPid).toBe(4001);
	});

	it('replaces a marker whose owner is gone when a new preview registers', () => {
		const s = store();
		const key = warmKey(parts);
		s.register(key, preview(4001), 'WEB');
		alive.delete(4001);
		expect(s.acquire(key)).toBeNull();
		expect(s.register(key, preview(4003), 'WEB')).not.toBeNull();
		expect(s.list()[0]?.previewPid).toBe(4003);
	});

	it('doctor stops a preview whose owner died, by the recorded process id only', async () => {
		const owner = store();
		const key = warmKey(parts);
		const p = preview(4242);
		owner.register(key, p, 'WEB')?.release();
		// another process: a different store object on the same folder, the owner (this process in the fake) now gone
		const other = store();
		alive.delete(process.pid);
		alive.add(7777); // a process that is not in any marker
		expect(await other.sweep()).toBe(1);
		expect(killed).toEqual([4242]);
		expect(alive.has(7777)).toBe(true);
		expect(other.list()).toEqual([]);
	});

	it('does not kill a recorded process that is already gone', async () => {
		const s = store();
		const key = warmKey(parts);
		s.register(key, preview(4242), 'WEB')?.release();
		alive.delete(4242);
		const other = store();
		expect(await other.sweep()).toBe(1);
		expect(killed).toEqual([]);
	});

	it('stopAll stops what this process owns and removes the markers', async () => {
		const s = store();
		const a = preview(4001);
		const b = preview(4002);
		const ka = warmKey(parts);
		const kb = warmKey({ ...parts, registration: 'LANDING' });
		s.register(ka, a, 'WEB');
		s.register(kb, b, 'LANDING');
		expect(await s.stopAll()).toBe(2);
		expect(a.stopped + b.stopped).toBe(2);
		expect(s.list()).toEqual([]);
		expect(s.acquire(ka)).toBeNull();
	});

	it('ignores a damaged marker and a file that is not a key', async () => {
		const s = store();
		const key = warmKey(parts);
		s.register(key, preview(), 'WEB')?.release();
		const { writeFileSync } = await import('node:fs');
		writeFileSync(join(dir, `${'f'.repeat(40)}.json`), '{ nope');
		writeFileSync(join(dir, 'notes.json'), '{}');
		clock += 1_000;
		expect(await s.sweep()).toBe(0);
		expect(existsSync(join(dir, `${'f'.repeat(40)}.json`))).toBe(false);
		expect(existsSync(join(dir, 'notes.json'))).toBe(true);
		expect(() => s.acquire('../../x')).toThrow();
	});
});
