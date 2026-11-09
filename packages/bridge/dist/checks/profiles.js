// SAVED SIGN-INS: ONE SEALED FILE PER REGISTRATION AND SITE
// A saved sign-in is the browser state (cookies and local storage) of a person signed in to one site. It is sealed with the bridge's key, bound
// to the registration and the site address (the AAD), and lives under that registration's own state folder. It is used only for the site it
// was saved for, and it never reaches a check except through the child's stdin.
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { ensureDir, ORG_SLUG, stateDirFor } from './paths.js';
import { renameRetry } from './fsretry.js';
import { seal, unseal } from './store.js';
// -- CONSTANTS -- //
const NAME = /^[A-Za-z0-9_-]{1,32}$/;
/** The profile every registration has when none is named. Its file name and seal are the ones saved sign-ins always had. */
export const DEFAULT_PROFILE = 'default';
/** A named profile: lower case letters, digits and dashes, so it can never reach a file path. */
export const PROFILE_NAME = /^[a-z0-9-]{1,32}$/;
/** A repo registration's sign-in is bound to this machine's loopback, not to a preview port (the port changes on every run). */
export const LOOPBACK_BIND = '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const FILE = /^[0-9a-f]{16}\.enc$/;
const enc = new TextEncoder();
const dec = new TextDecoder();
// -- FUNCTIONS -- //
function check(org, name) {
    if (!ORG_SLUG.test(org))
        throw new Error('The organisation is not a slug.');
    if (!NAME.test(name))
        throw new Error('The registration name is not a plain name.');
}
const profilesDir = (org, name) => {
    check(org, name);
    return join(stateDirFor(org, name), 'profiles');
};
/** The file name for a site address: 16 hex characters of its hash. */
export const fileNameFor = (bindKey) => `${createHash('sha256').update(bindKey).digest('hex').slice(0, 16)}.enc`;
const aadFor = (org, name, bindKey) => `profile:${org}/${name}:${bindKey}`;
/** Throws one plain sentence when a profile name is not 'default' or a plain lower case name. */
export function assertProfileName(profile) {
    if (profile === DEFAULT_PROFILE || PROFILE_NAME.test(profile))
        return profile;
    throw new Error('A profile name is 1 to 32 lower case letters, digits or dashes, for example read-only.');
}
/** The key a sign-in is stored under: the site (or the loopback) for the default profile, with the profile name added for a named one. */
export function profileKey(base, profile) {
    const p = profile ? assertProfileName(profile) : DEFAULT_PROFILE;
    return p === DEFAULT_PROFILE ? base : `${base}#${p}`;
}
/** What a repo registration's sign-in binds to (the loopback, never a port) and a live site's (its origin). */
export function bindBaseFor(registration, origin) {
    return registration.repo ? LOOPBACK_BIND : origin;
}
/**
 * A saved browser state with every loopback origin of its local storage moved to the preview this run started: the port of a preview changes on every run,
 * and a session kept in local storage belongs to the origin it was made on. Cookies carry no port and are left as they are.
 */
export function retargetOrigins(state, baseUrl) {
    const s = state;
    if (!s || !Array.isArray(s.origins))
        return state;
    const target = new URL(baseUrl).origin;
    return {
        ...s,
        origins: s.origins.map((o) => {
            try {
                return LOOPBACK_HOSTS.has(new URL(String(o.origin)).hostname)
                    ? { ...o, origin: target }
                    : o;
            }
            catch {
                return o;
            }
        })
    };
}
/** Saves (replaces) the sign-in of one registration and site. Returns the file name, not the path. */
export function saveProfile(org, name, bindKey, state, meta = {}) {
    if (!bindKey)
        throw new Error('A saved sign-in needs the address of the site.');
    const dir = ensureDir(profilesDir(org, name));
    const file = fileNameFor(bindKey);
    const profileName = meta.profile ? assertProfileName(meta.profile) : DEFAULT_PROFILE;
    const profile = {
        bindKey,
        savedAt: new Date().toISOString(),
        state,
        profile: profileName,
        sealedHost: meta.sealedHost ?? null
    };
    const blob = seal(aadFor(org, name, bindKey), enc.encode(JSON.stringify(profile)));
    const tmp = join(dir, `${file}.${process.pid}.tmp`);
    writeFileSync(tmp, blob, { mode: 0o600 });
    renameRetry(tmp, join(dir, file));
    // The address, the profile name and the sealed host are not secrets: a plain index lets a listing name them without opening the sealed file
    writeFileSync(indexPath(org, name, file), JSON.stringify({ bindKey, profile: profileName, sealedHost: meta.sealedHost ?? null }), { mode: 0o600 });
    return file;
}
/** The saved sign-in for exactly this registration and site, or null (none, damaged, or saved for another address). */
export function loadProfile(org, name, bindKey) {
    return loadProfileChecked(org, name, bindKey).profile;
}
/** The same, and says when a file is there but cannot be opened (damaged, or sealed for another address), so a run does not go signed out without saying so. */
export function loadProfileChecked(org, name, bindKey) {
    const path = join(profilesDir(org, name), fileNameFor(bindKey));
    if (!existsSync(path))
        return { profile: null, damaged: false };
    try {
        const raw = unseal(aadFor(org, name, bindKey), readFileSync(path));
        const p = JSON.parse(dec.decode(raw));
        return p && p.bindKey === bindKey
            ? { profile: p, damaged: false }
            : { profile: null, damaged: true };
    }
    catch {
        return { profile: null, damaged: true };
    }
}
/** A plain sentence when every timed cookie has run out, so a run can say so before it fails on a sign-in page. */
export function expiryNote(profile) {
    const cookies = profile?.state?.cookies ?? [];
    const now = Date.now() / 1000;
    const timed = cookies.filter((c) => typeof c.expires === 'number' && c.expires > 0);
    return timed.length && timed.every((c) => c.expires < now)
        ? 'The saved sign-in has expired.'
        : null;
}
/** Which sites have a saved sign-in: file, address and date, never a cookie or a value. The address is read from the plain index beside each file. */
export function listProfiles(org, name) {
    const dir = profilesDir(org, name);
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const file of readdirSync(dir).filter((f) => FILE.test(f))) {
        let bindKey = '(unknown)';
        let profile = DEFAULT_PROFILE;
        let sealedHost = null;
        try {
            const index = JSON.parse(readFileSync(indexPath(org, name, file), 'utf8'));
            bindKey = String(index.bindKey ?? bindKey);
            profile = String(index.profile ?? DEFAULT_PROFILE);
            sealedHost = index.sealedHost ?? null;
        }
        catch {
            /* No index: the file is still listed */
        }
        out.push({
            file,
            bindKey,
            savedAt: statSync(join(dir, file)).mtime.toISOString(),
            profile,
            sealedHost
        });
    }
    return out;
}
/** Removes every saved sign-in of one profile of a registration (the default when none is named). Returns how many went. */
export function removeProfilesNamed(org, name, profile) {
    const wanted = profile ? assertProfileName(profile) : DEFAULT_PROFILE;
    let removed = 0;
    for (const entry of listProfiles(org, name))
        if (entry.profile === wanted && removeProfile(org, name, entry.file))
            removed++;
    return removed;
}
const indexPath = (org, name, file) => join(profilesDir(org, name), file + '.site');
/** Removes one saved sign-in by its exact file name. True when a file went. */
export function removeProfile(org, name, file) {
    if (!FILE.test(file))
        throw new Error('That is not a saved sign-in file name.');
    const dir = profilesDir(org, name);
    let removed = false;
    for (const f of [file, `${file}.site`]) {
        const p = join(dir, f);
        if (existsSync(p)) {
            rmSync(p, { force: true });
            removed ||= f === file;
        }
    }
    return removed;
}
