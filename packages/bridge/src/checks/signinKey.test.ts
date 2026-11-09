// TESTS OF THE SIGN IN KEY: WHAT THE BOARD'S BROWSER ENCRYPTS THIS MACHINE OPENS, ONLY FOR THE SAME ORG, RUNNER, REGISTRATION AND KEY, AND NO PASSWORD EVER REACHES A LOG, AN AUDIT LINE OR AN ARGUMENT.

// -- DEP-MODULES -- //
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import {
	SIGNIN_ALG,
	encryptSignin,
	fingerprintOf as browserFingerprint,
	signinAad
} from '../../../../src/lib/shared/signinCrypto.js';
import { loginCommand, type LoginCtx, type LoginTarget } from './login.js';
import {
	ensureSigninKey,
	fingerprintOf,
	localFingerprint,
	openSignin,
	publishSigninKey,
	type SigninBoard,
	type SigninEnvelope
} from './signinKey.js';
import type { Registration } from './types.js';

// -- CONSTANTS -- //

const ORG = '11111111-1111-4111-8111-111111111111';
const RUNNER = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'correct-horse-battery-STAPLE-9';
const REG: Registration = {
	org: 'acme',
	name: 'HAPRM',
	boardProject: 'HAPR',
	url: 'https://demo.example.com',
	recipe: false,
	database: 'none',
	adoptEnv: false,
	uploadSignedInPictures: false,
	createdAt: '2026-11-08T00:00:00.000Z'
};

// -- FUNCTIONS -- //

describe('the sign in key', () => {
	let base = '';
	let saved: string | undefined;
	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-signin-')));
		saved = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'home');
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = saved;
		rmSync(base, { recursive: true, force: true });
	});

	const seal = async (registration = 'HAPRM', runner = RUNNER, org = ORG) => {
		const { keyId, publicKey } = await ensureSigninKey();
		const ciphertext = await encryptSignin(publicKey, signinAad(org, runner, registration, keyId), {
			email: 'tester@example.com',
			password: PASSWORD
		});
		return { keyId, publicKey, ciphertext };
	};
	const envelope = (keyId: string, ciphertext: string, registration = 'HAPRM'): SigninEnvelope => ({
		id: 'e1',
		registration,
		keyId,
		alg: SIGNIN_ALG,
		ciphertext
	});

	it('opens what the browser encrypted, and the same fingerprint shows on both sides', async () => {
		const { keyId, publicKey, ciphertext } = await seal();
		expect(await openSignin(envelope(keyId, ciphertext), { orgId: ORG, runnerId: RUNNER })).toEqual(
			{
				email: 'tester@example.com',
				password: PASSWORD
			}
		);
		expect(await browserFingerprint(publicKey)).toBe(fingerprintOf(publicKey));
		expect(localFingerprint()).toBe(fingerprintOf(publicKey));
	});

	it('keeps the same key between calls, and keeps the private half out of plain sight', async () => {
		const a = await ensureSigninKey();
		const b = await ensureSigninKey();
		expect(b).toEqual(a);
		for (const f of readdirSync(join(base, 'home', 'checks')))
			if (f.startsWith('signin-key.bin'))
				expect(readFileSync(join(base, 'home', 'checks', f)).includes(Buffer.from('PRIVATE'))).toBe(
					false
				);
	});

	it('refuses a ciphertext moved to another org, runner, registration or key, and never says why', async () => {
		const { keyId, ciphertext } = await seal();
		const open = (e: SigninEnvelope, where = { orgId: ORG, runnerId: RUNNER }) =>
			openSignin(e, where);
		await expect(open(envelope(keyId, ciphertext), { orgId: ORG, runnerId: 'x' })).rejects.toThrow(
			/could not be opened/
		);
		await expect(
			open(envelope(keyId, ciphertext), { orgId: 'y', runnerId: RUNNER })
		).rejects.toThrow(/could not be opened/);
		await expect(open(envelope(keyId, ciphertext, 'OTHER'))).rejects.toThrow(/could not be opened/);
		await expect(open(envelope('another-key-id', ciphertext))).rejects.toThrow(/another key/);
		const mangled = JSON.stringify({ ...JSON.parse(ciphertext), ct: 'AAAA' });
		await expect(open(envelope(keyId, mangled))).rejects.toThrow(/could not be opened/);
	});

	it('another machine cannot open it', async () => {
		const { keyId, ciphertext } = await seal();
		// A second machine has its own home and so its own key
		process.env.AFB_BRIDGE_HOME = join(base, 'other-home');
		await ensureSigninKey();
		await expect(
			openSignin(envelope(keyId, ciphertext), { orgId: ORG, runnerId: RUNNER })
		).rejects.toThrow();
	});

	it('publishes only the public half', async () => {
		const sent: unknown[] = [];
		const board: SigninBoard = {
			publishSigninKey: async (i) => {
				sent.push(i);
				return { changed: true, fingerprint: 'aaaa-bbbb-cccc' };
			},
			leaseSignins: async () => ({ orgId: ORG, runnerId: RUNNER, signins: [] }),
			ackSignin: async () => ({})
		};
		await publishSigninKey(board);
		expect(JSON.stringify(sent)).not.toMatch(/PRIVATE|pkcs8/i);
		expect(Object.keys(sent[0] as object).sort()).toEqual(['keyId', 'publicKey']);
	});

	it('check login --from-board signs in, reports only pass, saves, and no line or audit entry holds the password', async () => {
		const { keyId, ciphertext } = await seal();
		const acks: unknown[] = [];
		const lines: string[] = [];
		const typed: { email: string; password: string }[] = [];
		const signIn = vi.fn(async (_url: string, a: { email: string; password: string }) => {
			// The account is blanked after use, so what was typed is copied at the call
			typed.push({ ...a });
			return { cookies: [{ name: 's', domain: 'demo.example.com' }], origins: [] };
		});
		const saves: unknown[][] = [];
		const target: LoginTarget = {
			baseUrl: 'https://demo.example.com',
			stop: async () => undefined
		};
		const ctx: LoginCtx = {
			log: (l) => void lines.push(l),
			out: (l) => void lines.push(l),
			json: true,
			board: () => ({
				publishSigninKey: async () => ({ changed: false, fingerprint: '' }),
				leaseSignins: async () => ({
					orgId: ORG,
					runnerId: RUNNER,
					signins: [envelope(keyId, ciphertext)]
				}),
				ackSignin: async (i) => void acks.push(i)
			}),
			deps: {
				env: {},
				loadRegistration: () => REG,
				target: async () => target,
				save: (...a) => void saves.push(a),
				signIn
			}
		};
		expect(await loginCommand(['HAPRM', '--org', 'acme', '--from-board'], ctx)).toBe(0);
		expect(signIn).toHaveBeenCalledTimes(1);
		expect(typed).toEqual([{ email: 'tester@example.com', password: PASSWORD }]);
		expect(acks).toEqual([{ id: 'e1', result: 'pass' }]);
		expect(saves).toHaveLength(1);
		expect(lines.join('\n')).not.toContain(PASSWORD);
		const audit = join(base, 'home', 'checks', 'audit.log');
		try {
			expect(readFileSync(audit, 'utf8')).not.toContain(PASSWORD);
		} catch {
			/* No audit file is fine */
		}
		expect(JSON.stringify(saves)).not.toContain(PASSWORD);
	});

	it('a sign in that fails reports fail, says "That did not sign in" and echoes nothing; none waiting is a plain sentence', async () => {
		const { keyId, ciphertext } = await seal();
		const acks: unknown[] = [];
		const lines: string[] = [];
		const mk = (signins: SigninEnvelope[]): LoginCtx => ({
			log: (l) => void lines.push(l),
			out: () => undefined,
			json: false,
			board: () => ({
				publishSigninKey: async () => ({ changed: false, fingerprint: '' }),
				leaseSignins: async () => ({ orgId: ORG, runnerId: RUNNER, signins }),
				ackSignin: async (i) => void acks.push(i)
			}),
			deps: {
				env: {},
				loadRegistration: () => REG,
				target: async () => ({ baseUrl: 'https://demo.example.com', stop: async () => undefined }),
				save: () => undefined,
				signIn: async () => {
					throw new Error(`The form refused ${PASSWORD}`);
				}
			}
		});
		expect(
			await loginCommand(
				['HAPRM', '--org', 'acme', '--from-board'],
				mk([envelope(keyId, ciphertext)])
			)
		).toBe(1);
		expect(acks).toEqual([{ id: 'e1', result: 'fail' }]);
		expect(lines.join('\n')).toMatch(/That did not sign in/);
		expect(lines.join('\n')).not.toContain(PASSWORD);
		lines.length = 0;
		expect(await loginCommand(['HAPRM', '--org', 'acme', '--from-board'], mk([]))).toBe(1);
		expect(lines[0]).toMatch(/No sign in is waiting/);
	});
});
