// THE ENVIRONMENT OF A PREVIEW. Owner rule: a check never runs against a database URL that came from a .env file, and never sends mail through a real provider.
// The repo's own .env files are read from the SOURCE repo (the private copy has none) and adopted, so the app runs with the settings it was written for,
// EXCEPT database and connection variables (stripped) and mail provider variables (stripped, and the mailer is told to only log). Nothing is
// ever printed here with its value: notes and the stripped list name variables only.
// -- DEP-MODULES -- //
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { databaseProblems } from './envrules.js';
import { enforceMailSet } from './mailguard.js';
import { adoptRepoEnv } from './repoenv.js';
// -- CONSTANTS -- //
/** Read in this order, a later file overriding an earlier one (the order a production build of Vite and SvelteKit uses). */
const FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];
/** A name that points at a database or another data store. Any such variable is stripped, whatever its value. */
const DATABASE_NAME = /(DATABASE|DB|POSTGRES|PG|SUPABASE_SERVICE|REDIS|MONGO|MYSQL).*(URL|URI|HOST|PASSWORD|USER|NAME)?/i;
/** A value that is a connection string: scheme://user@... or a database scheme. */
const CONNECTION_VALUE = /^[a-z][a-z0-9+.-]*:\/\/[^\s@]*@/i;
const DATABASE_SCHEME = /^(postgres(ql)?|mysql|mongodb(\+srv)?|redis|rediss):\/\//i;
/** A name of a mail provider setting. SES must be a whole word (SESSION_SECRET is not mail). */
const MAIL_NAME = /(MAIL|SMTP|POSTMARK|SENDGRID|MAILGUN|RESEND)|(^|_)SES(_|$)/i;
/** What the app's own mailer accepts for "log only" (src/env.ts: EMAIL_PROVIDER is log, resend, postmark or smtp). */
const MAIL_LOG_ONLY = 'log';
/** Variables that name the app's own address: pointed at the run's preview, because the value in .env is the live address. */
const SELF_ADDRESS = /^(ORIGIN|BETTER_AUTH_URL|AUTH_URL|NEXTAUTH_URL|APP_URL|SITE_URL|BASE_URL|(PUBLIC_|VITE_|NEXT_PUBLIC_)(APP|SITE|BASE)_URL)$/;
/** Never taken from a file: the run's own settings. */
const RUN_OWN = new Set(['PORT', 'HOST', 'NODE_ENV', 'EMAIL_PROVIDER']);
/** What a package manager and a build need from the machine. Nothing else of the process environment is passed (no AFB_TOKEN, no *_TOKEN, *_SECRET or *_KEY). */
const SYSTEM = [
    'PATH',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'COMSPEC',
    'PATHEXT'
];
// -- FUNCTIONS -- //
/** NAME=value lines. `export ` and one pair of quotes are allowed; a quoted value may run over several lines. No expansion, no substitution. */
export function parseEnvText(text) {
    const out = new Map();
    const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
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
        }
        else
            v = v.replace(/\s+#.*$/, '');
        out.set(m[1], v);
    }
    return out;
}
const isFile = (f) => {
    try {
        return existsSync(f) && statSync(f).isFile();
    }
    catch {
        return false;
    }
};
/** The merged variables of the repo's env files, a later file winning. A missing file is skipped. */
function readRepoEnv(repo) {
    const merged = new Map();
    for (const f of FILES) {
        const file = join(repo, f);
        if (!isFile(file))
            continue;
        for (const [k, v] of parseEnvText(readFileSync(file, 'utf8')))
            merged.set(k, v);
    }
    return merged;
}
const looksLikeConnection = (name, value) => DATABASE_NAME.test(name) || CONNECTION_VALUE.test(value) || DATABASE_SCHEME.test(value);
/** Fills the recipe placeholders. A placeholder that needs a database that was not made is left empty and named in the notes. */
function fill(value, vars, name, notes) {
    return value.replace(/\{(baseUrl|port|random|databaseUrl|databaseOwnerUrl)\}/g, (_all, key) => {
        if (key === 'random')
            return randomBytes(24).toString('hex');
        const v = vars[key];
        if (v === undefined) {
            notes.push(`The recipe variable ${name} needs {${key}}, which this run does not have; it is empty.`);
            return '';
        }
        return v;
    });
}
export function buildPreviewEnv(input) {
    const notes = [];
    const stripped = [];
    const env = {};
    // -- SYSTEM -- //
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && SYSTEM.includes(k.toUpperCase()))
            env[k] = v;
    }
    // -- THE REPO'S OWN ENV FILES -- //
    const fromFiles = input.readRepoEnv === false ? new Map() : readRepoEnv(input.repo);
    let adopted = 0;
    let mailStripped = false;
    for (const [name, value] of fromFiles) {
        if (RUN_OWN.has(name))
            continue;
        if (SELF_ADDRESS.test(name) && /^https?:\/\//i.test(value)) {
            env[name] = input.baseUrl;
            adopted++;
            continue;
        }
        if (looksLikeConnection(name, value)) {
            stripped.push(name);
            continue;
        }
        if (MAIL_NAME.test(name)) {
            stripped.push(name);
            mailStripped = true;
            continue;
        }
        env[name] = value;
        adopted++;
    }
    if (fromFiles.size)
        notes.push(`Adopted ${adopted} variable(s) from the repo's env files.`);
    if (stripped.length)
        notes.push(`Stripped ${stripped.length} database or mail variable(s): ${stripped.join(', ')}.`);
    // -- THE RECIPE -- //
    const vars = {
        baseUrl: input.baseUrl,
        port: String(input.port),
        databaseUrl: input.databaseUrl,
        databaseOwnerUrl: input.databaseOwnerUrl
    };
    for (const [name, value] of Object.entries(input.recipeEnv)) {
        if (RUN_OWN.has(name))
            continue;
        env[name] = fill(value, vars, name, notes);
    }
    // -- THE RUN'S OWN SETTINGS -- //
    env.PORT = String(input.port);
    env.HOST = '127.0.0.1';
    env.NODE_ENV = 'production';
    // The app's own address is always the preview's (SvelteKit's node adapter needs ORIGIN for form posts)
    env.ORIGIN = input.baseUrl;
    env.EMAIL_PROVIDER = MAIL_LOG_ONLY;
    notes.push(`EMAIL_PROVIDER is set to ${MAIL_LOG_ONLY}, the value the app accepts for "log only"${mailStripped ? ' (mail provider variables were stripped)' : ''}.`);
    if (input.databaseUrl !== undefined)
        env.DATABASE_URL = input.databaseUrl;
    if (input.databaseOwnerUrl !== undefined)
        env.DATABASE_OWNER_URL = input.databaseOwnerUrl;
    return { env, stripped, notes };
}
/**
 * The environment of a registration that adopts its repo's whole .env. `env` is the START environment (system, adopted, recipe, run's own; later wins), `buildEnv` is
 * the same WITHOUT the adopted values. Rules: the deny list is never adopted (repoenv.ts), every adopted database or address value is checked by databaseProblems and a
 * problem fails the run (the caller refuses to start when `problems` is not empty), and mail settings that did not come from the sealed store are stripped.
 * A registration that did not opt in uses buildPreviewEnv, whose stricter default strips database and mail variables.
 */
export function buildAdoptedEnv(input) {
    const base = buildPreviewEnv({ ...input, readRepoEnv: false });
    const adopted = adoptRepoEnv({ repo: input.repo, appDir: input.appDir }, { baseUrl: input.baseUrl });
    const notes = [...base.notes];
    const stripped = [...base.stripped];
    // The database rule runs over what the files said, before the run's own settings are laid over it
    let throwawayHost;
    try {
        if (input.databaseUrl !== undefined)
            throwawayHost = new URL(input.databaseUrl).host;
    }
    catch {
        throwawayHost = undefined;
    }
    const problems = databaseProblems(adopted.startEnv, { testHost: input.testHost, throwawayHost });
    // Mail: only a setting from the sealed store stays
    const mail = enforceMailSet(adopted.startEnv, input.sealedNames ?? [], 'strip');
    stripped.push(...mail.stripped);
    if (adopted.files.length)
        notes.push(`Adopted ${Object.keys(mail.env).length} variable(s) from ${adopted.files.join(', ')} for the start step only.`);
    if (adopted.denied.length)
        notes.push(`Not adopted (the deny list): ${adopted.denied.join(', ')}.`);
    if (mail.stripped.length)
        notes.push(`Stripped ${mail.stripped.length} mail variable(s) that did not come from the sealed store: ${mail.stripped.join(', ')}.`);
    for (const p of problems)
        notes.push(p);
    // Later wins: system, adopted, then the recipe's and the run's own settings
    const env = { ...mail.env, ...base.env };
    // The system variables come first in base.env; an adopted variable never replaces one of them (the deny list already covers the dangerous names)
    return {
        env,
        buildEnv: base.env,
        stripped,
        notes,
        redactions: adopted.redactions,
        problems,
        names: Object.keys(mail.env)
    };
}
