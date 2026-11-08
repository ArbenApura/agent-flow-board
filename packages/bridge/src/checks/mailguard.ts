// THE TOOL SIDE OF THE MAIL GUARD. The guard itself is mailguard-hook.cts (compiled to mailguard-hook.cjs), loaded into the preview's start step. Here the tool decides when it
// is on (the registration has sealed mail settings), gives it the one test inbox, reads back what it did, and applies the fail-closed rule over the WHOLE mail set: a mail
// setting that did not come from the sealed store is never given to a preview, and a run with sealed mail settings counts only when the guard reported listening on the preview port.
// A recipe cannot ask for the guard, change it or turn it off: the environment is built here after every recipe check.

// -- DEP-MODULES -- //
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// -- MODULES -- //
import { EMAIL, MAIL_SET_NAME } from './sealedNames.js';

// -- TYPES -- //

export type Fence = { loaded: boolean; sends: number; rewritten: number; refused: number };
export type MailRule = {
	env: Record<string, string>;
	/** Mail-set names that did not come from the sealed store and were removed. */
	stripped: string[];
	/** In 'refuse' mode: one plain sentence per such name (names only). Empty means the run may go on. */
	problems: string[];
};

// -- CONSTANTS -- //

/** The run's own mail setting: the mailer is told to only log. It is set by the tool, so it is never counted as an unsealed mail setting. */
const RUN_OWN_MAIL = new Set(['EMAIL_PROVIDER']);

// -- FUNCTIONS -- //

/** The hook file next to this module (dist/checks/mailguard-hook.cjs once built). */
export const GUARD_FILE = join(dirname(fileURLToPath(import.meta.url)), 'mailguard-hook.cjs');

const maskAddress = (a: string) => String(a).replace(/^(.).*@/, '$1***@');

/** Every variable of the whole mail set: POSTMARK, SMTP, SENDGRID, MAILGUN, RESEND, SES and anything with MAIL in its name. */
export const mailSetNames = (env: Record<string, string | undefined>): string[] =>
	Object.keys(env).filter((k) => MAIL_SET_NAME.test(k) && !RUN_OWN_MAIL.has(k.toUpperCase()));

/**
 * Fail closed over the whole mail set. `sealed` is the list of names that were filled from the sealed store (SealedResolution.filled). Any other mail-set name in `env`
 * is stripped ('strip', the default) or listed as a problem so the run refuses ('refuse'). Names only, never a value.
 */
export function enforceMailSet(
	env: Record<string, string>,
	sealed: readonly string[],
	mode: 'strip' | 'refuse' = 'strip'
): MailRule {
	const out = { ...env };
	const stripped: string[] = [];
	const problems: string[] = [];
	for (const k of mailSetNames(env)) {
		if (sealed.includes(k)) continue;
		if (mode === 'strip') {
			delete out[k];
			stripped.push(k);
		} else
			problems.push(
				`${k} is a mail setting that did not come from the sealed store, so this run does not start. Import the mail settings with a test inbox, or remove it.`
			);
	}
	return { env: out, stripped, problems };
}

/**
 * The start environment with the guard loaded and told its inbox. `--require <hook>` is appended to NODE_OPTIONS LAST, so nothing earlier can unload it; a NODE_OPTIONS
 * that was already there is kept in front. A variable spelled in another case (Windows) is folded into the one NODE_OPTIONS.
 */
export function withMailGuard(
	env: Record<string, string>,
	{ inbox, log, hookFile = GUARD_FILE }: { inbox: string; log: string; hookFile?: string }
): Record<string, string> {
	if (!EMAIL.test(inbox))
		throw new Error('The mail guard needs one test inbox that is an email address.');
	if (!log) throw new Error('The mail guard needs a log file to report to.');
	const out: Record<string, string> = {};
	let previous = '';
	for (const [k, v] of Object.entries(env)) {
		if (k.toUpperCase() === 'NODE_OPTIONS') previous = [previous, v].filter(Boolean).join(' ');
		else out[k] = v;
	}
	const req = `--require "${hookFile.replace(/\\/g, '/')}"`;
	out.NODE_OPTIONS = [previous, req].filter(Boolean).join(' ');
	out.AFB_MAIL_FENCE_INBOX = inbox;
	out.AFB_MAIL_FENCE_LOG = log;
	return out;
}

/**
 * What the guard wrote: whether a process of the app loaded it, and how many messages it sent on (rewritten to the test inbox) and refused. `port` is the preview's port:
 * the guard counts as loaded only when a process that has it is listening there, so a launcher (yarn, cross-env) or another runtime cannot stand in for the app.
 */
export function readFence(log: string | null | undefined, port: number | null = null): Fence {
	const out: Fence = { loaded: false, sends: 0, rewritten: 0, refused: 0 };
	if (!log || !existsSync(log)) return out;
	for (const line of readFileSync(log, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as Record<string, unknown>;
			if (e.event === 'listening' && port !== null && Number(e.port) === Number(port))
				out.loaded = true;
			else if (e.event === 'sent') {
				out.sends += Number(e.count) || 0;
				out.rewritten += Number(e.rewritten) || 0;
			} else if (e.event === 'refused') out.refused += 1;
		} catch {
			/* A line the guard did not write completely */
		}
	}
	return out;
}

/** The sentence that stops a run, or null when it may count: sealed mail settings were given and the guard did not report listening on the preview port. */
export function fenceProblem(mailGiven: boolean, fence: Fence): string | null {
	if (!mailGiven || fence.loaded) return null;
	return 'The mail guard did not report listening on the preview port, so mail may not have been fenced. The run does not count.';
}

/** One plain sentence for the run log. */
export const describeFence = (inbox: string, f: Fence): string =>
	`Mail guard on: mail goes only to ${maskAddress(inbox)}. ${f.sends} message(s) sent there (${f.rewritten} rewritten from another recipient), ${f.refused} refused.`;
