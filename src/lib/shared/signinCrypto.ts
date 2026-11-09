// ENCRYPTING A TEST ACCOUNT'S SIGN IN IN THE BROWSER, TO THE PUBLIC KEY OF ONE TOOL MACHINE (AFB-20261108-1444)
// Standard WebCrypto only, no home-made crypto: an ephemeral ECDH P-256 key agrees a secret with the machine's public key, HKDF-SHA256 turns it into an AES-256-GCM key, and the
// AES-GCM tag binds the ciphertext to the org, the runner, the registration and the key id (the associated data). The packages/bridge side (signinKey.ts) opens it the same way.
// The same text must be derived on both sides, so the format is written once, here, and mirrored there.

// -- CONSTANTS -- //

export const SIGNIN_ALG = 'ECDH-P256+HKDF-SHA256+AES-256-GCM';
/** The longest ciphertext text the board keeps. */
export const SIGNIN_MAX_CHARS = 3000;
/** The longest email and password typed (characters). */
export const SIGNIN_FIELD_MAX = 200;

// -- FUNCTIONS -- //

const enc = new TextEncoder();

export function toB64u(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(text: string): Uint8Array<ArrayBuffer> {
	const pad = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
	const bin = atob(pad);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** The text that binds a ciphertext to where it may be opened. Lower case registration, so the spelling does not matter. */
export const signinAad = (orgId: string, runnerId: string, registration: string, keyId: string) =>
	`afb-signin-v1|${orgId}|${runnerId}|${registration.toLowerCase()}|${keyId}`;

/** A short fingerprint of a public key (12 hex characters in groups of four), shown on the board and printed by the bridge so the owner can compare once. */
export async function fingerprintOf(publicKeyB64u: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64u(publicKeyB64u)));
	const hex = [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return hex.match(/.{4}/g)!.join('-');
}

/** Encrypts {email, password} to the machine's public key. The returned text is what the board keeps; the plain values never leave this function. */
export async function encryptSignin(
	publicKeyB64u: string,
	aad: string,
	account: { email: string; password: string }
): Promise<string> {
	const recipient = await crypto.subtle.importKey(
		'raw',
		fromB64u(publicKeyB64u),
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[]
	);
	const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveBits'
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'ECDH', public: recipient },
		ephemeral.privateKey,
		256
	);
	const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
	const key = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(aad) },
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt']
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
		key,
		enc.encode(JSON.stringify({ e: account.email, p: account.password }))
	);
	const epk = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
	return JSON.stringify({ v: 1, epk: toB64u(epk), iv: toB64u(iv), ct: toB64u(new Uint8Array(ct)) });
}
