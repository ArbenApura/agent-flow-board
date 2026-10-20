// THE SKILL FILES THE BRIDGE WRITES FOR EACH TOOL (AFB-20261018-0622, ADR 6)
// The board is the source of truth; a checkout gets plain files so a tool that reads the disk (and a person reading the repo)
// sees the same skills. Every file is hashed, and a file somebody edited by hand is reported as drift and left alone.
// A skill folder also holds the skill's supporting Markdown files (AFB-20261019-0341), written next to its SKILL.md.
// -- TYPES -- //
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
// -- CONSTANTS -- //
/** Where each tool reads a skill file. Gemini reads .gemini, Antigravity the .agents mirror this repo already keeps. */
export const TARGETS = {
    claude: (name) => `.claude/skills/${name}/SKILL.md`,
    antigravity: (name) => `.agents/skills/${name}/SKILL.md`,
    gemini: (name) => `.gemini/skills/${name}/SKILL.md`
};
export const TARGET_NAMES = Object.keys(TARGETS);
/** The manifest the bridge owns, so it never deletes a file it did not write. */
export const MANIFEST_PATH = '.afb/skills.json';
export const EMPTY_MANIFEST = { version: 1, skills: {} };
/** Windows device names, which cannot be a file name on that system even with an extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const FILE_PATH_MAX = 120;
// -- FUNCTIONS -- //
/** The folder a skill's files are written into for one tool. */
export function skillDir(target, name) {
    return TARGETS[target](name).replace(/\/SKILL\.md$/, '');
}
/**
 * Why a supporting file path cannot be written into a checkout, or null when it is safe. The board checks the same rules,
 * but the bridge writes to a person's disk and so never trusts a path it was handed: relative, forward slashes, no `.` or
 * `..` part, no drive letter, only Markdown. This copy is checked against the same list of paths as the board's own.
 */
export function filePathError(path) {
    if (path.length === 0 || path.length > FILE_PATH_MAX)
        return `A file path is 1 to ${FILE_PATH_MAX} characters.`;
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
    if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(path))
        return `"${path}" holds a character a file path cannot carry.`;
    if (path.startsWith('/'))
        return `"${path}" must be relative.`;
    for (const segment of path.split('/')) {
        if (segment === '' || segment === '.' || segment === '..')
            return `"${path}" must not hold an empty, "." or ".." part.`;
        if (segment.endsWith('.') || segment.endsWith(' '))
            return `"${path}" has a part that ends in a dot or a space.`;
        if (RESERVED_NAMES.test(segment.split('.')[0]))
            return `"${path}" uses a name Windows reserves.`;
    }
    if (!path.toLowerCase().endsWith('.md'))
        return `"${path}" must be a Markdown file.`;
    if (path.toLowerCase() === 'skill.md')
        return 'SKILL.md is the skill itself.';
    return null;
}
/** A SKILL.md: flat front matter with the name and the summary, then the body exactly as the board holds it. */
export function skillFileText(skill) {
    const oneLine = skill.summary.replace(/\s+/g, ' ').trim();
    return `---\nname: ${skill.name}\ndescription: ${oneLine}\n---\n\n${skill.body.replace(/\r\n/g, '\n').trimEnd()}\n`;
}
/** A supporting file as it is written: the text as the board holds it, with one line break at the end. */
export function supportFileText(file) {
    return `${file.body.replace(/\r\n/g, '\n').trimEnd()}\n`;
}
/** The same hash the board uses, so a manifest written here matches the `hash` a read returns. */
export function contentHash(text) {
    // The bridge cannot import the server's helper, so it repeats SHA-256 over the same bytes
    return createHash('sha256').update(text).digest('hex');
}
/**
 * The hash of a skill as the board computes it: name, summary and body, two line breaks apart. Each supporting file then adds
 * its path and its body the same way, in path order, so a skill without files hashes as it always did. The board's own copy
 * is in src/lib/shared/skills.ts, and both are tested against the same two golden values.
 */
export function skillHashOf(skill, files = []) {
    let text = `${skill.name}\n\n${skill.summary}\n\n${skill.body}`;
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const file of sorted)
        text += `\n\n${file.path}\n\n${file.body}`;
    return contentHash(text);
}
/** The tool a written path belongs to, by the folder it sits in. */
function targetOf(name, path) {
    return TARGET_NAMES.find((t) => path.startsWith(`${skillDir(t, name)}/`)) ?? 'claude';
}
/**
 * What to write, keep or remove. A file is ours when the manifest records it and its bytes still hash to what was written;
 * a file somebody edited since is drift, reported and left alone unless `force` is set. A supporting file the board no longer
 * has is removed the same way, only while it is still ours.
 */
export function planSkills(skills, manifest, read, options = {}) {
    const files = [];
    const next = { version: 1, skills: {} };
    const live = new Map(skills.map((s) => [s.name, s]));
    for (const skill of skills) {
        const before = manifest.skills[skill.name];
        const supporting = skill.files ?? [];
        // A path comes from the board and lands on this disk, so a bad one stops the whole run before anything is written
        for (const file of supporting) {
            const bad = filePathError(file.path);
            if (bad)
                throw new Error(`The board returned a file path for "${skill.name}" that is not safe: ${bad}`);
        }
        const written = {};
        // The records of files that drifted on this run, kept so the next run still sees a hand edit rather than a new file
        const kept = {};
        let drifted = false;
        for (const target of TARGET_NAMES) {
            const dir = skillDir(target, skill.name);
            const entries = [
                { path: TARGETS[target](skill.name), text: skillFileText(skill) },
                ...supporting.map((f) => ({ path: `${dir}/${f.path}`, text: supportFileText(f) }))
            ];
            for (const { path, text } of entries) {
                const existing = read(path);
                if (existing === null) {
                    files.push({ target, path, action: 'create', text });
                    written[path] = contentHash(text);
                    continue;
                }
                if (existing === text) {
                    files.push({ target, path, action: 'unchanged' });
                    written[path] = contentHash(text);
                    continue;
                }
                // Ours to overwrite when the manifest recorded these exact bytes at this path
                const ours = before?.files[path] === contentHash(existing);
                if (ours || options.force) {
                    files.push({ target, path, action: 'update', text });
                    written[path] = contentHash(text);
                }
                else {
                    files.push({ target, path, action: 'drift' });
                    if (before?.files[path] !== undefined)
                        kept[path] = before.files[path];
                    drifted = true;
                }
            }
        }
        // A file this skill had before and no longer has: gone from the board, so it goes from the checkout while it is ours
        for (const [path, recorded] of Object.entries(before?.files ?? {})) {
            if (path in written || path in kept)
                continue;
            const existing = read(path);
            if (existing === null)
                continue;
            const target = targetOf(skill.name, path);
            if (contentHash(existing) === recorded)
                files.push({ target, path, action: 'remove' });
            else {
                files.push({ target, path, action: 'drift' });
                kept[path] = recorded;
                drifted = true;
            }
        }
        // A drifted file keeps its old record, so the next run still sees a hand edit rather than treating it as new; the
        // files that were written on this run keep their fresh hashes, so they are not reported as hand edits later
        next.skills[skill.name] = drifted
            ? { hash: before?.hash ?? skill.hash, files: { ...kept, ...written } }
            : { hash: skill.hash, files: written };
    }
    for (const [name, recorded] of Object.entries(manifest.skills)) {
        if (live.has(name))
            continue;
        let kept = false;
        for (const [path, hash] of Object.entries(recorded.files)) {
            const existing = read(path);
            if (existing === null)
                continue;
            const target = targetOf(name, path);
            if (contentHash(existing) === hash) {
                files.push({ target, path, action: 'remove' });
            }
            else {
                files.push({ target, path, action: 'drift' });
                kept = true;
            }
        }
        if (kept)
            next.skills[name] = recorded;
    }
    return { files, manifest: next };
}
/** Reads the manifest a checkout holds. A missing or broken one means the bridge has not written here yet. */
export function parseManifest(text) {
    if (!text)
        return EMPTY_MANIFEST;
    try {
        const parsed = JSON.parse(text);
        if (parsed?.version !== 1 || typeof parsed.skills !== 'object' || !parsed.skills)
            return EMPTY_MANIFEST;
        return parsed;
    }
    catch {
        return EMPTY_MANIFEST;
    }
}
export const manifestText = (manifest) => `${JSON.stringify(manifest, null, '\t')}\n`;
