// DEV-TARGET POLICY: LOCAL-ONLY DEV URLS, CROSS-HOST REDIRECT BLOCKS, WRITE ALLOWLIST, AND HASH-BOUND APPROVAL TARGETS (AFB-20261113-1008)

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { parseEnvText } from './envPolicy.js';
import { databaseProblems } from './envrules.js';
import { FORBIDDEN_PORTS } from './guardrails.js';

// -- TYPES -- //

export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type WriteMethod = (typeof WRITE_METHODS)[number];

export type WriteRule = {
	method: WriteMethod;
	pathPrefix: string;
	/** Absent: the dev origin only. Present (host or host:port): that one registered extra host only, for example a read-only RPC POST to a data host. */
	host?: string;
};

export type DevHashInput = {
	devUrl: string;
	startCommand?: string[];
	allowWrites?: boolean;
	writeAllowlist?: WriteRule[];
};

export type DevProbeResult =
	| { ok: true; status: number; url: string; mode?: 'vite' | 'fallback' }
	| { ok: false; code: 'DEV_URL_UNREACHABLE' | 'DEV_CROSS_HOST_REDIRECT'; message: string };

export const DEV_WRITE_GUARD_NOTE =
	'Browser-layer only (service workers blocked, all HTTP methods, sendBeacon and WebSocket routed through the guard). A write to an extra host passes only when an allowlist entry names that host, method and path.';

export const DEV_STATUS_FIX_LINES: Record<string, string> = {
	DEV_URL_REACHABLE: 'Dev server is reachable.',
	DEV_URL_UNREACHABLE:
		'Start the local dev server or add a sealed --start command with dev approval.',
	DEV_CROSS_HOST_REDIRECT:
		'Point --dev-url at an origin that does not redirect to another host or port.',
	DEV_START_FAILED: 'Check the dev server command and dependencies, then run the check again.',
	DEV_START_TIMEOUT:
		'Confirm the dev server listens on the registered --dev-url port within the startup window.',
	DEV_OVERLAY_ERROR:
		'Fix the compiler or runtime error shown by the dev server overlay and re-run.',
	DEV_HMR_DISCONNECTED: 'Ensure the Vite dev server is running and reload the page.',
	DEV_HMR_PENDING: 'Wait for active Vite HMR updates to settle or fix the failing module update.',
	DEV_NETWORK_BUSY: 'Check for hanging API requests or continuous polling on the screen.',
	DEV_PROFILE_MISSING:
		'Save a dev sign-in with: agent-flow-board check login <NAME> --profile <PROFILE> --org <slug>.',
	DEV_PROFILE_EXPIRED:
		'Renew the expired sign-in with: agent-flow-board check login <NAME> --profile <PROFILE> --org <slug>.',
	DEV_DB_NOT_THROWAWAY:
		'Point the dev server .env at a throwaway test database rather than port 5433 or a hosted production database.',
	DEV_ALLOWLIST_GET_REFUSED:
		'Only write methods (POST, PUT, PATCH, DELETE) belong in --write-allowlist; GET is not covered by approval.',
	DEV_ALLOWLIST_HOST_NOT_REGISTERED:
		'A write-allowlist entry that names a host ("POST https://<host>/path") needs that host in --extra-hosts on the same registration.',
	DEV_WRITE_STOPPED:
		'A POST to a data host is stopped by the write guard. If it only reads (a stable RPC), allow it by name: --write-allowlist "POST https://<host>/rest/v1/rpc/<name>" with --extra-hosts <host> and --allow-writes, then approve the new dev hash.',
	DEV_APPROVAL_REQUIRED:
		'Approve the dev configuration with: agent-flow-board check approve --request --action dev --target <NAME>.',
	DEV_FALLBACK_READINESS:
		'Using load plus settle window because Vite HMR was not detected on the dev server.'
};

/** Returns the fixed canonical fix line for a known dev status code (never untrusted raw text). */
export function devStatusFixLine(code: string | null | undefined): string | null {
	if (!code) return null;
	return (
		DEV_STATUS_FIX_LINES[code] ?? 'Run "agent-flow-board check doctor" to inspect the dev setup.'
	);
}

// -- CONSTANTS -- //

const ALLOWED_DEV_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Shell operators and control characters (POSIX + Windows cmd.exe) never accepted in a dev start command. */
const SHELL_META = /[;&|`$<>\n\r%^()]/;
const ALLOWED_METHODS: ReadonlySet<string> = new Set(WRITE_METHODS);

// -- FUNCTIONS -- //

/**
 * Validates and normalises a dev-server URL. Accepts only http:// or https:// on localhost, 127.0.0.1 or [::1]
 * with an explicit port, and never 5180, 5190 or 5433.
 */
export function cleanDevUrl(raw: string): string {
	const text = String(raw ?? '').trim();
	let u: URL;
	try {
		u = new URL(text);
	} catch {
		throw new Error('Dev URL must be an http:// or https:// address with an explicit port.');
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:')
		throw new Error('Dev URL must use http:// or https://.');
	if (u.username || u.password)
		throw new Error('Dev URL must not include a user name or password.');
	if (u.search || u.hash || (u.pathname && u.pathname !== '/'))
		throw new Error('Dev URL must be a plain origin with no path, query or hash.');
	const host = u.hostname.toLowerCase();
	if (!ALLOWED_DEV_HOSTS.has(host))
		throw new Error('Dev URL host must be localhost, 127.0.0.1 or [::1].');
	const portMatch = /^https?:\/\/[^/]+:(\d+)\/?$/i.exec(text);
	const portText = u.port || portMatch?.[1] || '';
	if (!/^\d+$/.test(portText)) throw new Error('Dev URL must include an explicit port number.');
	const port = Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error('Dev URL port must be between 1 and 65535.');
	if (FORBIDDEN_PORTS.has(port))
		throw new Error(
			`Port ${port} is reserved by Agent Flow Board and cannot be used for dev checks.`
		);
	return `${u.protocol}//${host}:${port}`;
}

/** Validates a redirect target so a dev server cannot bounce a probe or check onto another host or port. */
export function assertSameDevHostRedirect(baseUrl: string, locationHeader: string | null): void {
	if (!locationHeader) return;
	const base = new URL(baseUrl);
	let target: URL;
	try {
		target = new URL(locationHeader, base);
	} catch {
		throw new Error('Cross-host or invalid redirect from dev URL is blocked.');
	}
	if (target.origin !== base.origin) {
		throw new Error(`Cross-host redirect from ${base.origin} to ${target.origin} is blocked.`);
	}
}

/** Probes a dev URL without following redirects across hosts. */
export async function probeDevUrl(
	devUrl: string,
	fetchFn: typeof fetch = fetch
): Promise<DevProbeResult> {
	const origin = cleanDevUrl(devUrl);
	try {
		const res = await fetchFn(origin, { method: 'GET', redirect: 'manual' });
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get('location');
			try {
				assertSameDevHostRedirect(origin, loc);
			} catch (err) {
				return {
					ok: false,
					code: 'DEV_CROSS_HOST_REDIRECT',
					message: err instanceof Error ? err.message : 'Cross-host redirect is blocked.'
				};
			}
		}
		let mode: 'vite' | 'fallback' = 'fallback';
		try {
			const body = await res.text();
			if (body.includes('/@vite/client') || body.includes('vite-hmr')) mode = 'vite';
		} catch {
			// Body inspection is best-effort for readiness mode hint
		}
		return { ok: true, status: res.status, url: origin, mode };
	} catch {
		return {
			ok: false,
			code: 'DEV_URL_UNREACHABLE',
			message: `Nothing answered at ${origin}. Start the dev server or pass --start "<cmd>".`
		};
	}
}

/** Splits or validates an executable start command into argv words (never executed via shell:true). */
export function parseStartCommand(raw: string | string[]): string[] {
	const parts = Array.isArray(raw)
		? raw.map((s) => String(s ?? '').trim()).filter(Boolean)
		: splitArgvWords(String(raw ?? '').trim());
	if (!parts.length) throw new Error('Start command must not be empty.');
	for (const part of parts) {
		if (!part || SHELL_META.test(part))
			throw new Error(
				'Start command may only contain plain program and argument tokens without shell operators.'
			);
	}
	return parts;
}

function splitArgvWords(input: string): string[] {
	if (!input) return [];
	if (SHELL_META.test(input))
		throw new Error(
			'Start command may only contain plain program and argument tokens without shell operators.'
		);
	const out: string[] = [];
	let cur = '';
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (cur) {
				out.push(cur);
				cur = '';
			}
		} else {
			cur += ch;
		}
	}
	if (quote) throw new Error('Start command has an unclosed quote.');
	if (cur) out.push(cur);
	return out;
}

/** Splits "https://host/path" into its host (with port, lowercase) and path. Refuses a user name, query, hash or wildcard. */
function splitHostPath(raw: string): { host: string; path: string } {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new Error(`Write allowlist address "${raw.slice(0, 60)}" is not a valid address.`);
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:')
		throw new Error('Write allowlist addresses must use http:// or https://.');
	if (u.username || u.password || u.search || u.hash || raw.includes('*'))
		throw new Error(
			`Write allowlist address "${raw.slice(0, 60)}" must be a host and a fixed path only.`
		);
	return { host: u.host.toLowerCase(), path: u.pathname };
}

/** Normalises and validates write-allowlist rules. Refuses GET/HEAD/OPTIONS and invalid paths. An entry may name a host: "POST https://host/path". */
export function cleanWriteAllowlist(rules: readonly (string | WriteRule)[]): WriteRule[] {
	const out: WriteRule[] = [];
	const seen = new Set<string>();
	for (const entry of rules) {
		let methodRaw: string;
		let pathRaw: string;
		let hostRaw = '';
		if (typeof entry === 'string') {
			const m = /^([A-Za-z]+)\s+(\S+)$/.exec(entry.trim());
			if (!m)
				throw new Error(
					`Write allowlist entry "${entry.slice(0, 40)}" must be "METHOD /path" or "METHOD https://host/path".`
				);
			methodRaw = m[1]!;
			pathRaw = m[2]!;
			if (/^https?:\/\//i.test(pathRaw)) {
				const parts = splitHostPath(pathRaw);
				hostRaw = parts.host;
				pathRaw = parts.path;
			}
		} else {
			methodRaw = String(entry?.method ?? '').trim();
			pathRaw = String(entry?.pathPrefix ?? '').trim();
			hostRaw = String(entry?.host ?? '')
				.trim()
				.toLowerCase();
			if (hostRaw && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(hostRaw))
				throw new Error(
					`Write allowlist host "${hostRaw.slice(0, 60)}" must be a plain host name, with an optional port.`
				);
		}
		const method = methodRaw.toUpperCase();
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')
			throw new Error(
				`Write allowlist cannot include ${method}; an allowlist entry on a GET/HEAD/OPTIONS path is not covered by approval.`
			);
		if (!ALLOWED_METHODS.has(method))
			throw new Error(`Write allowlist method "${method}" must be POST, PUT, PATCH or DELETE.`);
		if (!pathRaw.startsWith('/') || pathRaw.includes('*') || /\s/.test(pathRaw))
			throw new Error(
				`Write allowlist path "${pathRaw.slice(0, 60)}" must be a fixed path prefix starting with /.`
			);
		if (hostRaw && pathRaw === '/')
			throw new Error('A write-allowlist entry on another host needs a path, not the whole host.');
		const key = `${method} ${hostRaw}${pathRaw}`;
		if (!seen.has(key)) {
			seen.add(key);
			// The host key exists only on a host rule, so the hash of an own-origin rule stays what it was
			out.push({
				method: method as WriteMethod,
				pathPrefix: pathRaw,
				...(hostRaw ? { host: hostRaw } : {})
			});
		}
	}
	const sortKey = (r: WriteRule) => `${r.method} ${r.host ?? ''}${r.pathPrefix}`;
	out.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
	return out;
}

/** The host names (without port) that the host rules of an allowlist name, for the check against --extra-hosts. */
export function allowlistHosts(rules: readonly WriteRule[]): string[] {
	return [
		...new Set(rules.filter((r) => r.host).map((r) => (r.host as string).replace(/:\d+$/, '')))
	];
}

/** True when a write request matches one of the approved method+pathPrefix rules. */
export function writeRuleAllowed(
	method: string,
	pathname: string,
	rules: readonly WriteRule[],
	host?: string
): boolean {
	const m = method.toUpperCase();
	return rules.some(
		(r) =>
			r.method === m &&
			(r.host || undefined) === (host?.toLowerCase() || undefined) &&
			(pathname === r.pathPrefix ||
				pathname.startsWith(r.pathPrefix.endsWith('/') ? r.pathPrefix : `${r.pathPrefix}/`) ||
				r.pathPrefix === '/')
	);
}

/** Deterministic SHA-256 hash of exact dev URL, startCommand and write allowlist for `check approve --action dev`. */
export function devConfigHash(input: DevHashInput): string {
	const canonical = {
		devUrl: cleanDevUrl(input.devUrl),
		startCommand: input.startCommand ? [...input.startCommand] : [],
		allowWrites: Boolean(input.allowWrites),
		writeAllowlist: input.writeAllowlist ? cleanWriteAllowlist(input.writeAllowlist) : []
	};
	return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Approval target passed to `check approve --action dev --target <name>#<hash>`. */
export function devApprovalTarget(name: string, hash: string): string {
	return `${name.trim().toLowerCase()}#${hash.toLowerCase()}`;
}

/** Refuses any startCommand originating from an untrusted board/MCP/API payload. */
export function rejectBoardStartCommand(source: unknown): void {
	if (!source || typeof source !== 'object') return;
	const obj = source as Record<string, unknown>;
	if (
		obj.startCommand !== undefined ||
		obj.start_command !== undefined ||
		obj.allowWrites !== undefined ||
		obj.allow_writes !== undefined ||
		obj.writeAllowlist !== undefined ||
		obj.write_allowlist !== undefined
	) {
		throw new Error(
			'Board payloads cannot supply startCommand, allowWrites or writeAllowlist; those are sealed locally by check approve.'
		);
	}
}

/**
 * Inspects `.env` files in the dev repo without printing or returning any secret values,
 * flagging non-throwaway database targets (port 5433, hosted Postgres/Supabase/Neon/RDS, etc.).
 */
export function inspectDevEnvDatabase(
	repo: string,
	appDir?: string
): { nonThrowaway: boolean; problems: string[] } {
	const dirs = appDir ? [repo, join(repo, appDir)] : [repo];
	const files = ['.env', '.env.local', '.env.development', '.env.development.local'];
	const merged: Record<string, string> = {};
	for (const d of dirs) {
		for (const f of files) {
			const full = join(d, f);
			try {
				if (!existsSync(full) || !statSync(full).isFile()) continue;
				const parsed = parseEnvText(readFileSync(full, 'utf8'));
				for (const [k, v] of parsed) merged[k] = v;
			} catch {
				// Ignore unreadable env files here
			}
		}
	}
	if (!Object.keys(merged).length) return { nonThrowaway: false, problems: [] };
	const problems = databaseProblems(merged, {});
	return { nonThrowaway: problems.length > 0, problems };
}
