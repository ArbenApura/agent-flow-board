// SEALED SECRETS OF ONE REGISTRATION. A preview never inherits the repo's .env on its own. The one way a few values get in is an explicit import: the TOOL (not the agent)
// reads the named keys from an env file inside the registration's repo, once, with the owner's single-use approval code, and seals them for that registration in the
// state folder. A recipe names a key as {secret:NAME}; the value is filled in when the preview starts. Every message here names keys, never values.
//
// WHAT THIS DOES AND DOES NOT PROTECT. The preview runs the repo's own code with these values in its environment, and that code is written by the agent, so it can read
// them. The protection is against accidents: an import is limited to Supabase-style and mail keys from a test env file, the project ref has to match the URL and the
// keys, a service key needs a flag, a registration cannot open another's store (it is bound into the seal), nothing prints a value, and the audit chain records what was
// imported and that it was approved with a code.
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
// -- MODULES -- //
import { boardSentence, consumeApprovalNote, peekApproval } from './approve.js';
import { appendAudit } from './audit.js';
import { withLockSync } from './lock.js';
import { ORG_SLUG, ensureDir, isInside, stateDirFor } from './paths.js';
import { renameRetry } from './fsretry.js';
import { CLIENT_NAME, EMAIL, SECRET_ENV_KEY, SECRET_PLACEHOLDER, SERVICE_NAME, URL_KEY, isMailKey } from './sealedNames.js';
import { seal, unseal } from './store.js';
// -- CONSTANTS -- //
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_FILES = new Set(['.env', '.env.local', '.env.test']);
const TEST_REF = /^[a-z0-9]{6,40}$/;
const STREAM = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_KEYS = 12;
const MAIL_NAMES = 'POSTMARK_SERVER_TOKEN, POSTMARK_FROM_EMAIL and POSTMARK_MESSAGE_STREAM';
/** The action word of the owner's approval code for an import. */
export const SECRETS_ACTION = 'secrets';
// -- FUNCTIONS -- //
const refOf = (org, name) => {
    if (!ORG_SLUG.test(org))
        throw new Error('The organisation is not a slug.');
    if (!NAME_RE.test(name))
        throw new Error('The registration name is not a plain name.');
    return `${org}/${name}`;
};
const fileOf = (org, name) => join(stateDirFor(org, name), 'secrets.sealed');
const lockOf = (ref) => `secrets-${createHash('sha256').update(ref.toLowerCase()).digest('hex').slice(0, 20)}`;
const helpOf = (ref) => `agent-flow-board check secrets import --project ${ref.split('/')[1] ?? ''} --org ${ref.split('/')[0] ?? ''} --from <env file in the repo> --keys <NAME,NAME> --test-ref <supabase project ref> --approval <code from check approve --request --action secrets --target ${ref}> (mail settings: --keys POSTMARK_SERVER_TOKEN,POSTMARK_FROM_EMAIL,POSTMARK_MESSAGE_STREAM --test-inbox <the one inbox a preview may mail> --owner-said "<says the token is a test token>")`;
/** NAME=value lines of an env file. `export ` and one pair of quotes are allowed; a value that opens a quote it does not close on the same line is refused (names the variable). */
export function parseImportEnv(text) {
    const out = new Map();
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#'))
            continue;
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m || m[1] === undefined)
            continue;
        let v = (m[2] ?? '').trim();
        if (v.startsWith('"') || v.startsWith("'") || v.startsWith('`')) {
            const q = v[0];
            const end = v.indexOf(q, 1);
            if (end < 0)
                throw new Error(`${m[1]} has a value over several lines, which an import does not read. Put it on one line.`);
            v = v.slice(1, end);
        }
        else
            v = v.replace(/\s+#.*$/, '');
        out.set(m[1], v);
    }
    return out;
}
function jwtPayload(v) {
    const parts = String(v).split('.');
    if (parts.length !== 3 || !/^eyJ/.test(parts[0] ?? ''))
        return null;
    try {
        const body = JSON.parse(Buffer.from((parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        return body && typeof body === 'object' ? body : null;
    }
    catch {
        return null;
    }
}
/** A key that bypasses row-level security: a JWT with role service_role, a new-style secret key, or a service key by its name. */
const isServiceKey = (v, name = '') => SERVICE_NAME.test(name) ||
    jwtPayload(v)?.role === 'service_role' ||
    String(v).startsWith('sb_secret_');
const hostFor = (testRef) => `${testRef}.supabase.co`;
// -- THE STORE -- //
function readStore(org, name) {
    const ref = refOf(org, name);
    let blob;
    try {
        blob = readFileSync(fileOf(org, name));
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return null;
        throw e;
    }
    let doc;
    try {
        doc = JSON.parse(Buffer.from(unseal(ref, blob)).toString('utf8'));
    }
    catch {
        throw new Error(`The sealed secrets of ${ref} are damaged or were made for another registration. Import them again: ${helpOf(ref)}`);
    }
    if (doc?.ref !== ref || typeof doc.values !== 'object' || doc.values === null)
        throw new Error(`The sealed secrets of ${ref} are damaged. Import them again: ${helpOf(ref)}`);
    return doc;
}
const readStoreSafe = (org, name) => {
    try {
        return readStore(org, name);
    }
    catch {
        return null;
    }
};
/** Written to a file beside the store and moved into place, so a crash leaves the old store whole. Callers hold the lock. */
function writeStore(org, name, doc) {
    ensureDir(stateDirFor(org, name));
    const f = fileOf(org, name);
    const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
    try {
        writeFileSync(tmp, seal(doc.ref, Buffer.from(JSON.stringify(doc), 'utf8')), { mode: 0o600 });
        renameRetry(tmp, f);
    }
    catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}
// -- IMPORT, LIST, FORGET -- //
/**
 * Reads the named keys from an env file and seals them for the registration. Throws one plain sentence naming a key or a rule, never a value.
 * The owner's approval code (action 'secrets', target org/NAME) must be valid before the file is read, and it is used last, after every rule and every value has been
 * checked, so a refused import never burns the code.
 */
export function importSecrets(input) {
    const ref = refOf(input.org, input.name);
    const action = input.action ?? 'secrets-import';
    // -- THE ASKED-FOR KEYS -- //
    if (!input.repo)
        throw new Error(`${ref} has no repo folder, so there is no env file to import from.`);
    if (!input.file)
        throw new Error('Say which env file: --from <file in the repo>.');
    const names = [...new Set((input.keys ?? []).map((k) => k.trim()).filter(Boolean))];
    if (!names.length)
        throw new Error('Name the keys to import: --keys NAME,NAME.');
    if (names.length > MAX_KEYS)
        throw new Error(`Import at most ${MAX_KEYS} keys.`);
    const bad = names.filter((k) => !SECRET_ENV_KEY.test(k));
    if (bad.length)
        throw new Error(`${bad.join(', ')} cannot be imported (only Supabase settings such as PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the app's auth secret, and the mail settings ${MAIL_NAMES}).`);
    const mailNames = names.filter(isMailKey);
    const supaNames = names.filter((k) => !isMailKey(k));
    const testRef = input.testRef ?? '';
    if (supaNames.length && !TEST_REF.test(testRef))
        throw new Error('Say which Supabase project the keys belong to: --test-ref <the project ref, lower case letters and digits>.');
    if (mailNames.length) {
        if (!EMAIL.test(String(input.testInbox ?? '')))
            throw new Error('Mail settings need the one inbox a preview may send to: --test-inbox <address>.');
        const said = String(input.ownerSaid ?? '');
        if (said.trim().length < 10 || !/\btest\b/i.test(said))
            throw new Error("Mail settings need the owner's word that the token is a test token: --owner-said '<sentence of 10 or more characters that says this is a test token>'.");
    }
    // -- THE FILE, BEFORE IT IS READ -- //
    const resolved = resolve(input.file);
    const fileName = basename(resolved);
    if (!ENV_FILES.has(fileName))
        throw new Error(`${fileName} is not a file an import reads (use .env, .env.local or .env.test; never .env.production).`);
    let st;
    try {
        st = lstatSync(resolved, { bigint: true });
    }
    catch {
        throw new Error(`${fileName} does not exist there.`);
    }
    if (st.isSymbolicLink() || !st.isFile())
        throw new Error(`${fileName} is a link or not a file, which an import does not read.`);
    let realFile;
    try {
        realFile = realpathSync.native(resolved);
    }
    catch {
        throw new Error(`${fileName} does not exist there.`);
    }
    if (!isInside(realpathSync.native(resolve(input.repo)), realFile))
        throw new Error(`${fileName} is not inside the repo folder of ${ref}.`);
    // -- THE OWNER'S APPROVAL -- //
    if (!input.approval || !peekApproval(SECRETS_ACTION, ref, input.approval))
        throw new Error(`The owner has not approved this import. Run \`agent-flow-board check approve --request --action secrets --target ${ref}\` and pass the code with --approval.`);
    // -- THE READ: ONE HANDLE FOR THE CHECKS AND THE READ, A FILE WITH A SECOND NAME REFUSED -- //
    let text;
    const fd = openSync(resolved, 'r');
    try {
        const fst = fstatSync(fd, { bigint: true });
        if (!fst.isFile() || fst.nlink > 1n || fst.ino !== st.ino || fst.dev !== st.dev)
            throw new Error(`${fileName} changed while it was being read, or has a second name (a hard link), so it is not read.`);
        text = readFileSync(fd, 'utf8');
    }
    finally {
        closeSync(fd);
    }
    const found = parseImportEnv(text);
    const missing = names.filter((k) => !found.get(k));
    if (missing.length)
        throw new Error(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set in ${fileName}.`);
    // -- THE PROJECT REF: THE URL AND EVERY SIGNED KEY BELONG TO IT -- //
    const entries = {};
    const service = [];
    const urls = names.filter((k) => URL_KEY.test(k));
    if (supaNames.length && !urls.length)
        throw new Error('Import the Supabase URL too (a key ending in SUPABASE_URL), so the project ref can be checked against it.');
    for (const k of urls) {
        let host;
        try {
            const u = new URL(found.get(k));
            if (u.protocol !== 'https:')
                throw new Error('not https');
            host = u.hostname;
        }
        catch {
            throw new Error(`${k} is not an https address.`);
        }
        if (host !== hostFor(testRef))
            throw new Error(`${k} does not belong to the project ref you gave (--test-ref). Nothing was imported.`);
    }
    for (const k of names) {
        const v = found.get(k);
        if (isMailKey(k)) {
            const ok = k === 'POSTMARK_FROM_EMAIL'
                ? EMAIL.test(v)
                : k === 'POSTMARK_MESSAGE_STREAM'
                    ? STREAM.test(v)
                    : v.length >= 8 && !/\s/.test(v);
            if (!ok)
                throw new Error(`${k} in ${fileName} does not look like a ${k === 'POSTMARK_FROM_EMAIL' ? 'single email address' : k === 'POSTMARK_MESSAGE_STREAM' ? 'stream name' : 'token'}. Nothing was imported.`);
            entries[k] = { v, service: false, mail: true };
            continue;
        }
        const claims = jwtPayload(v);
        if (claims?.ref !== undefined && claims.ref !== testRef)
            throw new Error(`${k} is signed for another Supabase project than --test-ref. Nothing was imported.`);
        const svc = isServiceKey(v, k);
        if (svc && !input.allowServiceRole)
            throw new Error(`${k} is a service key, which bypasses row-level security and is not imported by default. Import the anon key; add --allow-service-role only when the app cannot start without it.`);
        if (svc)
            service.push(k);
        entries[k] = { v, service: svc };
    }
    // -- THE CODE IS USED LAST -- //
    const used = consumeApprovalNote(SECRETS_ACTION, ref, input.approval ?? '');
    if (!used.ok)
        throw new Error('The owner code was used or expired just now, so nothing was imported. The code is spent: ask the owner for a new one.');
    // -- THE WRITE, UNDER A LOCK -- //
    // A code that came from the board carries who approved it and when; that fills the owner sentence when none was given
    const statement = String(input.ownerSaid ?? boardSentence(used.note) ?? '').slice(0, 300);
    withLockSync(lockOf(ref), () => {
        const before = readStoreSafe(input.org, input.name);
        // Values of an earlier import stay, unless they belong to another Supabase project (mail values do not depend on one)
        const sameProject = !before || !supaNames.length || !before.testRef || before.testRef === testRef;
        const keep = before
            ? Object.fromEntries(Object.entries(before.values).filter(([, e]) => sameProject || e.mail))
            : {};
        const inbox = mailNames.length ? (input.testInbox ?? null) : (before?.testInbox ?? null);
        // Each import remembers its own env file and keys, so a refresh reads every key from the file it came from
        const groups = [
            ...(before?.source.groups ?? [])
                .map((g) => ({ ...g, keys: g.keys.filter((k) => !names.includes(k)) }))
                .filter((g) => g.keys.length),
            { file: realFile, keys: names, statement }
        ];
        // The chain gets its line first: a store never exists without one. It names keys and the test inbox, never a value
        appendAudit(action, {
            project: ref,
            keys: names.join(','),
            serviceKeys: service.join(','),
            testRef: supaNames.length ? testRef : '',
            testInbox: mailNames.length ? (input.testInbox ?? '') : '',
            file: fileName,
            approval: 'approved with code',
            ownerSaid: statement.slice(0, 150)
        });
        writeStore(input.org, input.name, {
            version: 1,
            ref,
            testRef: supaNames.length ? testRef : (before?.testRef ?? null),
            testInbox: inbox,
            importedAt: new Date().toISOString(),
            statement,
            source: {
                groups,
                allowServiceRole: Boolean(input.allowServiceRole || before?.source.allowServiceRole)
            },
            values: { ...keep, ...entries }
        });
    });
    return {
        keys: names,
        serviceKeys: service,
        testRef: supaNames.length ? testRef : null,
        testInbox: mailNames.length ? (input.testInbox ?? null) : null
    };
}
/** The names (never the values) kept for a registration, and which of them is a service key. */
export function listSecrets(org, name) {
    const doc = readStore(org, name);
    if (!doc)
        return { keys: [], serviceKeys: [], testRef: null, testInbox: null };
    return {
        keys: Object.keys(doc.values).sort(),
        serviceKeys: Object.entries(doc.values)
            .filter(([, e]) => e.service)
            .map(([k]) => k)
            .sort(),
        testRef: doc.testRef,
        testInbox: doc.testInbox,
        importedAt: doc.importedAt
    };
}
/** Removes the sealed secrets of a registration. Returns true when there were any. */
export function forgetSecrets(org, name) {
    const ref = refOf(org, name);
    let had = false;
    withLockSync(lockOf(ref), () => {
        try {
            readFileSync(fileOf(org, name));
            had = true;
        }
        catch {
            had = false;
        }
        rmSync(fileOf(org, name), { force: true });
    });
    appendAudit('secrets-forget', { project: ref, had });
    return had;
}
/**
 * Reads the same env file and keys again (the owner's sentence, test project and test inbox stay as they were), so a changed .env needs one command and no value
 * is typed. A refresh needs a fresh approval code like any import, so an agent cannot trigger it alone. A store made from more than one env file is refreshed
 * by importing each again.
 */
export function refreshSecrets(opts) {
    const doc = readStore(opts.org, opts.name);
    const ref = refOf(opts.org, opts.name);
    const group = doc?.source.groups[0];
    if (!doc || !group)
        throw new Error(`Nothing was imported for ${ref} that can be read again. Import it: ${helpOf(ref)}`);
    if (doc.source.groups.length > 1)
        throw new Error(`${ref} was imported from more than one env file. Refresh by importing each again with its own approval code.`);
    const r = importSecrets({
        org: opts.org,
        name: opts.name,
        repo: opts.repo,
        file: group.file,
        keys: group.keys,
        testRef: doc.testRef ?? undefined,
        testInbox: doc.testInbox ?? undefined,
        ownerSaid: group.statement || doc.statement,
        allowServiceRole: doc.source.allowServiceRole,
        approval: opts.approval,
        action: 'secrets-refresh'
    });
    return { keys: r.keys };
}
/** The one inbox a preview of this registration may send mail to, or null when it has no sealed mail settings. */
export function mailInboxOf(org, name) {
    const doc = readStoreSafe(org, name);
    return doc && Object.values(doc.values).some((e) => e.mail) ? (doc.testInbox ?? null) : null;
}
/** Plain sentences for doctor about a store that is damaged or unusable. Never puts a value into the text. */
export function storeProblems(org, name) {
    const ref = refOf(org, name);
    try {
        const doc = readStore(org, name);
        if (doc &&
            Object.values(doc.values).some((e) => e.mail) &&
            !EMAIL.test(String(doc.testInbox ?? '')))
            return [
                `The sealed mail settings of ${ref} have no test inbox, so a preview would not be given them.`
            ];
        return [];
    }
    catch (e) {
        return [e.message];
    }
}
// -- USING THEM -- //
/** The setting names that keep a service key out of the build: a key that bypasses row-level security reaches only the start step. */
export const omitKeys = (env, keys = []) => Object.fromEntries(Object.entries(env).filter(([k]) => !keys.includes(k)));
/** Every form a value could show up in a log: as it is, address-encoded and base64 (padded and not). */
function forms(v) {
    const b64 = Buffer.from(v, 'utf8').toString('base64');
    return [...new Set([v, encodeURIComponent(v), b64, b64.replace(/=+$/, '')])].filter((x) => x.length >= 4);
}
/**
 * Fills {secret:NAME} in a recipe's env from the sealed store of the registration. The same env comes back when there is no placeholder.
 * A name that is not imported is a plain error that tells the agent the command to run. The sealed URL must still belong to the ref it was imported for.
 */
export function resolveSealedEnv(org, name, env) {
    const wanted = Object.entries(env).filter(([, v]) => typeof v === 'string' && SECRET_PLACEHOLDER.test(v));
    if (!wanted.length)
        return {
            env,
            startOnly: [],
            hosts: [],
            redactions: [],
            testRef: null,
            filled: [],
            mailInbox: null
        };
    const ref = refOf(org, name);
    const doc = readStore(org, name);
    if (!doc)
        throw new Error(`Missing: the recipe of ${ref} names sealed keys, but none are imported (invalid environment variables for this run). Import them: ${helpOf(ref)}`);
    const out = { ...env };
    const startOnly = [];
    const redactions = [];
    for (const [k, v] of wanted) {
        const secretName = SECRET_PLACEHOLDER.exec(v)[1];
        const entry = doc.values[secretName];
        if (!entry)
            throw new Error(`Missing: the recipe of ${ref} names the sealed key ${secretName}, but it is not imported (invalid environment variables for this run). Import it: ${helpOf(ref)}`);
        if (!SECRET_ENV_KEY.test(k))
            throw new Error(`${k} may not be given a sealed value.`);
        // A mail value goes to a mail setting and a Supabase value to a Supabase setting, never across
        if (isMailKey(k) !== isMailKey(secretName) || (isMailKey(k) && k !== secretName))
            throw new Error(`${k} may not be given the sealed value ${secretName}: a mail setting takes only the sealed value of its own name.`);
        if (entry.service && CLIENT_NAME.test(k))
            throw new Error(`${k} is a setting the browser bundle carries, so a service key may not be given to it.`);
        out[k] = entry.v;
        // A key that bypasses row-level security, and every mail setting, reaches the start step only
        if (entry.service || isMailKey(k))
            startOnly.push(k);
        redactions.push(...forms(entry.v));
    }
    // The URL in the store has to be the project's own address, still: a store that was edited or made for another ref is not used
    let host = null;
    for (const [key, entry] of Object.entries(doc.values))
        if (URL_KEY.test(key)) {
            const h = new URL(entry.v).hostname;
            if (!doc.testRef || h !== hostFor(doc.testRef))
                throw new Error(`The sealed ${key} of ${ref} does not belong to its project ref any more. Import the secrets again: ${helpOf(ref)}`);
            host = h;
        }
    // Mail settings reach the preview only with the inbox the guard sends to; without one the run stops
    const mail = wanted.some(([k]) => isMailKey(k));
    if (mail && !EMAIL.test(String(doc.testInbox ?? '')))
        throw new Error(`The sealed mail settings of ${ref} have no test inbox. Import them again: ${helpOf(ref)}`);
    return {
        env: out,
        startOnly,
        hosts: host ? [host] : [],
        redactions: [...new Set(redactions)],
        testRef: doc.testRef,
        filled: wanted.map(([k]) => k),
        mailInbox: mail ? doc.testInbox : null
    };
}
