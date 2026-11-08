// THE WHOLE .env OF A REGISTRATION THAT THE OWNER OPTED IN (step 3.4, Registration.adoptEnv, set with an approval code). The registration's preview adopts every variable of the
// repo's own .env files, so the app runs with the settings it was written for, EXCEPT the deny list (variables that load code or move the machine's own settings) and the
// run's own settings (PORT, HOST, NODE_ENV). The files are read from the registered repo folder, never from the run's copy (a copy has no .env), and never printed: every
// message here names variables and files, never values. The caller keeps what is returned in `startEnv` OUT of install and build (adopted values reach the START step only),
// runs databaseProblems() (envrules.ts) over it, and puts `redactions` into the redaction needles.
// -- DEP-MODULES -- //
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { expandRefs } from './envrules.js';
// -- CONSTANTS -- //
/** Read in this order, a later file overriding an earlier one (the order a production build of Vite and SvelteKit uses). .env.test is read only when none of these exist in that folder. */
export const ADOPT_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];
const FALLBACK = ['.env.test'];
/** Variables that name the app's own address: pointed at the run's preview, because the value in .env is the live address and would make every form and redirect fail. */
const SELF_ADDRESS = /^(ORIGIN|BETTER_AUTH_URL|AUTH_URL|NEXTAUTH_URL|APP_URL|SITE_URL|BASE_URL|(PUBLIC_|VITE_|NEXT_PUBLIC_)(APP|SITE|BASE)_URL)$/;
/** Never taken from a file: the run's own settings (the run sets EMAIL_PROVIDER to log itself). */
const RUN_OWN = new Set(['PORT', 'HOST', 'NODE_ENV', 'EMAIL_PROVIDER']);
/** Never adopted, whatever the file says: names that load code, change where programs and certificates come from, or move the machine's own settings. */
const DENY_EXACT = new Set([
    'NODE_OPTIONS',
    'PATH',
    'PATHEXT',
    'COMSPEC',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    // Added beyond the plan's list: the same kind of danger
    'NODE_PATH',
    'NODE_REPL_EXTERNAL_MODULE'
]);
/** Prefixes are compared without case (npm_config_*, NPM_CONFIG_*, PNPM_*, YARN_*, LD_*). */
const DENY_PREFIX = ['NPM_CONFIG_', 'PNPM_', 'YARN_', 'LD_', 'DYLD_', 'AFB_MAIL_FENCE_'];
const MIN_REDACT = 8;
const MAX_FILE_BYTES = 1_000_000;
// -- FUNCTIONS -- //
/** True when a variable may never be adopted. Compared without case, because a Windows environment has none. */
export function isDeniedName(name) {
    const upper = name.toUpperCase();
    return DENY_EXACT.has(upper) || DENY_PREFIX.some((p) => upper.startsWith(p));
}
/** NAME=value lines. `export ` and one pair of quotes are allowed; a quoted value may run over several lines, and \n in a double-quoted value is a line break. Comments and lines that are not settings are skipped. */
export function parseRepoEnvText(text) {
    const out = new Map();
    const body = String(text);
    const lines = (body.charCodeAt(0) === 0xfeff ? body.slice(1) : body).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] ?? '').trim();
        if (!line || line.startsWith('#'))
            continue;
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
        if (!m || m[1] === undefined)
            continue;
        let v = (m[2] ?? '').trim();
        const q = v[0];
        if (q === '"' || q === "'" || q === '`') {
            let body = v.slice(1);
            let end = body.indexOf(q);
            while (end < 0 && i + 1 < lines.length) {
                body += '\n' + (lines[++i] ?? '');
                end = body.indexOf(q);
            }
            v = end < 0 ? body : body.slice(0, end);
            if (q === '"')
                v = v.replace(/\\n/g, '\n');
        }
        else
            v = v.replace(/\s+#.*$/, '');
        out.set(m[1], v);
    }
    return out;
}
/** The text of a plain file, or null. A link, a folder or a file over 1 MB is not read (a link could point at a key outside the repo). */
function readPlainFile(file) {
    try {
        const st = lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE_BYTES)
            return null;
        const fd = openSync(file, 'r');
        try {
            const fst = fstatSync(fd);
            if (!fst.isFile() || fst.size > MAX_FILE_BYTES)
                return null;
            return readFileSync(fd, 'utf8');
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return null;
    }
}
/** The folders the env files may sit in, repo root first and the app folder after it (the app folder wins). */
function foldersOf(repo, appDir) {
    const out = [{ dir: repo, label: '' }];
    if (appDir) {
        const clean = appDir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        if (!clean || clean.split('/').includes('..') || /^([a-zA-Z]:|\/)/.test(clean))
            throw new Error('The app folder of this registration is not a plain relative folder.');
        out.push({ dir: join(repo, clean), label: `${clean}/` });
    }
    return out;
}
/**
 * Every variable of the registration's .env files, with the run's own address filled in. Never throws for a missing file (no file is an empty result).
 * `vars.baseUrl` is the run's preview address, put in every self-address variable.
 */
export function adoptRepoEnv(cfg, vars) {
    const merged = new Map();
    const files = [];
    for (const { dir, label } of foldersOf(cfg.repo, cfg.appDir)) {
        let found = ADOPT_FILES.filter((f) => readPlainFile(join(dir, f)) !== null);
        if (!found.length)
            found = FALLBACK.filter((f) => readPlainFile(join(dir, f)) !== null);
        for (const f of found) {
            const text = readPlainFile(join(dir, f));
            if (text === null)
                continue;
            for (const [k, v] of parseRepoEnvText(text))
                merged.set(k, v);
            files.push(`${label}${f}`);
        }
    }
    const result = { startEnv: {}, redactions: [], names: [], denied: [], files };
    if (!merged.size)
        return result;
    // ${NAME} inside a value is filled from the same files (what dotenv-expand does), since the preview is given plain values
    const plain = Object.fromEntries(merged);
    for (const [k, v] of merged) {
        if (RUN_OWN.has(k.toUpperCase()))
            continue;
        if (isDeniedName(k)) {
            result.denied.push(k);
            continue;
        }
        result.startEnv[k] =
            SELF_ADDRESS.test(k) && /^https?:\/\//i.test(v) ? vars.baseUrl : expandRefs(v, plain);
    }
    result.names = Object.keys(result.startEnv);
    const needles = new Set();
    for (const v of Object.values(result.startEnv)) {
        if (v.length >= MIN_REDACT)
            needles.add(v);
        if (v.includes('\n'))
            for (const l of v.split('\n'))
                if (l.trim().length >= MIN_REDACT)
                    needles.add(l.trim());
    }
    result.redactions = [...needles];
    return result;
}
