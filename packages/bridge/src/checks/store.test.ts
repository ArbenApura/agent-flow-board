// TESTS OF THE SEALED STORE: ROUND TRIP, BOUND TO ITS TEXT, DAMAGE REFUSED, KEY CREATED ONCE OUTSIDE THE CHECKS FOLDER

// -- DEP-MODULES -- //
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { checksHome } from './paths.js';
import { seal, sealKeyFile, unseal } from './store.js';

// -- FUNCTIONS -- //

describe('sealed store', () => {
	let home = '';
	let before: string | undefined;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'afb-store-'));
		before = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});

	it('round-trips and lays the blob out as iv, tag, ciphertext', () => {
		const blob = seal('org/NAME', Buffer.from('hello value'));
		expect(blob.length).toBe(12 + 16 + 'hello value'.length);
		expect(Buffer.from(unseal('org/NAME', blob)).toString()).toBe('hello value');
		expect(Buffer.from(blob).includes(Buffer.from('hello'))).toBe(false);
	});

	it('uses a new iv for every seal', () => {
		const a = seal('x', Buffer.from('same'));
		const b = seal('x', Buffer.from('same'));
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
	});

	it('refuses a blob opened for another text', () => {
		const blob = seal('org/ONE', Buffer.from('v'));
		expect(() => unseal('org/TWO', blob)).toThrow(/sealed for something else|damaged/);
	});

	it('refuses a flipped byte and a too short blob', () => {
		const blob = Buffer.from(seal('a', Buffer.from('some value here')));
		blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
		expect(() => unseal('a', blob)).toThrow();
		expect(() => unseal('a', new Uint8Array(10))).toThrow(/too short/);
	});

	it('creates the key once, 32 bytes, in the bridge home and not inside the checks folder', () => {
		seal('a', Buffer.from('x'));
		const file = sealKeyFile();
		expect(file).toBe(join(home, 'checks.key'));
		expect(file.startsWith(checksHome() + sep)).toBe(false);
		const first = readFileSync(file);
		expect(first.length).toBe(32);
		seal('b', Buffer.from('y'));
		expect(readFileSync(file).equals(first)).toBe(true);
		if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
	});

	it('never overwrites a key that exists and names a damaged one without echoing it', () => {
		writeFileSync(join(home, 'checks.key'), 'short');
		expect(() => seal('a', Buffer.from('x'))).toThrow(/damaged/);
		expect(readFileSync(join(home, 'checks.key'), 'utf8')).toBe('short');
		expect(existsSync(join(home, 'checks.key'))).toBe(true);
	}, 10_000);
});
