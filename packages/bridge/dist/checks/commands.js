// THE COMMANDS `check project`, `check approve` AND `check roots`. Plain handlers: they take the arguments after the command word and a small context, print through it and return
// an exit code (0 done, 1 refused with the problems listed, 2 could not run). Nothing here reads a terminal. `check approve` only asks whether it IS on a terminal, because a code is
// made by the owner and never by an agent.
// -- DEP-MODULES -- //
import { isatty } from 'node:tty';
// -- MODULES -- //
import { APPROVAL_ACTIONS, Refusal, UsageError, isApprovalAction, mintApproval } from './approve.js';
import { forgetRegistration, hasState, pinRegistration, pinState, readRegistrations, registerProject } from './registry.js';
import { appendAudit } from './audit.js';
import { assertProfileName, DEFAULT_PROFILE, listProfiles, removeProfilesNamed } from './profiles.js';
import { addRoot, listRoots, readRoots, removeRoot } from './roots.js';
import { ASK_LIMIT, askOwner, parseEntries } from './askBoard.js';
// -- CONSTANTS -- //
const BOOLEAN_FLAGS = new Set([
    '--recipe',
    '--remove',
    '--adopt-env',
    '--upload-pictures',
    '--request',
    '--json'
]);
/** Most codes one `check approve --many` makes (the approvals file keeps 20). */
const MANY_LIMIT = 15;
// -- FUNCTIONS -- //
function parse(args) {
    const pos = [];
    const flags = new Map();
    for (let i = 0; i < args.length; i++) {
        const a = args[i] ?? '';
        if (!a.startsWith('--')) {
            pos.push(a);
            continue;
        }
        const eq = a.indexOf('=');
        if (eq > 0) {
            flags.set(a.slice(0, eq), a.slice(eq + 1));
        }
        else if (BOOLEAN_FLAGS.has(a)) {
            flags.set(a, true);
        }
        else {
            const next = args[i + 1];
            if (next === undefined || next.startsWith('--'))
                throw new UsageError(`${a} needs a value.`);
            flags.set(a, next);
            i++;
        }
    }
    return { pos, flags };
}
const text = (p, name) => {
    const v = p.flags.get(name);
    return typeof v === 'string' ? v : undefined;
};
function need(p, name) {
    const v = text(p, name);
    if (!v)
        throw new UsageError(`${name} is needed.`);
    return v;
}
/** Runs a handler body and turns what it throws into an exit code and one plain line. */
async function guarded(ctx, body) {
    try {
        return await body();
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        ctx.log(message);
        return e instanceof Refusal ? 1 : 2;
    }
}
const show = (ctx, value, lines) => {
    if (ctx.json)
        ctx.out(JSON.stringify(value));
    else
        for (const l of lines)
            ctx.out(l);
};
export const PROJECT_USAGE = [
    '  project <NAME> --org <slug> --repo <dir> [--app-dir web] [--board-project KEY] [--recipe] [--extra-hosts a,b]',
    '  project <NAME> --org <slug> --url https://site [--board-project KEY] [--extra-hosts a,b] --approval <code>',
    '  project list [--org <slug>]  |  project forget <NAME> --org <slug> [--remove | --profile <name>]  |  project pin <NAME> --org <slug>  |  project profiles <NAME> --org <slug>'
].join('\n');
/** `check project ...`: register, list, forget or pin a registration. */
export async function projectCommand(args, ctx) {
    return guarded(ctx, async () => {
        const p = parse(args);
        const json = ctx.json || p.flags.has('--json');
        const c = { ...ctx, json };
        const sub = p.pos[0];
        if (!sub)
            throw new UsageError(`Say what to do.\n${PROJECT_USAGE}`);
        if (sub === 'list') {
            const org = text(p, '--org');
            const { registrations, problems } = readRegistrations(org);
            const rows = registrations.map((r) => ({
                org: r.org,
                name: r.name,
                boardProject: r.boardProject,
                kind: r.url ? 'site' : 'repo',
                repo: r.repo ?? null,
                appDir: r.appDir ?? null,
                url: r.url ?? null,
                pin: pinState(r),
                adoptEnv: r.adoptEnv,
                state: hasState(r.org, r.name)
            }));
            show(c, { registrations: rows, problems }, [
                ...rows.map((r) => `${r.org}/${r.name}  serves ${r.boardProject}  ${r.url ?? `${r.repo}${r.appDir ? ` (${r.appDir})` : ''}`}  pin ${r.pin}${r.adoptEnv ? '  adopts .env' : ''}${r.state ? '  holds state' : ''}`),
                ...(rows.length ? [] : ['No registrations.']),
                ...problems
            ]);
            return problems.length ? 1 : 0;
        }
        if (sub === 'profiles') {
            const name = p.pos[1];
            if (!name)
                throw new UsageError('profiles needs a registration name.');
            const entries = listProfiles(need(p, '--org'), name).map((e) => ({
                profile: e.profile,
                savedAt: e.savedAt,
                site: e.bindKey.replace(/#.*$/, ''),
                testProject: e.sealedHost
            }));
            show(c, { registration: name, profiles: entries }, [
                ...entries.map((e) => `${e.profile}  saved ${e.savedAt}  on ${e.site}${e.testProject ? `  test project ${e.testProject}` : ''}`),
                ...(entries.length ? [] : [`${name} has no saved sign-ins.`])
            ]);
            return 0;
        }
        if (sub === 'forget' && text(p, '--profile') !== undefined) {
            const name = p.pos[1];
            if (!name)
                throw new UsageError('forget needs a registration name.');
            const profile = assertProfileName(text(p, '--profile'));
            const removed = removeProfilesNamed(need(p, '--org'), name, profile);
            if (removed)
                appendAudit('login forgotten', { registration: `${need(p, '--org')}/${name}`, profile });
            show(c, { registration: name, profile, removed }, [
                removed
                    ? `Removed the saved sign-in "${profile}" of ${name}.`
                    : `${name} has no saved sign-in "${profile === DEFAULT_PROFILE ? DEFAULT_PROFILE : profile}".`
            ]);
            return 0;
        }
        if (sub === 'forget') {
            const name = p.pos[1];
            if (!name)
                throw new UsageError('forget needs a registration name.');
            const r = forgetRegistration(need(p, '--org'), name, { remove: p.flags.has('--remove') });
            show(c, r, [
                `${r.removed ? 'Removed' : 'Forgot the saved state of'} ${r.name}${r.hadState ? '' : ' (it held none)'}.`
            ]);
            return 0;
        }
        if (sub === 'pin') {
            const name = p.pos[1];
            if (!name)
                throw new UsageError('pin needs a registration name.');
            const r = pinRegistration(need(p, '--org'), name);
            show(c, { ...r, before: r.before?.slice(0, 12) ?? null, after: r.after.slice(0, 12) }, [
                r.changed
                    ? `Pinned ${r.name}: ${r.before ? r.before.slice(0, 12) : 'none'} -> ${r.after.slice(0, 12)} (${r.files.join(', ') || 'no files'}).`
                    : `${r.name} is already pinned (${r.after.slice(0, 12)}).`
            ]);
            return 0;
        }
        if (p.pos.length > 1)
            throw new UsageError(`Unexpected "${p.pos[1]}".\n${PROJECT_USAGE}`);
        const hosts = text(p, '--extra-hosts');
        const input = {
            org: need(p, '--org'),
            name: sub,
            ...(text(p, '--board-project') ? { boardProject: text(p, '--board-project') } : {}),
            ...(text(p, '--repo') ? { repo: text(p, '--repo') } : {}),
            ...(text(p, '--app-dir') ? { appDir: text(p, '--app-dir') } : {}),
            ...(text(p, '--url') ? { url: text(p, '--url') } : {}),
            ...(hosts
                ? {
                    extraHosts: hosts
                        .split(',')
                        .map((h) => h.trim())
                        .filter(Boolean)
                }
                : {}),
            recipe: p.flags.has('--recipe'),
            adoptEnv: p.flags.has('--adopt-env'),
            uploadSignedInPictures: p.flags.has('--upload-pictures')
        };
        const approvals = {
            ...(text(p, '--approval') ? { register: text(p, '--approval') } : {}),
            ...(text(p, '--adopt-env-approval')
                ? { adoptEnv: text(p, '--adopt-env-approval') }
                : {}),
            ...(text(p, '--pictures-approval')
                ? { pictures: text(p, '--pictures-approval') }
                : {})
        };
        const reg = registerProject(input, approvals);
        show(c, { org: reg.org, name: reg.name, boardProject: reg.boardProject, database: reg.database }, [
            `Registered ${reg.org}/${reg.name} for ${reg.boardProject}${reg.url ? ` (live site ${new URL(reg.url).hostname})` : ''}. The files that decide what runs are pinned by "check project pin ${reg.name} --org ${reg.org}" or the first run in the folder.`
        ]);
        return 0;
    });
}
/**
 * `check approve --action <register|secrets|adopt-env|roots|pictures> --target <name or folder>`: the owner's single-use code. Refused without an interactive terminal.
 * `check approve --many "<action>:<target>;<action>:<target>"` makes several codes in one call (at most 15) under the same rule.
 * `env.isTTY` is for the tests; the command itself passes the real flag of the terminal.
 */
export async function approveCommand(args, ctx, env = {}) {
    return guarded(ctx, async () => {
        const p = parse(args);
        const isTTY = env.isTTY ?? (isatty(0) && isatty(1));
        // ASKING THE OWNER ON THE BOARD (no terminal): --request, --request-many or --resume
        if (p.flags.has('--request') || p.flags.has('--request-many') || p.flags.has('--resume'))
            return await requestOnBoard(p, ctx);
        // MANY CODES IN ONE CALL
        // Same rules as one code: a terminal only, one action and one target per code, single use, ten minutes. All entries are checked before any code is made.
        const many = text(p, '--many');
        if (many !== undefined) {
            if (p.flags.has('--action') || p.flags.has('--target'))
                throw new UsageError('Use --many on its own, or --action with --target.');
            const entries = many
                .split(';')
                .map((e) => e.trim())
                .filter(Boolean)
                .map((e) => {
                const at = e.indexOf(':');
                const kind = at > 0 ? e.slice(0, at).trim() : '';
                const target = at > 0 ? e.slice(at + 1).trim() : '';
                if (!isApprovalAction(kind) || !target)
                    throw new UsageError(`"${e.slice(0, 60)}" is not <action>:<target>. Actions: ${APPROVAL_ACTIONS.join(', ')}.`);
                return { action: kind, target };
            });
            if (!entries.length)
                throw new UsageError('--many needs at least one <action>:<target>.');
            if (entries.length > MANY_LIMIT)
                throw new UsageError(`--many makes at most ${MANY_LIMIT} codes at once.`);
            const codes = entries.map((e) => {
                const made = mintApproval(e.action, e.target, { isTTY });
                return { action: e.action, target: e.target, code: made.code, expiresAt: made.expiresAt };
            });
            show(ctx, { codes }, [
                ...codes.map((c) => `Approval code for ${c.action} on ${c.target}: ${c.code}`),
                `Each works once and expires at ${codes[0]?.expiresAt ?? ''}. Give each to the command that asked for it, with --approval.`
            ]);
            return 0;
        }
        const action = need(p, '--action');
        if (!isApprovalAction(action))
            throw new UsageError(`--action is one of ${APPROVAL_ACTIONS.join(', ')}.`);
        const target = need(p, '--target');
        const made = mintApproval(action, target, { isTTY });
        show(ctx, { action, target, code: made.code, expiresAt: made.expiresAt }, [
            `Approval code for ${action} on ${target}: ${made.code}`,
            `It works once and expires at ${made.expiresAt}. Give it to the command that asked for it, with --approval.`
        ]);
        return 0;
    });
}
/**
 * `check approve --request --action <x> --target <t> [--why "<sentence>"] [--wait <minutes>]`, `--request-many "<action>:<target>;..."` and `--resume <id,id>`.
 * Files the request on the board, prints the page link, waits for the owner's click (default 10 minutes) and prints the codes. Exit 0 approved, 1 refused or expired,
 * 2 could not ask, 3 still waiting (the ids to resume are printed).
 */
async function requestOnBoard(p, ctx) {
    if (!ctx.board)
        throw new UsageError('Asking on the board needs the check command with --server and --org.');
    const many = text(p, '--request-many');
    const resume = text(p, '--resume');
    const minutes = text(p, '--wait') === undefined ? 10 : Number(text(p, '--wait'));
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60)
        throw new UsageError('--wait takes a whole number of minutes from 0 to 60.');
    let entries = [];
    if (resume === undefined) {
        if (many !== undefined) {
            if (p.flags.has('--action') || p.flags.has('--target'))
                throw new UsageError('Use --request-many on its own, or --request with --action and --target.');
            entries = parseEntries(many);
        }
        else {
            const action = need(p, '--action');
            if (!isApprovalAction(action))
                throw new UsageError(`--action is one of ${APPROVAL_ACTIONS.join(', ')}.`);
            entries = [{ action, target: need(p, '--target') }];
        }
    }
    const ids = resume
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (ids &&
        (!ids.length || ids.length > ASK_LIMIT || ids.some((i) => !/^[0-9a-f-]{36}$/i.test(i))))
        throw new UsageError('--resume takes the ids that were printed, separated by commas.');
    const done = await askOwner(ctx.board(), {
        entries,
        why: text(p, '--why'),
        project: text(p, '--project'),
        waitMinutes: minutes,
        resume: ids,
        say: (line) => ctx.log(line),
        signal: ctx.signal
    });
    if (done.state === 'waiting') {
        const list = done.ids.join(',');
        show(ctx, { state: 'waiting', ids: done.ids, link: done.link, resume: list }, [
            `Still waiting for the owner. Pick it up again with: agent-flow-board check approve --resume ${list} --wait 10`
        ]);
        return 3;
    }
    show(ctx, { state: 'approved', codes: done.codes }, [
        ...done.codes.map((c) => `Approval code for ${c.action} on ${c.target}: ${c.code}`),
        `Each works once and expires at ${done.codes[0]?.expiresAt ?? ''}. Give each to the command that asked for it, with --approval.`
    ]);
    return 0;
}
/** `check roots add <dir> --approval <code> | list | remove <dir> --approval <code>`. */
export async function rootsCommand(args, ctx) {
    return guarded(ctx, () => {
        const p = parse(args);
        const sub = p.pos[0] ?? 'list';
        if (sub === 'list') {
            const { roots, problem } = readRoots();
            show(ctx, { roots, problem }, [
                ...(roots.length
                    ? roots
                    : ['No roots. The owner adds one: check roots add <folder> --approval <code>.']),
                ...(problem ? [problem] : [])
            ]);
            return problem ? 1 : 0;
        }
        const dir = p.pos[1];
        if (!dir)
            throw new UsageError(`${sub} needs a folder.`);
        if (sub === 'add') {
            const real = addRoot(dir, text(p, '--approval'));
            show(ctx, { root: real, roots: listRoots() }, [`Root added: ${real}`]);
            return 0;
        }
        if (sub === 'remove') {
            const real = removeRoot(dir, text(p, '--approval'));
            show(ctx, { root: real, roots: listRoots() }, [`Root removed: ${real}`]);
            return 0;
        }
        throw new UsageError('Use: roots add <dir> --approval <code> | roots list | roots remove <dir> --approval <code>');
    });
}
