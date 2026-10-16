// THE GITHUB APP MANIFEST AND THE SIGNED STATE OF THE INSTALL FLOW (SPEC 8)
// The person starts the install from a project page. The state carries who and which project, signed so it cannot be
// forged or replayed after ten minutes, and comes back with GitHub's installation id.

// -- CONSTANTS -- //

const STATE_TTL_MS = 10 * 60_000;
const enc = new TextEncoder();

// -- FUNCTIONS -- //

/**
 * The manifest an operator pastes into GitHub when creating the App (Settings, Developer settings, GitHub Apps, New).
 * Contents write access is what a publish needs, metadata read comes with every App.
 */
export function appManifest(baseUrl: string, name = 'agent-flow-board') {
	return {
		name,
		url: baseUrl,
		hook_attributes: { url: `${baseUrl}/github/webhook`, active: true },
		redirect_url: `${baseUrl}/github/callback`,
		setup_url: `${baseUrl}/github/callback`,
		setup_on_update: true,
		public: false,
		default_permissions: {
			contents: 'write',
			metadata: 'read',
			pull_requests: 'read',
			checks: 'write'
		},
		default_events: [
			'installation',
			'installation_repositories',
			'repository',
			'push',
			'pull_request'
		]
	};
}

const b64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
const fromB64url = (text: string) =>
	Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmac(secret: string, data: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export type InstallState = { orgId: string; projectId: string; userId: string; startedAt: number };

/** A state value that proves this server started the install for this person and project. */
export async function signState(
	secret: string,
	state: Omit<InstallState, 'startedAt'>,
	now = Date.now()
): Promise<string> {
	const body = b64url(enc.encode(JSON.stringify({ ...state, exp: now + STATE_TTL_MS })));
	return `${body}.${b64url(await hmac(secret, body))}`;
}

/** The state back again, or null when it was changed, is not ours, or has expired. */
export async function verifyState(
	secret: string,
	value: string,
	now = Date.now()
): Promise<InstallState | null> {
	const [body, sig] = value.split('.');
	if (!body || !sig) return null;
	const want = await hmac(secret, body);
	let got: Uint8Array;
	try {
		got = fromB64url(sig);
	} catch {
		return null;
	}
	if (got.length !== want.length) return null;
	let diff = 0;
	for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
	if (diff !== 0) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(fromB64url(body))) as InstallState & {
			exp: number;
		};
		if (typeof parsed.exp !== 'number' || parsed.exp < now) return null;
		if (!parsed.orgId || !parsed.projectId || !parsed.userId) return null;
		return {
			orgId: parsed.orgId,
			projectId: parsed.projectId,
			userId: parsed.userId,
			startedAt: parsed.exp - STATE_TTL_MS
		};
	} catch {
		return null;
	}
}

/** Where the person goes to install the App on a repository. */
export const installUrl = (webUrl: string, slug: string, state: string) =>
	`${webUrl.replace(/\/$/, '')}/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
