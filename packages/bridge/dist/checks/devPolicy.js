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
export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
export const DEV_WRITE_GUARD_NOTE = 'Browser-layer only (service workers blocked, all HTTP methods, sendBeacon and WebSocket routed through the guard).';
export const DEV_STATUS_FIX_LINES = {
    DEV_URL_REACHABLE: 'Dev server is reachable.',
    DEV_URL_UNREACHABLE: 'Start the local dev server or add a sealed --start command with dev approval.',
    DEV_CROSS_HOST_REDIRECT: 'Point --dev-url at an origin that does not redirect to another host or port.',
    DEV_START_FAILED: 'Check the dev server command and dependencies, then run the check again.',
    DEV_START_TIMEOUT: 'Confirm the dev server listens on the registered --dev-url port within the startup window.',
    DEV_OVERLAY_ERROR: 'Fix the compiler or runtime error shown by the dev server overlay and re-run.',
    DEV_HMR_DISCONNECTED: 'Ensure the Vite dev server is running and reload the page.',
    DEV_HMR_PENDING: 'Wait for active Vite HMR updates to settle or fix the failing module update.',
    DEV_NETWORK_BUSY: 'Check for hanging API requests or continuous polling on the screen.',
    DEV_PROFILE_MISSING: 'Save a dev sign-in with: agent-flow-board check login <NAME> --profile <PROFILE> --org <slug>.',
    DEV_PROFILE_EXPIRED: 'Renew the expired sign-in with: agent-flow-board check login <NAME> --profile <PROFILE> --org <slug>.',
    DEV_DB_NOT_THROWAWAY: 'Point the dev server .env at a throwaway test database rather than port 5433 or a hosted production database.',
    DEV_ALLOWLIST_GET_REFUSED: 'Only write methods (POST, PUT, PATCH, DELETE) belong in --write-allowlist; GET is not covered by approval.',
    DEV_APPROVAL_REQUIRED: 'Approve the dev configuration with: agent-flow-board check approve --request --action dev --target <NAME>.',
    DEV_FALLBACK_READINESS: 'Using load plus settle window because Vite HMR was not detected on the dev server.'
};
/** Returns the fixed canonical fix line for a known dev status code (never untrusted raw text). */
export function devStatusFixLine(code) {
    if (!code)
        return null;
    return (DEV_STATUS_FIX_LINES[code] ?? 'Run "agent-flow-board check doctor" to inspect the dev setup.');
}
// -- CONSTANTS -- //
const ALLOWED_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Shell operators and control characters (POSIX + Windows cmd.exe) never accepted in a dev start command. */
const SHELL_META = /[;&|`$<>\n\r%^()]/;
const ALLOWED_METHODS = new Set(WRITE_METHODS);
// -- FUNCTIONS -- //
/**
 * Validates and normalises a dev-server URL. Accepts only http:// or https:// on localhost, 127.0.0.1 or [::1]
 * with an explicit port, and never 5180, 5190 or 5433.
 */
export function cleanDevUrl(raw) {
    const text = String(raw ?? '').trim();
    let u;
    try {
        u = new URL(text);
    }
    catch {
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
    if (!/^\d+$/.test(portText))
        throw new Error('Dev URL must include an explicit port number.');
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('Dev URL port must be between 1 and 65535.');
    if (FORBIDDEN_PORTS.has(port))
        throw new Error(`Port ${port} is reserved by Agent Flow Board and cannot be used for dev checks.`);
    return `${u.protocol}//${host}:${port}`;
}
/** Validates a redirect target so a dev server cannot bounce a probe or check onto another host or port. */
export function assertSameDevHostRedirect(baseUrl, locationHeader) {
    if (!locationHeader)
        return;
    const base = new URL(baseUrl);
    let target;
    try {
        target = new URL(locationHeader, base);
    }
    catch {
        throw new Error('Cross-host or invalid redirect from dev URL is blocked.');
    }
    if (target.origin !== base.origin) {
        throw new Error(`Cross-host redirect from ${base.origin} to ${target.origin} is blocked.`);
    }
}
/** Probes a dev URL without following redirects across hosts. */
export async function probeDevUrl(devUrl, fetchFn = fetch) {
    const origin = cleanDevUrl(devUrl);
    try {
        const res = await fetchFn(origin, { method: 'GET', redirect: 'manual' });
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            try {
                assertSameDevHostRedirect(origin, loc);
            }
            catch (err) {
                return {
                    ok: false,
                    code: 'DEV_CROSS_HOST_REDIRECT',
                    message: err instanceof Error ? err.message : 'Cross-host redirect is blocked.'
                };
            }
        }
        let mode = 'fallback';
        try {
            const body = await res.text();
            if (body.includes('/@vite/client') || body.includes('vite-hmr'))
                mode = 'vite';
        }
        catch {
            // Body inspection is best-effort for readiness mode hint
        }
        return { ok: true, status: res.status, url: origin, mode };
    }
    catch {
        return {
            ok: false,
            code: 'DEV_URL_UNREACHABLE',
            message: `Nothing answered at ${origin}. Start the dev server or pass --start "<cmd>".`
        };
    }
}
/** Splits or validates an executable start command into argv words (never executed via shell:true). */
export function parseStartCommand(raw) {
    const parts = Array.isArray(raw)
        ? raw.map((s) => String(s ?? '').trim()).filter(Boolean)
        : splitArgvWords(String(raw ?? '').trim());
    if (!parts.length)
        throw new Error('Start command must not be empty.');
    for (const part of parts) {
        if (!part || SHELL_META.test(part))
            throw new Error('Start command may only contain plain program and argument tokens without shell operators.');
    }
    return parts;
}
function splitArgvWords(input) {
    if (!input)
        return [];
    if (SHELL_META.test(input))
        throw new Error('Start command may only contain plain program and argument tokens without shell operators.');
    const out = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (quote) {
            if (ch === quote)
                quote = null;
            else
                cur += ch;
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
        }
        else if (/\s/.test(ch)) {
            if (cur) {
                out.push(cur);
                cur = '';
            }
        }
        else {
            cur += ch;
        }
    }
    if (quote)
        throw new Error('Start command has an unclosed quote.');
    if (cur)
        out.push(cur);
    return out;
}
/** Normalises and validates write-allowlist rules. Refuses GET/HEAD/OPTIONS and invalid paths. */
export function cleanWriteAllowlist(rules) {
    const out = [];
    const seen = new Set();
    for (const entry of rules) {
        let methodRaw;
        let pathRaw;
        if (typeof entry === 'string') {
            const m = /^([A-Za-z]+)\s+(\S+)$/.exec(entry.trim());
            if (!m)
                throw new Error(`Write allowlist entry "${entry.slice(0, 40)}" must be "METHOD /path".`);
            methodRaw = m[1];
            pathRaw = m[2];
        }
        else {
            methodRaw = String(entry?.method ?? '').trim();
            pathRaw = String(entry?.pathPrefix ?? '').trim();
        }
        const method = methodRaw.toUpperCase();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')
            throw new Error(`Write allowlist cannot include ${method}; an allowlist entry on a GET/HEAD/OPTIONS path is not covered by approval.`);
        if (!ALLOWED_METHODS.has(method))
            throw new Error(`Write allowlist method "${method}" must be POST, PUT, PATCH or DELETE.`);
        if (!pathRaw.startsWith('/') || pathRaw.includes('*') || /\s/.test(pathRaw))
            throw new Error(`Write allowlist path "${pathRaw.slice(0, 60)}" must be a fixed path prefix starting with /.`);
        const key = `${method} ${pathRaw}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push({ method: method, pathPrefix: pathRaw });
        }
    }
    out.sort((a, b) => `${a.method} ${a.pathPrefix}`.localeCompare(`${b.method} ${b.pathPrefix}`));
    return out;
}
/** True when a write request matches one of the approved method+pathPrefix rules. */
export function writeRuleAllowed(method, pathname, rules) {
    const m = method.toUpperCase();
    return rules.some((r) => r.method === m &&
        (pathname === r.pathPrefix ||
            pathname.startsWith(r.pathPrefix.endsWith('/') ? r.pathPrefix : `${r.pathPrefix}/`) ||
            r.pathPrefix === '/'));
}
/** Deterministic SHA-256 hash of exact dev URL, startCommand and write allowlist for `check approve --action dev`. */
export function devConfigHash(input) {
    const canonical = {
        devUrl: cleanDevUrl(input.devUrl),
        startCommand: input.startCommand ? [...input.startCommand] : [],
        allowWrites: Boolean(input.allowWrites),
        writeAllowlist: input.writeAllowlist ? cleanWriteAllowlist(input.writeAllowlist) : []
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
/** Approval target passed to `check approve --action dev --target <name>#<hash>`. */
export function devApprovalTarget(name, hash) {
    return `${name.trim().toLowerCase()}#${hash.toLowerCase()}`;
}
/** Refuses any startCommand originating from an untrusted board/MCP/API payload. */
export function rejectBoardStartCommand(source) {
    if (!source || typeof source !== 'object')
        return;
    const obj = source;
    if (obj.startCommand !== undefined ||
        obj.start_command !== undefined ||
        obj.allowWrites !== undefined ||
        obj.allow_writes !== undefined ||
        obj.writeAllowlist !== undefined ||
        obj.write_allowlist !== undefined) {
        throw new Error('Board payloads cannot supply startCommand, allowWrites or writeAllowlist; those are sealed locally by check approve.');
    }
}
/**
 * Inspects `.env` files in the dev repo without printing or returning any secret values,
 * flagging non-throwaway database targets (port 5433, hosted Postgres/Supabase/Neon/RDS, etc.).
 */
export function inspectDevEnvDatabase(repo, appDir) {
    const dirs = appDir ? [repo, join(repo, appDir)] : [repo];
    const files = ['.env', '.env.local', '.env.development', '.env.development.local'];
    const merged = {};
    for (const d of dirs) {
        for (const f of files) {
            const full = join(d, f);
            try {
                if (!existsSync(full) || !statSync(full).isFile())
                    continue;
                const parsed = parseEnvText(readFileSync(full, 'utf8'));
                for (const [k, v] of parsed)
                    merged[k] = v;
            }
            catch {
                // Ignore unreadable env files here
            }
        }
    }
    if (!Object.keys(merged).length)
        return { nonThrowaway: false, problems: [] };
    const problems = databaseProblems(merged, {});
    return { nonThrowaway: problems.length > 0, problems };
}
