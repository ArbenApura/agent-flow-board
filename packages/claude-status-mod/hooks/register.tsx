// THE FLOW STATUS MOD: SHOWS THE ITEM THE BOARD SAYS THIS CONVERSATION IS WORKING ON.
// It asks the board's read only lookup (GET /api/v1/orgs/<org>/sessions/by-external/<session id>), keeps the last answer in
// $.state (a reload keeps it) and draws one line: above the prompt on the terminal and the desktop app, and in a pane or a
// transcript row on VS Code, whose surface does not raise the band above the prompt.

import { atom, read, update } from 'claude-code';
import type { EngineInterface, PluginOptions, Register } from 'claude-code';

import type { View } from '../types';
import { drawLine } from './draw';
import {
	FILE_POLL_MS,
	FILE_RENEW_MS,
	INITIAL,
	POLL_MS,
	SHAPE,
	hookOrgOf,
	isQuiet,
	lookupUrl,
	nextView,
	pickOrg,
	readStatusFile,
	statusPaths
} from './status';
import type { Outcome } from './status';

// -- CONSTANTS -- //

const PANE = 'afb-flow-status';
/** The board's own tools: after one of them ran, the claim or the progress may have moved. */
const BOARD_TOOLS = /^mcp__afb-[a-z0-9-]+__(work_start|step_done|item_status|work_stop)$/;
// The plugin name and the key are literals, which the validator reads
const view = atom({ plugin: 'afb-flow-status', key: 'view' } as const, INITIAL, { shape: SHAPE });

// -- STATES -- //

// The module's own variables start over on a reload, so they hold only what is safe to repeat
let inflight: Promise<void> | null = null;

// -- FUNCTIONS -- //

const setting = (options: PluginOptions, name: string) => String(options[name] ?? '').trim();

/** The organisation the repo's own hooks send to, found in the project's Claude settings; null when it cannot be told. */
async function hookOrg($: EngineInterface): Promise<string | null> {
	try {
		const cwd = await $.session.cwd();
		for (const file of ['settings.local.json', 'settings.json']) {
			try {
				const found = hookOrgOf(await $.fs.read(`${cwd}/.claude/${file}`));
				if (found) return found;
			} catch {
				// A missing file is normal
			}
		}
	} catch {
		// No working directory to look in
	}
	return null;
}

/**
 * One lookup. A timer calls it every poll and skips it while one is on its way; a board tool that ran calls it at once with
 * `isForced` and waits for the lookup in flight first, because that answer may be older than the change.
 */
async function refresh($: EngineInterface, options: PluginOptions, isForced: boolean) {
	if (inflight) {
		if (!isForced) return;
		await inflight.catch(() => undefined);
	}
	const run = ask($, options, isForced);
	inflight = run;
	try {
		await run;
	} finally {
		if (inflight === run) inflight = null;
	}
}

/**
 * The status the bridge wrote for this conversation, or null when there is none worth trusting. The bridge's hooks write it, so
 * it needs no token and no setting here. Any problem (no file, bad text, old) means the old way is used instead.
 */
async function fromFile(
	$: EngineInterface,
	conversationId: string,
	now: number
): Promise<unknown | null> {
	try {
		const env = {
			bridgeHome: await $.env.get('AFB_BRIDGE_HOME'),
			userProfile: await $.env.get('USERPROFILE'),
			home: await $.env.get('HOME')
		};
		for (const path of statusPaths(env, conversationId)) {
			try {
				const found = readStatusFile(await $.fs.read(path), conversationId, now);
				if (found) return found;
			} catch {
				// A missing file is normal: this conversation is not fed by the bridge
			}
		}
	} catch {
		// No environment to read: the old way is used
	}
	return null;
}

/** One look at the file. It changes the view only when the file is there, and says nothing when it is not. */
async function refreshFromFile($: EngineInterface): Promise<boolean> {
	const now = await $.clock.now();
	const status = await fromFile($, await $.session.id(), now);
	if (!status) return false;
	await update($, view, (v) => {
		const next = nextView(v, { status: 200, body: status }, now);
		// The same answer again changes nothing, so the line does not redraw every few seconds. But it is a fresh answer: its time is
		// renewed now and then, or a claim that stays the same for three minutes would be drawn as an old answer
		if (v.etag === next.etag && v.kind === next.kind)
			return now - v.goodAt < FILE_RENEW_MS ? v : { ...v, goodAt: now, failures: 0 };
		return { ...next, nextAt: now + POLL_MS };
	});
	return true;
}

async function ask($: EngineInterface, options: PluginOptions, isForced: boolean) {
	const now = await $.clock.now();
	const current = await read($, view);
	if (!isForced && now < current.nextAt) return;
	// The bridge's status file first: no token, no setting. The lookup below is the way for a conversation without one.
	if (await refreshFromFile($)) return;
	const server = setting(options, 'server');
	const picked = pickOrg(
		[
			{ org: setting(options, 'org'), token: setting(options, 'token') },
			{ org: setting(options, 'org2'), token: setting(options, 'token2') }
		],
		await hookOrg($)
	);
	if (!server || !picked) {
		// At the very start the bridge's file may not be written yet: stay quiet, and say the setting is missing only when asked again
		if (!isForced) return;
		await update($, view, (v): View => ({ ...v, kind: 'setup', item: null, etag: null }));
		return;
	}
	const conversationId = await $.session.id();
	const canSendEtag = current.kind === 'ok' || current.kind === 'none';
	let outcome: Outcome;
	try {
		// No x-session-id: that header would make the board treat every poll as a heartbeat of the session
		const res = await $.http.fetch(
			lookupUrl(server, picked.org, conversationId, canSendEtag ? current.etag : null),
			{ headers: { authorization: `Bearer ${picked.token}`, accept: 'application/json' } }
		);
		let body: unknown = null;
		try {
			body = JSON.parse(res.text);
		} catch {
			body = null;
		}
		outcome = { status: res.status, body };
	} catch {
		// The reason is never shown: an error text could carry the address or the token
		outcome = { failed: true };
	}
	await update($, view, (v) => nextView(v, outcome, now));
}

const toggle = (v: View): View => ({ ...v, isExpanded: !v.isExpanded });

// -- HOOKS -- //

export const register: Register = (on, options) => {
	on('session.start', async ($, e, next) => {
		await $.command.register({
			name: 'afb-status',
			description: 'Show the flow item of this conversation in a pane'
		});
		// A little jitter, so many conversations do not all ask in the same second
		$.clock.every(POLL_MS + Math.floor(Math.random() * 10_000), () => refresh($, options, false));
		// The status file changes at each hook, so it is looked at much more often than the board is asked
		$.clock.every(FILE_POLL_MS, () => void refreshFromFile($).catch(() => undefined));
		void refresh($, options, false);
		return next(e);
	});

	on('prompt.submit', async ($, e, next) => {
		// The hooks create this conversation's board session around now, so look again in a few seconds
		$.clock.after(4000, () => refresh($, options, true));
		return next(e);
	});

	on('command.run', { command: 'afb-status' }, async ($) => {
		const opened = await $.ui.open({ id: PANE, title: 'Flow item' });
		// Ask again now and say what was asked, so a "not found" can be checked against the conversation id the hooks use
		await refresh($, options, true);
		const now = await read($, view);
		const id = await $.session.id();
		const where = opened.isPlaced ? 'Flow item pane opened.' : 'No pane could be drawn here.';
		return { text: `${where} Asked the board about conversation ${id}: ${now.kind}.` };
	});

	on('tool.call', { tool: BOARD_TOOLS }, async ($, e, next) => {
		const result = await next(e);
		await refresh($, options, true);
		return result;
	});

	on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
		if (e.props.hasSurvey) return next(e);
		const current = await read($, view);
		// Nothing claimed, nothing to say: the band stays out of the way
		if (isQuiet(current)) return next(e);
		return drawLine($, e, current, await $.clock.now(), {
			hasDetails: false,
			onToggle: () => update($, view, toggle)
		});
	});

	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
		drawLine($, e, await read($, view), await $.clock.now(), {
			hasDetails: true,
			onToggle: () => update($, view, toggle)
		})
	);
};
