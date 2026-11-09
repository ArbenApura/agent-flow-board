// THE ROOTS: THE FOLDERS THE OWNER APPROVED AS PARENTS OF REGISTERED REPOS. At most five, sealed with an HMAC so a hand-written list is refused. A root is never a drive,
// the home folder (or a folder above it), the bridge home or a folder of keys and logins. Adding or removing one needs a single-use approval code (approve.ts).
// -- DEP-MODULES -- //
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
// -- MODULES -- //
import { appendAudit } from './audit.js';
import { Refusal, consumeApproval, sameMac, seal, writeFileAtomic } from './approve.js';
import { withLockSync } from './lock.js';
import { rootsFile } from './paths.js';
import { configDir } from '../tokenStore.js';
// -- CONSTANTS -- //
export const MAX_ROOTS = 5;
const SECRET_FOLDERS = ['.ssh', '.gnupg', '.aws', '.kube', '.docker'];
// -- FUNCTIONS -- //
function realOrResolved(p) {
    try {
        return realpathSync.native(resolve(p));
    }
    catch {
        return resolve(p);
    }
}
/** True when `child` is `parent` or below it. Both are real paths already; Windows compares without case (path.relative does). */
export function insideOrSame(parent, child) {
    const rel = relative(parent, child);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
/** The real path of a folder that may be a root, or a Refusal with one plain sentence. */
export function cleanRoot(raw) {
    const text = String(raw ?? '').trim();
    if (!text)
        throw new Refusal('No folder is given.');
    let real;
    try {
        real = realpathSync.native(resolve(text));
    }
    catch {
        throw new Refusal(`The folder ${resolve(text)} does not exist.`);
    }
    if (!statSync(real).isDirectory())
        throw new Refusal(`${real} is not a folder.`);
    if (parse(real).root === real)
        throw new Refusal(`${real} is the top of a drive. Name the folder that holds your projects.`);
    if (insideOrSame(real, realOrResolved(homedir())))
        throw new Refusal(`${real} is your home folder or above it. Name a folder inside it that holds your projects.`);
    const bridge = realOrResolved(configDir());
    if (insideOrSame(real, bridge) || insideOrSame(bridge, real))
        throw new Refusal(`${real} is or holds the bridge home, which holds the sign-in. It cannot be a root.`);
    if (real.split(sep).some((s) => SECRET_FOLDERS.includes(s.toLowerCase())))
        throw new Refusal(`${real} is in a folder that holds keys or logins (.ssh, .gnupg, .aws, .kube or .docker), so it cannot be a root.`);
    return real;
}
const sealOf = (roots) => seal('roots', JSON.stringify({ version: 1, roots }));
/** The roots and, when the file cannot be trusted, one sentence saying why (the list is then empty). */
export function readRoots() {
    const file = rootsFile();
    if (!existsSync(file))
        return { roots: [], problem: null };
    try {
        const doc = JSON.parse(readFileSync(file, 'utf8'));
        const body = doc && typeof doc === 'object' ? doc.body : null;
        const mac = doc && typeof doc === 'object' ? doc.mac : null;
        const roots = body && typeof body === 'object' ? body.roots : null;
        if (typeof mac !== 'string' ||
            !Array.isArray(roots) ||
            !roots.every((r) => typeof r === 'string'))
            return {
                roots: [],
                problem: 'The roots file is not one this tool wrote, so no root counts.'
            };
        const list = roots;
        if (!sameMac(sealOf(list), mac))
            return {
                roots: [],
                problem: 'The roots file was not written by "check roots" on this machine, so no root counts.'
            };
        return { roots: list, problem: null };
    }
    catch {
        return { roots: [], problem: 'The roots file cannot be read, so no root counts.' };
    }
}
export const listRoots = () => readRoots().roots;
function writeRoots(roots) {
    writeFileAtomic(rootsFile(), JSON.stringify({ body: { version: 1, roots }, mac: sealOf(roots) }, null, 2) + '\n');
}
/**
 * The root that holds `repo`, compared by real path so a link or a `..` cannot step out, or null. A root that was fine when it was added but now leads
 * somewhere the rules forbid (a junction put in its place) no longer counts.
 */
export function rootHolding(repo, roots = listRoots()) {
    let real;
    try {
        real = realpathSync.native(resolve(repo));
    }
    catch {
        return null;
    }
    for (const r of roots) {
        let root;
        try {
            root = cleanRoot(r);
        }
        catch {
            continue;
        }
        if (insideOrSame(root, real))
            return root;
    }
    return null;
}
/** Adds a root. Needs an approval code for the action "roots" and this folder. The code is used only when everything else is fine. */
export function addRoot(dir, approval) {
    const real = cleanRoot(dir);
    return withLockSync('roots', () => {
        const roots = readRoots().roots;
        if (roots.some((r) => insideOrSame(r, real) && insideOrSame(real, r)))
            return real;
        if (roots.length >= MAX_ROOTS)
            throw new Refusal(`There are already ${MAX_ROOTS} roots. Remove one first (check roots remove <folder> --approval <code>).`);
        if (!approval || !consumeApproval('roots', real, approval))
            throw new Refusal(`Adding a root needs a code from the owner: check approve --request --action roots --target "${real}", then --approval <code>.`);
        writeRoots([...roots, real]);
        appendAudit('root added', { folder: real, count: roots.length + 1 });
        return real;
    });
}
/** Removes a root. Needs an approval code too, so an agent cannot swap one root for another. */
export function removeRoot(dir, approval) {
    const real = realOrResolved(dir);
    return withLockSync('roots', () => {
        const roots = readRoots().roots;
        const hit = roots.find((r) => insideOrSame(r, real) && insideOrSame(real, r));
        if (!hit)
            throw new Refusal(`${real} is not a root.`);
        if (!approval || !consumeApproval('roots', real, approval))
            throw new Refusal(`Removing a root needs a code from the owner: check approve --request --action roots --target "${real}", then --approval <code>.`);
        writeRoots(roots.filter((r) => r !== hit));
        appendAudit('root removed', { folder: hit, count: roots.length - 1 });
        return hit;
    });
}
