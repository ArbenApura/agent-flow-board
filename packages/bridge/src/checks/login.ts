// `check login <NAME> --org <slug> [--seeded]`: SAVING A SIGN-IN FOR A REGISTRATION'S SITE, AND THE RULES FOR USING ONE
// --seeded signs in with a seeded account (AFB_CHECKS_<NAME>_EMAIL and _PASSWORD) or the recipe's test user, through the app's own form.
// Without --seeded a person signs in by hand in a visible browser window on their own desktop. It needs the owner's `login` approval (a code, from the board or a terminal),
// used up before the window opens, and a desktop session to show the window on. The window is a fresh temporary browser profile with no debugging port, deleted afterwards,
// and the bridge does not return what is typed into it to the agent. The wait ends when a new session cookie of the site appears (or, for an app that keeps its session in the browser, a new localStorage key or IndexedDB database, or a changed session-like key), the window is closed, or the time runs out.
// Nothing here starts a preview itself: the caller injects `target`, and the sign in function is injected too, so tests launch no browser.
// A cookie, a password or a token is never printed.

// IMPORTED DEP-MODULES
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// IMPORTED TYPES
import type { Registration } from './types.js';
import type { ProfileMeta, SavedProfile } from './profiles.js';
// IMPORTED MODULES
import { consumeApproval, peekApproval } from './approve.js';
import { appendAudit } from './audit.js';
import { loadPlaywright } from './browser.js';
import { parseStartCommand } from './devPolicy.js';
import { ensureDevServer } from './devServer.js';
import { guardContext, type ContextLike } from './guard.js';
import { buildPreviewEnv } from './envPolicy.js';
import { pathOf, programArgv } from './install.js';
import { ORG_SLUG } from './paths.js';
import {
	assertProfileName,
	bindBaseFor,
	DEFAULT_PROFILE,
	expiryNote,
	loadProfileChecked,
	profileKey,
	saveProfile
} from './profiles.js';
import { needlesFromEnv, redact } from './redact.js';
import { findRegistration } from './registry.js';
import { newRunId, RunScope } from './scope.js';
import { openSignin, type SigninBoard } from './signinKey.js';
import { signInWithPassword } from './signin.js';

// -- TYPES -- //

type Account = { email: string; password: string };
/** The site a login happens on: a live address, or a preview the caller started (stop() ends it). */
export type LoginTarget = {
	baseUrl: string;
	/** The recipe's preview-only account, when the registration has one. */
	testUser?: Account | null;
	/** Hosts that belong to the site (cookies of these are kept by the headed login). */
	hosts?: string[];
	/** A repo preview's window may reach this machine's preview and the hosts above only: a link or a redirect to any other address is stopped. A live site's window is open (Google, two-factor). */
	restrictHosts?: boolean;
	/** The sealed test project the preview talks to (its hosts as one key), or null when it has none. */
	sealedHost?: string | null;
	/** The preview runs on a throwaway database: a saved sign-in would not exist in the next run, so no login is made. */
	throwawayDatabase?: boolean;
	/** The preview sends its sign-in mail to this one test inbox only: the owner pastes the link from there into the terminal. */
	mail?: { inbox: string } | null;
	stop(): Promise<void>;
};
/** How the headed window ended. Each has its own exit code: 0 signed in, 4 the window was closed, 5 the time ran out. */
export type HeadedOutcome =
	{ state: 'signed-in'; storage: unknown } | { state: 'closed' } | { state: 'timeout' };
export type LoginDeps = {
	signIn: (baseUrl: string, account: Account) => Promise<unknown>;
	/** The headed login: opens a window on the desktop, waits for the person, returns how it ended. Tests inject a stub. */
	headed: (
		target: LoginTarget,
		say: (line: string) => void,
		timeoutMs: number,
		ask: (prompt: string) => Promise<string>
	) => Promise<HeadedOutcome>;
	/** Reads one line the owner types or pastes in the terminal (the sign-in link of a mail login, or Enter). Tests inject a stub. */
	ask: (prompt: string) => Promise<string>;
	/** One line in the audit log: names only, never a value. */
	audit: (action: string, detail: Record<string, string | number | boolean>) => void;
	/** Null when this process can show a window to a person, else one plain sentence saying why not (a service, a remote shell). */
	desktop: () => string | null;
	/** The owner's login approval: checked first, used up before the window opens. */
	approval: {
		peek: (target: string, code: string) => boolean;
		consume: (target: string, code: string) => boolean;
	};
	env: Record<string, string | undefined>;
	loadRegistration: (org: string, name: string) => Registration | null;
	target: (registration: Registration, say: (line: string) => void) => Promise<LoginTarget>;
	save: (org: string, name: string, bindKey: string, state: unknown, meta?: ProfileMeta) => unknown;
	seedFromUrl?: (
		baseUrl: string,
		seedUrl: string,
		profile: string,
		extraHosts?: string[]
	) => Promise<unknown>;
	seedCommand?: (
		argv: string[],
		opts: { cwd: string; env: NodeJS.ProcessEnv; needles: string[] }
	) => Promise<void>;
};
export type LoginCtx = {
	/** This machine's board, for a sign in typed on the board (--from-board). */
	board?: () => SigninBoard;
	log(line: string): void;
	out(line: string): void;
	json: boolean;
	deps?: Partial<LoginDeps>;
};

// -- CONSTANTS -- //

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
/** The window waits this long for a sign in (minutes), unless --timeout says otherwise. */
const DEFAULT_TIMEOUT_MINUTES = 5;

// -- FUNCTIONS -- //

/** The variable names of a registration: AFB_CHECKS_<NAME upper, dash to underscore>_EMAIL and _PASSWORD. */
export function envNames(name: string): { email: string; password: string } {
	const n = String(name).toUpperCase().replace(/-/g, '_');
	return { email: `AFB_CHECKS_${n}_EMAIL`, password: `AFB_CHECKS_${n}_PASSWORD` };
}

/** The seeded account of a registration (and optional profile) from the environment, or null when missing. */
export function seededAccount(
	name: string,
	env: Record<string, string | undefined> = process.env,
	profile?: string
): Account | null {
	if (profile && profile !== DEFAULT_PROFILE) {
		const p = String(profile)
			.toUpperCase()
			.replace(/[^A-Z0-9]/g, '_');
		const n = String(name).toUpperCase().replace(/-/g, '_');
		const pEmail = env[`AFB_CHECKS_${n}_${p}_EMAIL`];
		const pPass = env[`AFB_CHECKS_${n}_${p}_PASSWORD`];
		if (pEmail && pPass) return { email: pEmail, password: pPass };
	}
	const n = envNames(name);
	const email = env[n.email];
	const password = env[n.password];
	return email && password ? { email, password } : null;
}

/**
 * Whether a run uses a saved sign-in. Only when the script's header (or the check) names the very registration the run uses: a run that was
 * routed there by a fallback, or a script that names another registration, opens signed out. Names compare without regard to case.
 */
export function chooseState(input: {
	registration: string;
	scriptRegistration: string | null | undefined;
	profile: SavedProfile | null;
}): 'saved' | 'none' {
	const { registration, scriptRegistration, profile } = input;
	if (!profile || !scriptRegistration || !registration) return 'none';
	return scriptRegistration.toLowerCase() === registration.toLowerCase() ? 'saved' : 'none';
}

/** Pictures of a signed-in run are uploaded only when the owner opted in on the registration. A signed-out run uploads as usual. */
export function pictureUploadAllowed(
	registration: Pick<Registration, 'uploadSignedInPictures'>,
	signedIn: boolean
): boolean {
	return !signedIn || registration.uploadSignedInPictures === true;
}

/** The saved sign-in a run should open with, with the expiry note, or null. Applies chooseState. */
export function savedStateFor(input: {
	org: string;
	registration: string;
	scriptRegistration: string | null | undefined;
	bindKey: string;
}): { profile: SavedProfile | null; note: string | null } | null {
	const { profile, damaged } = loadProfileChecked(input.org, input.registration, input.bindKey);
	// A saved sign-in that cannot be opened says so: the run would otherwise go signed out and fail on a sign-in page with no explanation
	if (damaged)
		return {
			profile: null,
			note: 'The saved sign-in is damaged, make it again (agent-flow-board check login).'
		};
	if (chooseState({ ...input, profile }) !== 'saved' || !profile) return null;
	return { profile, note: expiryNote(profile) };
}

/** Cookies and origins that belong to the site's hosts, nothing else (no other site's sign-in is saved). */
export function keepRelated(
	state: unknown,
	hosts: string[]
): { cookies: unknown[]; origins: unknown[] } {
	const s = state as {
		cookies?: { domain?: string }[];
		origins?: { origin?: string }[];
	} | null;
	const bare = (d: string) => d.replace(/^\./, '').toLowerCase();
	const related = (d: string) =>
		hosts.some((h) => {
			const a = bare(d);
			const b = h.toLowerCase();
			return a === b || b.endsWith(`.${a}`) || a.endsWith(`.${b}`);
		});
	return {
		cookies: (s?.cookies ?? []).filter((c) => related(String(c.domain ?? ''))),
		origins: (s?.origins ?? []).filter((o) => {
			try {
				return related(new URL(String(o.origin)).hostname);
			} catch {
				return false;
			}
		})
	};
}

/**
 * Whether this process can show a window to a person: null when it can. On Windows a service has no console session name; on Linux a desktop sets DISPLAY or WAYLAND_DISPLAY;
 * on a Mac a shell opened over SSH is not the desktop. Otherwise one plain sentence says why a window cannot be shown.
 */
export function desktopProblem(
	env: Record<string, string | undefined> = process.env,
	platform: string = process.platform
): string | null {
	const none =
		'This process has no desktop to show a window on (for example it runs as a service or over a remote shell). Run the login from a terminal opened on the computer itself.';
	if (platform === 'win32') return env.SESSIONNAME ? null : none;
	if (platform === 'darwin') return env.SSH_CONNECTION || env.SSH_TTY ? none : null;
	return env.DISPLAY || env.WAYLAND_DISPLAY ? null : none;
}

/** A cookie is told apart by its name and domain, never by its value. */
const cookieId = (c: unknown) => {
	const k = c as { name?: string; domain?: string };
	return `${k.domain ?? ''}|${k.name ?? ''}`;
};

/** Names of a localStorage key or IndexedDB database that hold a session (supabase-js sb-<ref>-auth-token, firebase, plain auth, token or session names). */
const SESSION_KEY = /^sb-|auth|token|session|jwt|firebaseLocalStorage/i;

/**
 * What the site keeps in the browser besides cookies: every localStorage key with its value, and the IndexedDB database names, per origin.
 * Only the keys and a comparison are used, the values are never printed or returned.
 */
export function storageMarks(state: unknown): Map<string, string> {
	const marks = new Map<string, string>();
	const s = state as {
		origins?: {
			origin?: string;
			localStorage?: { name?: string; value?: string }[];
			indexedDB?: { name?: string }[];
		}[];
	} | null;
	for (const o of s?.origins ?? []) {
		for (const item of o.localStorage ?? [])
			marks.set(`ls|${o.origin ?? ''}|${item.name ?? ''}`, String(item.value ?? ''));
		for (const db of o.indexedDB ?? []) marks.set(`idb|${o.origin ?? ''}|${db.name ?? ''}`, '');
	}
	return marks;
}

/**
 * Whether the browser now holds a sign-in it did not hold when the page loaded: a new cookie, a new session-named localStorage key or IndexedDB database,
 * or a changed value of a session-named key. Any other key, or a key that was already there with the same value, is not a sign-in.
 * A session kept only in sessionStorage is not seen, and the window then times out with nothing saved.
 */
export function gainedSignin(
	before: { cookies: Set<string>; marks: Map<string, string> },
	now: { cookies: unknown[]; origins: unknown[] }
): boolean {
	if (now.cookies.some((c) => !before.cookies.has(cookieId(c)))) return true;
	for (const [key, value] of storageMarks(now)) {
		// Only a key or database named like a session counts: an app writes theme, locale, analytics and flag keys by itself after the page loads
		const name = key.split('|').slice(2).join('|');
		if (!SESSION_KEY.test(name)) continue;
		const old = before.marks.get(key);
		if (old === undefined || (key.startsWith('ls|') && old !== value)) return true;
	}
	return false;
}

/**
 * The hosts a repo preview's window may reach: the preview itself WITH its port (another service on this machine, such as a dev server, is not the preview) and the sealed test
 * project's hosts. A request or link is compared by its `host` (name and port).
 */
export function allowedHosts(target: Pick<LoginTarget, 'baseUrl' | 'hosts'>): string[] {
	return [new URL(target.baseUrl).host, ...(target.hosts ?? [])].map((h) => h.toLowerCase());
}

/**
 * Why a pasted sign-in link must not be opened, or null when it may be: it has to be a web address on the preview or one of its sealed hosts. The link is a one-time
 * credential written by someone else's mail, so it is never printed, and nothing else is followed.
 */
export function linkProblem(link: string, allowed: string[]): string | null {
	let u: URL;
	try {
		u = new URL(link.trim());
	} catch {
		return 'That is not a web address. Paste the whole sign-in link from the test inbox, or press Enter when you are signed in.';
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:')
		return 'Only a web address can be opened. Paste the sign-in link from the test inbox.';
	if (!allowed.includes(u.host.toLowerCase()))
		return 'That link points to an address that is not this preview or its test project, so it was not opened.';
	return null;
}

/** Reads one line from the owner's terminal. A window that waits for a pasted link needs a person at a terminal. */
async function askLine(prompt: string): Promise<string> {
	if (!process.stdin.isTTY)
		throw new Error(
			'This sign-in waits for a link pasted into the terminal, so it needs to run in a terminal the owner can type in.'
		);
	const { createInterface } = await import('node:readline/promises');
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await rl.question(prompt);
	} finally {
		rl.close();
	}
}

/** Waits for the owner's line, but only until the deadline or until the window is closed (`closedWindow` resolves). */
async function askUntil(
	ask: (prompt: string) => Promise<string>,
	prompt: string,
	deadline: number,
	closedWindow: Promise<null>
): Promise<string | null> {
	const left = deadline - Date.now();
	if (left <= 0) return null;
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			ask(prompt),
			closedWindow,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), left);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * The headed login: a visible browser in a fresh temporary profile (no debugging port, deleted afterwards). Only cookies and origins of the site are kept.
 * A live site's window ends when a session cookie of the site appears that was not there when the page loaded, when the window is closed, or when the time runs out.
 * A repo preview's window can reach only the preview and its sealed test project. When the preview sends its sign-in mail to one test inbox (`target.mail`), the owner asks
 * for the link in the window, copies it from that inbox and pastes it into the terminal; the window then ends on the owner's Enter, never on the first cookie (asking for the
 * link already sets one).
 */
async function headedLogin(
	target: LoginTarget,
	say: (line: string) => void,
	timeoutMs: number,
	ask: (prompt: string) => Promise<string> = askLine
): Promise<HeadedOutcome> {
	const { chromium } = await loadPlaywright();
	const profile = mkdtempSync(join(tmpdir(), 'afb-login-'));
	const hosts = [new URL(target.baseUrl).hostname, ...(target.hosts ?? [])];
	const allowed = allowedHosts(target);
	let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
	try {
		context = await chromium.launchPersistentContext(profile, {
			headless: false,
			viewport: null,
			baseURL: target.baseUrl
		});
		let closed = false;
		// Resolves when the window is closed, so a wait for the owner's line ends at once and the preview is stopped
		const closedWindow = new Promise<null>((resolve) => {
			context?.on('close', () => {
				closed = true;
				resolve(null);
			});
		});
		// A repo preview holds a live session of the test project: nothing outside the preview and that project may be reached from this window
		if (target.restrictHosts)
			await context.route('**/*', (route) => {
				const u = route.request().url();
				if (u.startsWith('data:') || u.startsWith('blob:') || u === 'about:blank')
					return route.continue();
				try {
					return allowed.includes(new URL(u).host.toLowerCase()) ? route.continue() : route.abort();
				} catch {
					return route.abort();
				}
			});
		const page = context.pages()[0] ?? (await context.newPage());
		await page.goto(target.baseUrl);
		// An app writes some keys right after the load event, so the baseline waits for the network to settle first
		await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
		await new Promise((r) => setTimeout(r, 1500));
		// IndexedDB is read too: an app that keeps its session there sets no cookie and no localStorage key
		const beforeState = keepRelated(await context.storageState({ indexedDB: true }), hosts);
		const before = {
			cookies: new Set(beforeState.cookies.map(cookieId)),
			marks: storageMarks(beforeState)
		};
		say(
			`A browser window is open on ${target.baseUrl}. Sign in there the way you normally do (a password or Google). The bridge does not return what you type to your agent.`
		);
		if (target.mail) {
			say(
				`This preview sends mail only to ${target.mail.inbox}. Ask for a sign-in link in the window with any address, open that inbox, copy the link and paste it here. When you can see you are signed in, press Enter with nothing pasted. Do not close the window first.`
			);
			const mailDeadline = Date.now() + timeoutMs;
			while (!closed && Date.now() < mailDeadline) {
				const line = await askUntil(
					ask,
					'Paste the sign-in link, or press Enter when you are signed in... ',
					mailDeadline,
					closedWindow
				);
				if (line === null) break;
				if (closed) break;
				if (line.trim()) {
					const problem = linkProblem(line, allowed);
					if (problem) {
						say(problem);
						continue;
					}
					await page
						.goto(line.trim())
						.catch(() => say('The window could not open the link (it may have expired).'));
					say('The link was opened in the window.');
					continue;
				}
				let kept: { cookies: unknown[]; origins: unknown[] };
				try {
					kept = keepRelated(await context.storageState({ indexedDB: true }), hosts);
				} catch {
					break;
				}
				if (!gainedSignin(before, kept)) {
					say('Nothing is signed in yet. Open the link in the window first, then press Enter.');
					continue;
				}
				return { state: 'signed-in', storage: kept };
			}
			return closed ? { state: 'closed' } : { state: 'timeout' };
		}
		const deadline = Date.now() + timeoutMs;
		while (!closed && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 1000));
			if (closed) break;
			let kept: { cookies: unknown[]; origins: unknown[] };
			try {
				kept = keepRelated(await context.storageState({ indexedDB: true }), hosts);
			} catch {
				break;
			}
			if (gainedSignin(before, kept)) {
				// A short settle, so a sign in that sets several cookies or keys is kept whole
				await new Promise((r) => setTimeout(r, 2000));
				return {
					state: 'signed-in',
					storage: keepRelated(await context.storageState({ indexedDB: true }), hosts)
				};
			}
		}
		return closed ? { state: 'closed' } : { state: 'timeout' };
	} finally {
		await context?.close().catch(() => undefined);
		rmSync(profile, { recursive: true, force: true });
	}
}

/** Default one-line URL seeder: opens seedUrl only on baseUrl's origin in a throwaway context and returns storage state. */
async function defaultSeedFromUrl(
	baseUrl: string,
	seedUrl: string,
	_profile?: string,
	extraHosts: string[] = []
): Promise<unknown> {
	const base = new URL(baseUrl);
	const seed = new URL(seedUrl, base);
	if (seed.origin !== base.origin) {
		throw new Error(`Seed URL origin ${seed.origin} does not match target ${base.origin}.`);
	}
	const { chromium } = await loadPlaywright();
	const browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext();
		// The app may validate the session against its data host (extra hosts of the registration), so those are reachable, read-only like a normal run; every other host and every write is stopped
		await guardContext(context as unknown as ContextLike, {
			origin: base.origin,
			extraHosts
		});
		const page = await context.newPage();
		await page.goto(seed.toString(), { waitUntil: 'networkidle', timeout: 15_000 }).catch(() => {});
		return await context.storageState({ indexedDB: true });
	} finally {
		await browser.close();
	}
}

/** Default one-line demo DB seed command runner: shell:false, filtered env, redacted error output. */
function defaultSeedCommand(
	argv: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; needles: string[] }
): Promise<void> {
	const [file, ...rest] = programArgv(argv, { pathEnv: pathOf(opts.env) });
	if (!file) return Promise.reject(new Error('Seed command has no executable program.'));
	return new Promise((resolve, reject) => {
		execFile(
			file,
			rest,
			{ cwd: opts.cwd, env: opts.env, windowsHide: true, timeout: 60_000 },
			(err, _stdout, stderr) => {
				if (!err) return resolve();
				const msg = redact(String(stderr || err.message || 'Seed command failed.'), opts.needles);
				reject(new Error(msg.slice(0, 200)));
			}
		);
	});
}

/** The default target: a dev registration probes/starts its dev server; a live site uses its address; a repo registration starts its preview. */
async function defaultTarget(
	registration: Registration,
	say: (line: string) => void
): Promise<LoginTarget> {
	if (registration.devUrl) {
		const scope = new RunScope(newRunId(), say);
		try {
			const dev = await ensureDevServer(registration, scope, { log: say });
			return {
				baseUrl: dev.origin,
				hosts: registration.extraHosts ?? [],
				stop: () => scope.close()
			};
		} catch (e) {
			await scope.close().catch(() => undefined);
			throw e;
		}
	}
	if (!registration.url) {
		const { repoLoginTarget } = await import('./loginPreview.js');
		return repoLoginTarget(registration, say);
	}
	return {
		baseUrl: registration.url,
		hosts: registration.extraHosts ?? [],
		stop: async () => undefined
	};
}

function flagValue(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	if (i < 0) return undefined;
	const next = args[i + 1];
	return next !== undefined && !next.startsWith('--') ? next : undefined;
}

/** `check login <NAME> --org <slug> [--profile P] [--seeded [url|cmd]]`. Exit code 0 saved, 1 a problem with what was asked, 2 could not run. */
export async function loginCommand(args: string[], ctx: LoginCtx): Promise<number> {
	const deps: LoginDeps = {
		signIn: (baseUrl, account) => signInWithPassword(baseUrl, account),
		headed: headedLogin,
		desktop: () => desktopProblem(),
		approval: {
			peek: (target, code) => peekApproval('login', target, code),
			consume: (target, code) => consumeApproval('login', target, code)
		},
		env: process.env,
		loadRegistration: findRegistration,
		target: defaultTarget,
		save: saveProfile,
		ask: askLine,
		audit: (action, detail) => {
			try {
				appendAudit(action, detail);
			} catch {
				/* The audit log is best effort here: a login is never refused for it */
			}
		},
		...ctx.deps
	};
	const say = (line: string) => ctx.log(line);
	const flags = new Set(['--org', '--as', '--profile', '--approval', '--timeout']);
	const seededIdx = args.indexOf('--seeded');
	const seededEquals = args.find((a) => a.startsWith('--seeded='));
	const nextAfterSeeded =
		seededIdx >= 0 && seededIdx + 1 < args.length ? args[seededIdx + 1] : undefined;
	// Treat the token after `--seeded` as its value when it looks like a URL or command (never swallowing bare positional <NAME> when boolean `--seeded` is used before NAME).
	const consumeSeededNext = Boolean(
		nextAfterSeeded &&
		!nextAfterSeeded.startsWith('--') &&
		(/^(https?:\/\/)/i.test(nextAfterSeeded) || /[\s/\\:]/.test(nextAfterSeeded))
	);
	const positional = args.filter(
		(a, i) =>
			!a.startsWith('--') &&
			!flags.has(args[i - 1] ?? '') &&
			!(consumeSeededNext && i === seededIdx + 1)
	);
	const name = positional[0];
	const org = flagValue(args, '--org');
	const seeded = args.some((a) => a === '--seeded' || a.startsWith('--seeded='));
	const seededArg = seededEquals
		? seededEquals.slice('--seeded='.length)
		: consumeSeededNext
			? nextAfterSeeded
			: undefined;
	// The sign in the owner typed on the board, encrypted to this machine: opened here in memory, never shown to the agent
	const fromBoard = args.includes('--from-board');
	if (!name || !org) {
		say(
			'Usage: check login <NAME> --org <slug> [--profile <profile>] [--seeded [url|cmd] | --from-board | --approval <code>]'
		);
		return 1;
	}
	if (!NAME.test(name) || !ORG_SLUG.test(org)) {
		say('The registration name or the organisation is not a plain name.');
		return 1;
	}
	// A second sign-in of the same registration (a role to prove, for example patient, doctor, staff) is a named profile
	let profile: string;
	try {
		profile = assertProfileName(
			flagValue(args, '--profile') ?? flagValue(args, '--as') ?? DEFAULT_PROFILE
		);
	} catch (e) {
		say(e instanceof Error ? e.message : 'That is not a profile name.');
		return 1;
	}
	// A headed login shows a window to a person: it needs the owner's login approval and a desktop to show it on, and stops at once without either
	const approval = flagValue(args, '--approval');
	const minutes = flagValue(args, '--timeout');
	const timeoutMinutes = minutes === undefined ? DEFAULT_TIMEOUT_MINUTES : Number(minutes);
	if (fromBoard && !ctx.board) {
		say('Reading a sign in from the board needs the check command with --server and --org.');
		return 1;
	}
	if (!seeded && !fromBoard) {
		if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 30) {
			say('--timeout takes a number of minutes from 1 to 30.');
			return 1;
		}
		const problem = deps.desktop();
		if (problem) {
			say(problem);
			return 1;
		}
		if (!approval || !deps.approval.peek(`${org}/${name}`, approval)) {
			say(
				approval
					? `That code is not a login approval for ${org}/${name}: a code works once, for 10 minutes, and only for the exact target it was asked for. Ask for a new one: agent-flow-board check approve --request --action login --target ${org}/${name}, then pass --approval <code>.`
					: `Signing in by hand needs the owner's approval. Ask for it: agent-flow-board check approve --request --action login --target ${org}/${name}, then pass --approval <code>. Or use --seeded with AFB_CHECKS_<NAME>_EMAIL and AFB_CHECKS_<NAME>_PASSWORD set.`
			);
			return 1;
		}
	}
	const registration = deps.loadRegistration(org, name);
	if (!registration || registration.org !== org) {
		say(`No registration "${name}" in ${org}.`);
		return 1;
	}
	let target: LoginTarget | null = null;
	const secrets: string[] = [];
	try {
		target = await deps.target(registration, say);
		// A repo registration's sign-in is bound to the loopback and its sealed test project, never to the port of this preview
		if (registration.repo && target.throwawayDatabase) {
			say(
				`The preview of ${name} runs on a throwaway database, so a saved sign-in would not exist in the next run. A recipe test user signs in by itself on every run; to keep a person's sign-in, seal the registration's test project first (check secrets import).`
			);
			return 1;
		}
		if (registration.repo && (seeded || fromBoard) && !target.sealedHost) {
			say(
				`A seeded sign-in on ${name} needs the registration's sealed test project, so the password is never typed into a preview that talks to another database. Seal it first (check secrets import).`
			);
			return 1;
		}
		const bindKey = profileKey(bindBaseFor(registration, new URL(target.baseUrl).origin), profile);
		let state: unknown;
		if (fromBoard && ctx.board) {
			const board = ctx.board();
			const leased = await board.leaseSignins(name);
			const envelope = leased.signins.find(
				(e) => e.registration.toLowerCase() === name.toLowerCase()
			);
			if (!envelope) {
				say(
					`No sign in is waiting on the board for ${name}. Run the login without --from-board to sign in in a window on this computer.`
				);
				return 1;
			}
			let account: Awaited<ReturnType<typeof openSignin>> | null = null;
			try {
				account = await openSignin(envelope, { orgId: leased.orgId, runnerId: leased.runnerId });
				secrets.push(account.password);
				state = await deps.signIn(target.baseUrl, account);
			} catch (e) {
				// Only pass or fail goes back to the board, and the message never holds what was typed
				await board.ackSignin({ id: envelope.id, result: 'fail' }).catch(() => undefined);
				say(
					`That did not sign in. ${redact(e instanceof Error ? e.message : '', secrets).slice(0, 160)}`
				);
				return 1;
			} finally {
				if (account) account.password = '';
			}
			await board.ackSignin({ id: envelope.id, result: 'pass' }).catch(() => undefined);
		} else if (seeded) {
			if (seededArg && /^https?:\/\//i.test(seededArg)) {
				const base = new URL(target.baseUrl);
				let parsedSeed: URL;
				try {
					parsedSeed = new URL(seededArg);
				} catch {
					say('That --seeded URL is not a valid address.');
					return 1;
				}
				if (parsedSeed.origin !== base.origin) {
					say(
						`Seeded URL origin ${parsedSeed.origin} must match the registration target ${base.origin}.`
					);
					return 1;
				}
				state = await (deps.seedFromUrl ?? defaultSeedFromUrl)(
					target.baseUrl,
					parsedSeed.toString(),
					profile,
					target.hosts ?? registration.extraHosts ?? []
				);
			} else {
				if (seededArg) {
					if (!approval || !deps.approval.consume(`${org}/${name}`, approval)) {
						say(
							`Running a local --seeded command requires a fresh single-use owner approval. Ask for it: agent-flow-board check approve --request --action login --target ${org}/${name}, then pass --approval <code>.`
						);
						return 1;
					}
					const argv = parseStartCommand(seededArg);
					const cwd = registration.repo ?? process.cwd();
					const port = Number(new URL(target.baseUrl).port) || 3000;
					const filtered = buildPreviewEnv({
						repo: cwd,
						recipeEnv: {},
						port,
						baseUrl: target.baseUrl,
						readRepoEnv: false
					});
					const needles = [...needlesFromEnv(process.env), ...needlesFromEnv(filtered.env)];
					await (deps.seedCommand ?? defaultSeedCommand)(argv, {
						cwd,
						env: filtered.env,
						needles
					});
				}
				const account = seededAccount(name, deps.env, profile) ?? target.testUser ?? null;
				if (!account) {
					const n = envNames(name);
					say(
						`No account to sign in with. Set ${n.email} and ${n.password}, or pass a same-origin --seeded URL.`
					);
					return 1;
				}
				secrets.push(account.password);
				state = await deps.signIn(target.baseUrl, account);
			}
		} else {
			// A mailed-link sign-in reads the pasted link from a terminal. Without one the window could never finish, so say it
			// before the code is used up: the same code still works when the owner runs the command
			if (target.mail && deps.ask === askLine && !process.stdin.isTTY) {
				say(
					`${name} signs in by a mailed link, which the owner pastes into a terminal. This is not a terminal a person can type in, so nothing was opened and the code was not used. The owner runs this one command in their own terminal within the code's 10 minutes: agent-flow-board check login ${name} --org ${org} --approval <code>.`
				);
				return 1;
			}
			// The approval is used up before the window opens, so a window never opens twice on one code
			if (!deps.approval.consume(`${org}/${name}`, approval ?? '')) {
				say('The owner code was used or ran out just now. Ask for a new one.');
				return 1;
			}
			const outcome = await deps.headed(target, say, timeoutMinutes * 60_000, deps.ask);
			if (outcome.state === 'closed') {
				say('The window was closed before a sign in was seen, so nothing was saved.');
				return 4;
			}
			if (outcome.state === 'timeout') {
				say(`No sign in was seen within ${timeoutMinutes} minutes, so nothing was saved.`);
				return 5;
			}
			state = outcome.storage;
		}
		const kept = state as { cookies?: unknown[]; origins?: unknown[] } | null;
		if (!kept || (!(kept.cookies?.length ?? 0) && !(kept.origins?.length ?? 0))) {
			say('Nothing was saved because the browser holds no sign-in for this address.');
			return 1;
		}
		deps.save(org, name, bindKey, state, {
			profile,
			sealedHost: registration.repo ? (target.sealedHost ?? null) : null
		});
		deps.audit('login saved', { registration: `${org}/${name}`, profile });
		const shown = registration.repo ? `${bindKey} (${name})` : bindKey;
		say(
			`Saved the sign-in${profile === DEFAULT_PROFILE ? '' : ` "${profile}"`} for ${org}/${name} on ${shown}. It stays on this machine, sealed.`
		);
		if (ctx.json)
			ctx.out(
				JSON.stringify({ saved: true, registration: `${org}/${name}`, profile, site: bindKey })
			);
		return 0;
	} catch (e) {
		say(redact(e instanceof Error ? e.message : String(e), secrets));
		return 2;
	} finally {
		await target?.stop().catch(() => undefined);
	}
}
