// THE SETUP COMMAND: PUT THE BRIDGE'S CLAUDE CODE HOOKS INTO A REPO'S SETTINGS FILE WITHOUT TOUCHING ANYTHING ELSE IN IT.
// An earlier rule said the bridge never edits a tool's settings by itself (settings.ts). This command is the one place that does, and
// only when the person or an agent runs it on purpose: it merges, it keeps every hook that is not the bridge's, it backs the file up
// outside the repo first, and it refuses a file it cannot read as plain JSON instead of guessing.
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hookSettings } from './settings.js';
// -- CONSTANTS -- //
/** A command of the bridge's Claude hook, whatever its server, organisation or timeout. */
const BRIDGE_HOOK = /(^|[\\/\s"'])agent-flow-board(\.cmd|\.exe)?["']?\s+hook\s+claude\b/;
// -- FUNCTIONS -- //
const isBridge = (entry) => Array.isArray(entry.hooks) &&
    entry.hooks.length > 0 &&
    entry.hooks.every((h) => typeof h.command === 'string' && BRIDGE_HOOK.test(h.command));
/**
 * What the settings file should hold after setup. `existing` is the file's text, or null when there is none. Hooks of the bridge are
 * replaced (so a run with another organisation changes them, and a second run changes nothing); every other hook, key and entry stays.
 */
export function planSetup(existing, server, org) {
    const generated = hookSettings('claude', server, org);
    if (!generated)
        return { ok: false, error: 'No hook settings for Claude Code.' };
    const wanted = JSON.parse(generated).hooks ?? {};
    let settings = {};
    if (existing !== null && existing.trim() !== '') {
        try {
            const parsed = JSON.parse(existing);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return { ok: false, error: 'The settings file is not a JSON object.' };
            settings = parsed;
        }
        catch {
            return {
                ok: false,
                error: 'The settings file is not plain JSON (a comment or a trailing comma?), so it was not changed. Add the hooks by hand: agent-flow-board hooks print claude --server <address> --org <slug>'
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
    for (const [event, entries] of Object.entries(wanted)) {
        const current = Array.isArray(hooks[event]) ? hooks[event] : [];
        const others = current.filter((e) => !isBridge(e));
        const ours = current.filter(isBridge);
        kept += others.length;
        // The bridge's entries go last and in a fixed order, so running it again gives the same file
        hooks[event] = [...others, ...entries];
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
        changed
    };
}
/** Where the backup of a repo's settings file goes: the bridge's own folder, never the repo, so it cannot be committed by accident. */
export function backupPath(configDir, file, now = Date.now()) {
    const key = createHash('sha256').update(resolve(file)).digest('hex').slice(0, 12);
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    return join(configDir, 'backups', `${key}-${stamp}.bak`);
}
/** Runs the setup for one repo folder. Writes the file atomically; backs the old one up first. Never throws. */
export function runSetup(options) {
    try {
        const file = join(options.repo, '.claude', options.shared ? 'settings.json' : 'settings.local.json');
        const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
        const plan = planSetup(existing, options.server, options.org);
        if (!plan.ok)
            return { ok: false, error: `${file}: ${plan.error}` };
        if (!plan.changed)
            return {
                ok: true,
                file,
                changed: false,
                added: 0,
                replaced: 0,
                kept: plan.kept,
                backup: null
            };
        let backup = null;
        if (existing !== null) {
            backup = backupPath(options.configDir, file, options.now);
            mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
            writeFileSync(backup, existing, { mode: 0o600 });
        }
        mkdirSync(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, plan.text);
        renameSync(temp, file);
        return {
            ok: true,
            file,
            changed: true,
            added: plan.added,
            replaced: plan.replaced,
            kept: plan.kept,
            backup
        };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
