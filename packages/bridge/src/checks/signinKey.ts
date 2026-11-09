// THE MACHINE'S SIGN IN KEY: A P-256 KEY PAIR WHOSE PUBLIC HALF IS PUBLISHED TO THE BOARD, SO THE OWNER CAN TYPE A TEST ACCOUNT'S PASSWORD ON THE BOARD WITHOUT ANY AGENT SEEING IT
// The private half lives in the same sealed store as the saved sign ins (AES-GCM under the key in the bridge home) and is opened only in this process. A password is decrypted in memory,
// goes to the page through Playwright `fill` and is never an argument, an environment variable, a log line or an audit line. The format mirrors src/lib/shared/signinCrypto.ts.
// Honest limit: a process that runs as the same OS user can read the key files, like every other local secret here.

// -- DEP-MODULES -- //
import { createHash, webcrypto } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { appendAudit } from './audit.js';
import { checksHome, ensureDir } from './paths.js';
import { seal, unseal } from './store.js';

// -- TYPES -- //

export type SigninEnvelope = {
	id: string;
	registration: string;
	keyId: string;
	alg: string;
	ciphertext: string;
};
export type SigninAccount = { email: string; password: string };
/** The calls of the board this file makes; tests inject a fake. */
export type SigninBoard = {
	publishSigninKey(input: {
		keyId: string;
		publicKey: string;
	}): Promise<{ changed: boolean; fingerprint: string }>;
	leaseSignins(
		registration: string
	): Promise<{ orgId: string; runnerId: string; signins: SigninEnvelope[] }>;
	ackSignin(input: { id: string; result: 'pass' | 'fail' }): Promise<unknown>;
};

// -- CONSTANTS -- //

export const SIGNIN_ALG = 'ECDH-P256+HKDF-SHA256+AES-256-GCM';
const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const keyFile = () => join(checksHome(), 'signin-key.bin');
const idFile = () => join(checksHome(), 'signin-key.id');
const AAD = 'signin-private-key';

// -- FUNCTIONS -- //

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const unb64u = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'));

/** The text that binds a ciphertext to where it may be opened. Must equal signinAad in src/lib/shared/signinCrypto.ts. */
export const signinAad = (orgId: string, runnerId: string, registration: string, keyId: string) =>
	`afb-signin-v1|${orgId}|${runnerId}|${registration.toLowerCase()}|${keyId}`;

/** Twelve hex characters in groups of four, the same rule as the board and the browser. */
export function fingerprintOf(publicKey: string): string {
	const hex = createHash('sha256')
		.update(Buffer.from(publicKey, 'base64url'))
		.digest('hex')
		.slice(0, 12);
	return hex.match(/.{4}/g)!.join('-');
}

/** Makes the key pair once and keeps the private half sealed. Returns the id and the public half. */
export async function ensureSigninKey(): Promise<{ keyId: string; publicKey: string }> {
	ensureDir(checksHome());
	if (existsSync(keyFile()) && existsSync(idFile())) {
		const pair = readPair();
		if (pair) return pair;
	}
	const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveBits'
	]);
	const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
	const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
	const keyId = b64u(webcrypto.getRandomValues(new Uint8Array(12)));
	writeFileSync(keyFile(), seal(AAD, pkcs8), { mode: 0o600 });
	writeFileSync(idFile(), JSON.stringify({ keyId, publicKey: b64u(pub) }), { mode: 0o600 });
	pkcs8.fill(0);
	appendAudit('signin key made', { keyId });
	return { keyId, publicKey: b64u(pub) };
}

function readPair(): { keyId: string; publicKey: string } | null {
	try {
		const v = JSON.parse(readFileSync(idFile(), 'utf8')) as {
			keyId?: unknown;
			publicKey?: unknown;
		};
		return typeof v.keyId === 'string' && typeof v.publicKey === 'string'
			? { keyId: v.keyId, publicKey: v.publicKey }
			: null;
	} catch {
		return null;
	}
}

/** Publishes the public key. The board accepts it only on this machine's own runner token; a changed key is shown there with its time. */
export async function publishSigninKey(
	board: SigninBoard
): Promise<{ fingerprint: string; changed: boolean }> {
	const { keyId, publicKey } = await ensureSigninKey();
	const done = await board.publishSigninKey({ keyId, publicKey });
	return done;
}

/** The fingerprint of this machine's key, for `check status`, or null when none was made yet. */
export function localFingerprint(): string | null {
	const pair = existsSync(idFile()) ? readPair() : null;
	return pair ? fingerprintOf(pair.publicKey) : null;
}

/** Opens one envelope in memory. A ciphertext for another org, runner, registration or key fails here, because the associated data differs. */
export async function openSignin(
	envelope: SigninEnvelope,
	where: { orgId: string; runnerId: string }
): Promise<SigninAccount> {
	const me = readPair();
	if (!me || me.keyId !== envelope.keyId || envelope.alg !== SIGNIN_ALG)
		throw new Error('That sign in was made for another key of this machine.');
	const pkcs8 = new Uint8Array(unseal(AAD, new Uint8Array(readFileSync(keyFile()))));
	let account: SigninAccount;
	try {
		const priv = await subtle.importKey(
			'pkcs8',
			pkcs8,
			{ name: 'ECDH', namedCurve: 'P-256' },
			false,
			['deriveBits']
		);
		const pack = JSON.parse(envelope.ciphertext) as {
			v: number;
			epk: string;
			iv: string;
			ct: string;
		};
		const peer = await subtle.importKey(
			'raw',
			unb64u(pack.epk),
			{ name: 'ECDH', namedCurve: 'P-256' },
			false,
			[]
		);
		const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, priv, 256);
		const aad = enc.encode(
			signinAad(where.orgId, where.runnerId, envelope.registration, envelope.keyId)
		);
		const base = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
		const key = await subtle.deriveKey(
			{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: aad },
			base,
			{ name: 'AES-GCM', length: 256 },
			false,
			['decrypt']
		);
		const plain = await subtle.decrypt(
			{ name: 'AES-GCM', iv: unb64u(pack.iv), additionalData: aad },
			key,
			unb64u(pack.ct)
		);
		const v = JSON.parse(new TextDecoder().decode(plain)) as { e?: unknown; p?: unknown };
		if (typeof v.e !== 'string' || typeof v.p !== 'string') throw new Error('shape');
		account = { email: v.e, password: v.p };
	} catch {
		// Never says why: nothing about the contents leaves this function
		throw new Error('That sign in could not be opened on this machine.');
	} finally {
		pkcs8.fill(0);
	}
	return account;
}
