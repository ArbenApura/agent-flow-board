// THE FLOW STATUS MOD: SHOWS THE ITEM THE BOARD SAYS THIS CONVERSATION IS WORKING ON.
// It asks the board's read only lookup (GET /api/v1/orgs/<org>/sessions/by-external/<session id>), keeps the last answer in
// $.state (a reload keeps it) and draws one line: above the prompt on the terminal and the desktop app, and in a pane or a
// transcript row on VS Code, whose surface does not raise the band above the prompt.

import { atom, read, update } from 'claude-code';
import type { EngineInterface, PluginOptions, Register } from 'claude-code';

import type { View } from '../types';
import { drawLine } from './draw';
import { INITIAL, POLL_MS, SHAPE, lookupUrl, nextView } from './status';
import type { Outcome } from './status';

// -- CONSTANTS -- //

const NAME = 'afb-flow-status';
const PANE = 'afb-flow-status';
const ROW = 'afb-flow-status';
/** The board's own tools: after one of them ran, the claim or the progress may have moved. */
const BOARD_TOOLS = /^mcp__afb-[a-z0-9-]+__(work_start|step_done|item_status|work_stop)$/;
// The plugin name and the key are literals, which the validator reads
const view = atom({ plugin: 'afb-flow-status', key: 'view' } as const, INITIAL, { shape: SHAPE });

// -- STATES -- //

// The module's own variables start over on a reload, so they hold only what is safe to repeat
let isAsking = false;
let isSeated = false;
let isAgain = false;

// -- FUNCTIONS -- //

const setting = (options: PluginOptions, name: string) => String(options[name] ?? '').trim();

/** One lookup. A timer calls it every poll; a board tool that ran calls it at once with `isForced`. */
async function refresh($: EngineInterface, options: PluginOptions, isForced: boolean) {
	if (isAsking) {
		// A board tool ran while an answer was on its way: that answer may be older than the change, so ask once more after it
		if (isForced) isAgain = true;
		return;
	}
	isAsking = true;
	try {
		const now = await $.clock.now();
		const current = await read($, view);
		if (!isForced && now < current.nextAt) return;
		const server = setting(options, 'server');
		const org = setting(options, 'org');
		const token = setting(options, 'token');
		if (!server || !org || !token) {
			await update($, view, (v): View => ({ ...v, kind: 'setup', item: null, etag: null }));
			return;
		}
		const conversationId = await $.session.id();
		const canSendEtag = current.kind === 'ok' || current.kind === 'none';
		let outcome: Outcome;
		try {
			// No x-session-id: that header would make the board treat every poll as a heartbeat of the session
			const res = await $.http.fetch(
				lookupUrl(server, org, conversationId, canSendEtag ? current.etag : null),
				{ headers: { authorization: `Bearer ${token}`, accept: 'application/json' } }
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
	} finally {
		isAsking = false;
	}
	if (isAgain) {
		isAgain = false;
		await refresh($, options, true);
	}
}

/** On VS Code the band above the prompt is not raised, so the line goes in a pane, or in a row when no pane is drawn. */
async function seat($: EngineInterface) {
	if (isSeated) return;
	const surfaces = await $.session.surfaces();
	if (!surfaces.includes('vscode')) return;
	isSeated = true;
	const opened = await $.ui.open({ id: PANE, title: 'Flow item' });
	if (!opened.isPlaced) {
		try {
			await $.ui.place({ id: ROW });
		} catch {
			// An older engine has no transcript row: the line then shows only where a pane or the band is drawn
		}
	}
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
		void refresh($, options, true);
		await seat($);
		return next(e);
	});

	// The surface may attach after the start, so the first prompt tries again
	on('prompt.submit', async ($, e, next) => {
		await seat($);
		return next(e);
	});

	on('command.run', { command: 'afb-status' }, async ($) => {
		const opened = await $.ui.open({ id: PANE, title: 'Flow item' });
		return { text: opened.isPlaced ? 'Flow item pane opened.' : 'No pane could be drawn here.' };
	});

	on('tool.call', { tool: BOARD_TOOLS }, async ($, e, next) => {
		const result = await next(e);
		await refresh($, options, true);
		return result;
	});

	on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
		if (e.props.hasSurvey) return next(e);
		return drawLine($, e, await read($, view), await $.clock.now(), {
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

	on('ui.render', { component: 'Placed', props: { plugin: NAME, id: ROW } }, async ($, e) =>
		drawLine($, e, await read($, view), await $.clock.now(), {
			hasDetails: false,
			onToggle: () => update($, view, toggle)
		})
	);
};
