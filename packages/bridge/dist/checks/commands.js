// THE COMMANDS `check project`, `check approve` AND `check roots`. Plain handlers: they take the arguments after the command word and a small context, print through it and return
// an exit code (0 done, 1 refused with the problems listed, 2 could not run). Nothing here reads a terminal. `check approve` only asks whether it IS on a terminal, because a code is
// made by the owner and never by an agent.
// -- DEP-MODULES -- //
import { isatty } from 'node:tty';
// -- MODULES -- //
import { APPROVAL_ACTIONS, Refusal, UsageError, isApprovalAction, mintApproval } from './approve.js';
import { forgetRegistration, hasState, pinRegistration, pinState, readRegistrations, registerProject } from './registry.js';
import { addRoot, listRoots, readRoots, removeRoot } from './roots.js';
// -- CONSTANTS -- //
const BOOLEAN_FLAGS = new Set([
    '--recipe',
    '--remove',
    '--adopt-env',
    '--upload-pictures',
    '--json'
]);
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
    '  project list [--org <slug>]  |  project forget <NAME> --org <slug> [--remove]  |  project pin <NAME> --org <slug>'
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
 * `env.isTTY` is for the tests; the command itself passes the real flag of the terminal.
 */
export async function approveCommand(args, ctx, env = {}) {
    return guarded(ctx, () => {
        const p = parse(args);
        const action = need(p, '--action');
        if (!isApprovalAction(action))
            throw new UsageError(`--action is one of ${APPROVAL_ACTIONS.join(', ')}.`);
        const target = need(p, '--target');
        const isTTY = env.isTTY ?? (isatty(0) && isatty(1));
        const made = mintApproval(action, target, { isTTY });
        show(ctx, { action, target, code: made.code, expiresAt: made.expiresAt }, [
            `Approval code for ${action} on ${target}: ${made.code}`,
            `It works once and expires at ${made.expiresAt}. Give it to the command that asked for it, with --approval.`
        ]);
        return 0;
    });
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
