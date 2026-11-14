// TESTS OF SAVED SIGN-INS: SEALED PER REGISTRATION AND SITE, BOUND BY AAD, NAMES ONLY IN A LISTING.

// IMPORTED DEP-MODULES
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// -- MOCKS -- //

// A stand-in for store.ts: the AAD is stored in front of the data, and unseal refuses another AAD, like AES-GCM would
vi.mock('./store.js', () => {
	const e = new TextEncoder();
	const d = new TextDecoder();
	return {
		seal: (aad: string, data: Uint8Array) => {
			const a = e.encode(aad);
			const out = new Uint8Array(4 + a.length + data.length);
			new DataView(out.buffer).setUint32(0, a.length);
			out.set(a, 4);
			out.set(
				data.map((b) => b ^ 0x5a),
				4 + a.length
			);
			return out;
		},
		unseal: (aad: string, blob: Uint8Array) => {
			const n = new DataView(blob.buffer, blob.byteOffset).getUint32(0);
			if (d.decode(blob.subarray(4, 4 + n)) !== aad) throw new Error('bad tag');
			return blob.subarray(4 + n).map((b) => b ^ 0x5a);
		}
	};
});

// IMPORTED MODULES
import { stateDirFor } from './paths.js';
import {
	expiryNote,
	fileNameFor,
	listProfiles,
	loadProfile,
	loadProfileChecked,
	removeProfile,
	saveProfile
} from './profiles.js';

// -- STATES -- //

let home: string;
const STATE = { cookies: [{ name: 's', value: 'cookie-value-123456', expires: -1 }], origins: [] };

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'afb-profiles-'));
	process.env.AFB_BRIDGE_HOME = home;
});
afterEach(() => {
	delete process.env.AFB_BRIDGE_HOME;
	rmSync(home, { recursive: true, force: true });
});

// -- FUNCTIONS -- //

describe('profiles', () => {
	it('saves under the registration state folder, sealed, named by a hash of the site', () => {
		const file = saveProfile('acme', 'HAPR', 'https://app.example.com', STATE);
		expect(file).toMatch(/^[0-9a-f]{16}\.enc$/);
		const path = join(stateDirFor('acme', 'HAPR'), 'profiles', file);
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path).toString('latin1')).not.toContain('cookie-value-123456');
		expect(loadProfile('acme', 'HAPR', 'https://app.example.com')?.state).toEqual(STATE);
	});

	it('is separate per registration', () => {
		saveProfile('acme', 'HAPR', 'https://a.example.com', STATE);
		expect(loadProfile('acme', 'HAPRD', 'https://a.example.com')).toBeNull();
		expect(loadProfile('other', 'HAPR', 'https://a.example.com')).toBeNull();
	});

	it('returns null for another site, and for a file moved to another site name (AAD mismatch)', () => {
		saveProfile('acme', 'HAPR', 'https://a.example.com', STATE);
		expect(loadProfile('acme', 'HAPR', 'https://b.example.com')).toBeNull();
		// Copy the sealed file under the hash of another site: the AAD no longer matches
		const dir = join(stateDirFor('acme', 'HAPR'), 'profiles');
		copyFileSync(
			join(dir, fileNameFor('https://a.example.com')),
			join(dir, fileNameFor('https://b.example.com'))
		);
		expect(loadProfile('acme', 'HAPR', 'https://b.example.com')).toBeNull();
	});

	it('returns null for a damaged file', () => {
		const file = saveProfile('acme', 'HAPR', 'https://a.example.com', STATE);
		writeFileSync(join(stateDirFor('acme', 'HAPR'), 'profiles', file), 'junk');
		expect(loadProfile('acme', 'HAPR', 'https://a.example.com')).toBeNull();
	});

	it('says a file is damaged, and that no file is not (C19)', () => {
		expect(loadProfileChecked('acme', 'HAPR', 'https://a.example.com')).toEqual({
			profile: null,
			damaged: false
		});
		const file = saveProfile('acme', 'HAPR', 'https://a.example.com', STATE);
		expect(loadProfileChecked('acme', 'HAPR', 'https://a.example.com').damaged).toBe(false);
		writeFileSync(join(stateDirFor('acme', 'HAPR'), 'profiles', file), 'junk');
		expect(loadProfileChecked('acme', 'HAPR', 'https://a.example.com')).toEqual({
			profile: null,
			damaged: true
		});
	});

	it('lists addresses and dates only, never a cookie', () => {
		saveProfile('acme', 'HAPR', 'https://a.example.com', STATE);
		saveProfile('acme', 'HAPR', 'https://b.example.com', STATE);
		const list = listProfiles('acme', 'HAPR');
		expect(list.map((p) => p.bindKey).sort()).toEqual([
			'https://a.example.com',
			'https://b.example.com'
		]);
		expect(JSON.stringify(list)).not.toContain('cookie-value');
		expect(listProfiles('acme', 'NONE')).toEqual([]);
	});

	it('removes by the exact file name only', () => {
		const file = saveProfile('acme', 'HAPR', 'https://a.example.com', STATE);
		expect(() => removeProfile('acme', 'HAPR', '../x.enc')).toThrow();
		expect(() => removeProfile('acme', 'HAPR', 'a.example.com')).toThrow();
		expect(removeProfile('acme', 'HAPR', file)).toBe(true);
		expect(loadProfile('acme', 'HAPR', 'https://a.example.com')).toBeNull();
		expect(listProfiles('acme', 'HAPR')).toEqual([]);
		expect(removeProfile('acme', 'HAPR', file)).toBe(false);
	});

	it('refuses a name that is not plain', () => {
		expect(() => saveProfile('acme', '../x', 'https://a', STATE)).toThrow();
		expect(() => saveProfile('Bad Org', 'HAPR', 'https://a', STATE)).toThrow();
	});
});

describe('expiryNote', () => {
	const at = (expires: number[]) => ({
		bindKey: 'x',
		savedAt: '',
		state: { cookies: expires.map((e) => ({ expires: e })) }
	});
	it('notes an expiry when every timed cookie is past', () => {
		expect(expiryNote(at([100, 200]))).toMatch(/expired/);
	});
	it('says nothing when one timed cookie is still good, or none is timed', () => {
		expect(expiryNote(at([100, Date.now() / 1000 + 3600]))).toBeNull();
		expect(expiryNote(at([-1]))).toBeNull();
		expect(expiryNote(null)).toBeNull();
	});
});
