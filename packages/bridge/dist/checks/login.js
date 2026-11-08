// `check login <NAME> --org <slug> [--seeded]`: SAVING A SIGN-IN FOR A REGISTRATION'S SITE, AND THE RULES FOR USING ONE
// --seeded signs in with a seeded account (AFB_CHECKS_<NAME>_EMAIL and _PASSWORD) or the recipe's test user, through the app's own form.
// Without --seeded a person signs in by hand in a visible browser window: that needs an interactive terminal, and is refused without one.
// This file is the ONE place in the bridge that reads a terminal, and only in waitForEnter, only after the TTY check.
// Nothing here starts a preview itself: the caller injects `target`, and the sign in function is injected too, so tests launch no browser.
// A cookie, a password or a token is never printed.
// -- DEP-MODULES -- //
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
// -- MODULES -- //
import { loadPlaywright } from './browser.js';
import { ORG_SLUG, registrationsDir } from './paths.js';
import { expiryNote, loadProfileChecked, saveProfile } from './profiles.js';
import { redact } from './redact.js';
import { signInWithPassword } from './signin.js';
// -- CONSTANTS -- //
const NAME = /^[A-Za-z0-9_-]{1,32}$/;
// -- FUNCTIONS -- //
/** The variable names of a registration: AFB_CHECKS_<NAME upper, dash to underscore>_EMAIL and _PASSWORD. */
export function envNames(name) {
    const n = String(name).toUpperCase().replace(/-/g, '_');
    return { email: `AFB_CHECKS_${n}_EMAIL`, password: `AFB_CHECKS_${n}_PASSWORD` };
}
/** The seeded account of a registration from the environment, or null when either variable is missing or empty. */
export function seededAccount(name, env = process.env) {
    const n = envNames(name);
    const email = env[n.email];
    const password = env[n.password];
    return email && password ? { email, password } : null;
}
/**
 * Whether a run uses a saved sign-in. Only when the script's header (or the check) names the very registration the run uses: a run that was
 * routed there by a fallback, or a script that names another registration, opens signed out. Names compare without regard to case.
 */
export function chooseState(input) {
    const { registration, scriptRegistration, profile } = input;
    if (!profile || !scriptRegistration || !registration)
        return 'none';
    return scriptRegistration.toLowerCase() === registration.toLowerCase() ? 'saved' : 'none';
}
/** Pictures of a signed-in run are uploaded only when the owner opted in on the registration. A signed-out run uploads as usual. */
export function pictureUploadAllowed(registration, signedIn) {
    return !signedIn || registration.uploadSignedInPictures === true;
}
/** The saved sign-in a run should open with, with the expiry note, or null. Applies chooseState. */
export function savedStateFor(input) {
    const { profile, damaged } = loadProfileChecked(input.org, input.registration, input.bindKey);
    // A saved sign-in that cannot be opened says so: the run would otherwise go signed out and fail on a sign-in page with no explanation
    if (damaged)
        return {
            profile: null,
            note: 'The saved sign-in is damaged, make it again (agent-flow-board check login).'
        };
    if (chooseState({ ...input, profile }) !== 'saved' || !profile)
        return null;
    return { profile, note: expiryNote(profile) };
}
/** Cookies and origins that belong to the site's hosts, nothing else (no other site's sign-in is saved). */
export function keepRelated(state, hosts) {
    const s = state;
    const bare = (d) => d.replace(/^\./, '').toLowerCase();
    const related = (d) => hosts.some((h) => {
        const a = bare(d);
        const b = h.toLowerCase();
        return a === b || b.endsWith(`.${a}`) || a.endsWith(`.${b}`);
    });
    return {
        cookies: (s?.cookies ?? []).filter((c) => related(String(c.domain ?? ''))),
        origins: (s?.origins ?? []).filter((o) => {
            try {
                return related(new URL(String(o.origin)).hostname);
            }
            catch {
                return false;
            }
        })
    };
}
/** The one terminal read of the bridge: waits for the person to press Enter. Used only by the headed login, after the TTY check. */
function waitForEnter(question) {
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, () => {
            rl.close();
            resolve();
        });
    });
}
/** The headed login: a visible browser the person drives, then Enter. Only cookies and origins of the site are kept. */
async function headedLogin(target, say) {
    const { chromium } = await loadPlaywright();
    const browser = await chromium.launch({ headless: false });
    try {
        const ctx = await browser.newContext({ baseURL: target.baseUrl, viewport: null });
        const page = await ctx.newPage();
        await page.goto(target.baseUrl);
        say(`A browser window is open on ${target.baseUrl}. Sign in there the way you normally do (a password or Google).`);
        say('When you can see you are signed in, come back here and press Enter. Do not close the window first.');
        await waitForEnter('Press Enter when signed in... ');
        const hosts = [new URL(target.baseUrl).hostname, ...(target.hosts ?? [])];
        return keepRelated(await ctx.storageState(), hosts);
    }
    finally {
        await browser.close().catch(() => undefined);
    }
}
function loadRegistrationFile(org, name) {
    try {
        return JSON.parse(readFileSync(join(registrationsDir(), org, `${name}.json`), 'utf8'));
    }
    catch {
        return null;
    }
}
/** The default target: only a live site needs no preview. A repo registration needs the caller to start its preview. */
async function defaultTarget(registration) {
    if (!registration.url)
        throw new Error(`${registration.name} is built from a repo, so its sign-in needs a preview. Start one through the run command.`);
    return {
        baseUrl: registration.url,
        hosts: registration.extraHosts ?? [],
        stop: async () => undefined
    };
}
function flagValue(args, flag) {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
}
/** `check login <NAME> --org <slug> [--seeded]`. Exit code 0 saved, 1 a problem with what was asked, 2 could not run. */
export async function loginCommand(args, ctx) {
    const deps = {
        signIn: (baseUrl, account) => signInWithPassword(baseUrl, account),
        headed: headedLogin,
        isTTY: Boolean(process.stdin.isTTY),
        env: process.env,
        loadRegistration: loadRegistrationFile,
        target: defaultTarget,
        save: saveProfile,
        ...ctx.deps
    };
    const say = (line) => ctx.log(line);
    const flags = new Set(['--org']);
    const positional = args.filter((a, i) => !a.startsWith('--') && !flags.has(args[i - 1] ?? ''));
    const name = positional[0];
    const org = flagValue(args, '--org');
    const seeded = args.includes('--seeded');
    if (!name || !org) {
        say('Usage: check login <NAME> --org <slug> [--seeded]');
        return 1;
    }
    if (!NAME.test(name) || !ORG_SLUG.test(org)) {
        say('The registration name or the organisation is not a plain name.');
        return 1;
    }
    // A headed login waits for a person at a screen: without a terminal it would wait for ever, so it stops at once
    if (!seeded && !deps.isTTY) {
        say('Signing in by hand needs a person at a terminal (it opens a browser window and waits), so it is refused here. Use --seeded with AFB_CHECKS_<NAME>_EMAIL and AFB_CHECKS_<NAME>_PASSWORD set, or a registration whose recipe has a test user.');
        return 1;
    }
    const registration = deps.loadRegistration(org, name);
    if (!registration || registration.org !== org) {
        say(`No registration "${name}" in ${org}.`);
        return 1;
    }
    let target = null;
    const secrets = [];
    try {
        target = await deps.target(registration);
        const bindKey = new URL(target.baseUrl).origin;
        let state;
        if (seeded) {
            const account = seededAccount(name, deps.env) ?? target.testUser ?? null;
            if (!account) {
                const n = envNames(name);
                say(`No account to sign in with. Set ${n.email} and ${n.password}, or give the recipe a test user.`);
                return 1;
            }
            secrets.push(account.password);
            state = await deps.signIn(target.baseUrl, account);
        }
        else {
            state = await deps.headed(target, say);
        }
        const kept = state;
        if (!kept || (!(kept.cookies?.length ?? 0) && !(kept.origins?.length ?? 0))) {
            say('Nothing was saved because the browser holds no sign-in for this address.');
            return 1;
        }
        deps.save(org, name, bindKey, state);
        say(`Saved the sign-in for ${org}/${name} on ${bindKey}. It stays on this machine, sealed.`);
        if (ctx.json)
            ctx.out(JSON.stringify({ saved: true, registration: `${org}/${name}`, site: bindKey }));
        return 0;
    }
    catch (e) {
        say(redact(e instanceof Error ? e.message : String(e), secrets));
        return 2;
    }
    finally {
        await target?.stop().catch(() => undefined);
    }
}
