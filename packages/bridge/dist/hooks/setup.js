// THE SETUP COMMAND: PUT THE BRIDGE'S CLAUDE CODE HOOKS INTO A REPO'S SETTINGS FILE WITHOUT TOUCHING ANYTHING ELSE IN IT.
// An earlier rule said the bridge never edits a tool's settings by itself (settings.ts). This command is the one place that does, and
// only when the person or an agent runs it on purpose: it merges, it keeps every hook that is not the bridge's, it backs the file up
// outside the repo first, and it refuses a file it cannot read as plain JSON instead of guessing.
// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { hookSettings, validServer } from './settings.js';
// -- CONSTANTS -- //
/** A command of the bridge's hook for one tool, whatever its server, organisation or timeout. Each tool only recognises its own. */
const BRIDGE_HOOK = {
    claude: /(^|[\\/\s"'])agent-flow-board(\.cmd|\.exe)?["']?\s+hook\s+claude\b/,
    codex: /(^|[\\/\s"'])agent-flow-board(\.cmd|\.exe)?["']?\s+hook\s+codex\b/
};
// -- FUNCTIONS -- //
const isBridge = (entry, tool) => Array.isArray(entry.hooks) &&
    entry.hooks.length > 0 &&
    entry.hooks.every((h) => typeof h.command === 'string' && BRIDGE_HOOK[tool].test(h.command));
/** The hooks of a settings file's text, or none when it is missing or not plain JSON. */
function hooksOf(text) {
    if (!text || text.trim() === '')
        return {};
    try {
        const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
        const hooks = parsed && typeof parsed === 'object' ? parsed.hooks : undefined;
        return hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? hooks : {};
    }
    catch {
        return {};
    }
}
/** Whether the shared file already runs every command of this entry, for the same matcher, so a local copy would run it twice. */
function coveredBy(shared, entry) {
    if (!Array.isArray(shared) || !entry.hooks?.length)
        return false;
    return entry.hooks.every((h) => shared.some((s) => (s.matcher ?? '') === (entry.matcher ?? '') &&
        Array.isArray(s.hooks) &&
        s.hooks.some((x) => x.command === h.command)));
}
/**
 * What the settings file should hold after setup. `existing` is the file's text, or null when there is none. Hooks of the bridge are
 * replaced (so a run with another organisation changes them, and a second run changes nothing); every other hook, key and entry stays.
 * `shared` is the text of the repo's shared settings.json when this file is the local one: an entry it already runs (same command, same
 * matcher) is not written here again, and a copy already here is removed, because both files are read and the hook would run twice.
 */
export function planSetup(existing, server, org, tool = 'claude', shared = null) {
    const name = tool === 'codex' ? 'Codex' : 'Claude Code';
    // The address goes into a command that runs on every event, so it must be a plain http(s) address
    const checked = validServer(server);
    if (!checked)
        return {
            ok: false,
            error: 'The server address must be a plain http or https address, with no spaces, quotes or sign in details.'
        };
    const generated = hookSettings(tool, checked, org);
    if (!generated)
        return { ok: false, error: `No hook settings for ${name}.` };
    const wanted = JSON.parse(generated).hooks ?? {};
    let settings = {};
    if (existing !== null && existing.trim() !== '') {
        try {
            // A byte order mark (some Windows editors write one) is not part of the JSON
            const parsed = JSON.parse(existing.replace(/^\uFEFF/, ''));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return { ok: false, error: 'The settings file is not a JSON object.' };
            settings = parsed;
        }
        catch {
            return {
                ok: false,
                error: `The settings file is not plain JSON (a comment or a trailing comma?), so it was not changed. Add the hooks by hand: agent-flow-board hooks print ${tool} --server <address> --org <slug>`
            };
        }
    }
    if (settings.hooks !== undefined &&
        (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)))
        return { ok: false, error: 'The "hooks" key of the settings file is not an object.' };
    const hooks = { ...(settings.hooks ?? {}) };
    let added = 0;
    let replaced = 0;
    let kept = 0;
    let covered = 0;
    const sharedHooks = hooksOf(shared);
    for (const [event, all] of Object.entries(wanted)) {
        // What the shared file already runs is left to it
        const entries = all.filter((e) => !coveredBy(sharedHooks[event], e));
        covered += all.length - entries.length;
        const current = Array.isArray(hooks[event]) ? hooks[event] : [];
        const others = current.filter((e) => !isBridge(e, tool));
        const ours = current.filter((e) => isBridge(e, tool));
        kept += others.length;
        // The bridge's entries replace its own where they are, and go last when there are none yet, so running it again (for this tool or
        // another) gives the same file
        const merged = [];
        let placed = false;
        for (const e of current) {
            if (!isBridge(e, tool))
                merged.push(e);
            else if (!placed) {
                merged.push(...entries);
                placed = true;
            }
        }
        if (!placed)
            merged.push(...entries);
        // An event left with nothing is dropped, so the file holds no empty list
        if (merged.length > 0)
            hooks[event] = merged;
        else
            delete hooks[event];
        const same = JSON.stringify(ours) === JSON.stringify(entries);
        if (ours.length === 0)
            added += entries.length;
        else if (!same)
            replaced += entries.length;
    }
    // Events the file has that the bridge does not use stay as they are
    for (const [event, entries] of Object.entries(hooks))
        if (!(event in wanted) && Array.isArray(entries))
            kept += entries.length;
    const next = { ...settings, hooks };
    // Compared as data, so a file that only differs in how it is spaced is left as the person wrote it
    const changed = existing === null || JSON.stringify(settings) !== JSON.stringify(next);
    return {
        ok: true,
        text: JSON.stringify(next, null, '\t') + '\n',
        added,
        replaced,
        kept,
        covered,
        changed
    };
}
/** Where the backup of a repo's settings file goes: the bridge's own folder, never the repo, so it cannot be committed by accident. */
export function backupPath(configDir, file, now = Date.now()) {
    const key = createHash('sha256').update(resolve(file)).digest('hex').slice(0, 12);
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    return join(configDir, 'backups', `${key}-${stamp}.bak`);
}
/** The hook file Codex reads: the repo's, or the person's own (which fixes one organisation for every repo). */
const codexFile = (root) => join(root, '.codex', 'hooks.json');
/** Runs the setup for one repo folder. Writes the file atomically; backs the old one up first. Never throws. */
export function runSetup(options) {
    try {
        const tool = options.tool ?? 'claude';
        const home = options.home ?? homedir();
        const warnings = [];
        const file = tool === 'codex'
            ? codexFile(options.global ? home : options.repo)
            : join(options.repo, '.claude', options.shared ? 'settings.json' : 'settings.local.json');
        if (tool === 'codex') {
            if (options.global)
                warnings.push(`${file} is read by every Codex project, so every one of them now reports to the organisation ${options.org}. Use the repo file (leave out --global) when you work for more than one organisation.`);
            // Codex reads every hook file it finds, so the bridge hooks in both would run twice
            const other = codexFile(options.global ? options.repo : home);
            try {
                // The repo can be the home folder itself: then the other file is this one
                if (resolve(other) !== resolve(file) &&
                    existsSync(other) &&
                    BRIDGE_HOOK.codex.test(readFileSync(other, 'utf8')))
                    warnings.push(`${other} already holds the bridge hooks, so every event would be sent twice. Keep one of the two files.`);
            }
            catch {
                /* An unreadable other file is not a reason to stop */
            }
        }
        if (options.onPath === false)
            warnings.push('agent-flow-board was not found on the PATH, and the hook command needs it. Install it once with: npm install -g @agent-flow-board/bridge');
        // A linked settings file (a dotfiles repo) is written through the link, with its own permissions, so the link stays
        // A link whose target does not exist yet is followed too, so a dotfiles link is never replaced by a plain file
        let target = file;
        if (existsSync(file))
            target = realpathSync(file);
        else if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
            target = resolve(dirname(file), readlinkSync(file));
        const existing = existsSync(target) ? readFileSync(target, 'utf8') : null;
        // The local Claude file is read next to the shared one, so a hook the shared file runs is not written here again
        const sharedFile = join(options.repo, '.claude', 'settings.json');
        const shared = tool === 'claude' && !options.shared && existsSync(sharedFile)
            ? readFileSync(sharedFile, 'utf8')
            : null;
        const plan = planSetup(existing, options.server, options.org, tool, shared);
        if (!plan.ok)
            return { ok: false, error: `${file}: ${plan.error}` };
        if (plan.covered > 0)
            warnings.push(`${sharedFile} already runs ${plan.covered} of these hook entries, so they are not repeated in ${file} (a hook in both files runs twice).`);
        if (!plan.changed)
            return {
                ok: true,
                file,
                changed: false,
                added: 0,
                replaced: 0,
                kept: plan.kept,
                backup: null,
                warnings
            };
        let backup = null;
        if (existing !== null) {
            backup = backupPath(options.configDir, target, options.now);
            mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
            writeFileSync(backup, existing, { mode: 0o600 });
        }
        mkdirSync(dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.tmp`;
        try {
            writeFileSync(temp, plan.text, existing !== null ? { mode: statSync(target).mode & 0o777 } : {});
            renameSync(temp, target);
        }
        catch (error) {
            // No stray temp file is left in the repo to be committed by accident
            rmSync(temp, { force: true });
            throw error;
        }
        return {
            ok: true,
            file,
            changed: true,
            added: plan.added,
            replaced: plan.replaced,
            kept: plan.kept,
            backup,
            warnings
        };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
