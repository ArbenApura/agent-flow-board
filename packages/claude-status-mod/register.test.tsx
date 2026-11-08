// TESTS OF THE FLOW STATUS MOD: THE BOARD'S ANSWERS BECOME LINES, ON EVERY SURFACE. RUN WITH: claude plugin test packages/claude-status-mod
import { expect, mock, test } from 'claude-code/testing';

import {
	MAX_BACKOFF_MS,
	POLL_MS,
	nextView,
	plain,
	waitAfter,
	INITIAL,
	hookOrgOf,
	isQuiet,
	pickOrg,
	FILE_STALE_MS,
	readStatusFile,
	statusName,
	statusPaths
} from './hooks/status';

// -- FIXTURES -- //

const SETTINGS = {
	server: 'https://board.example.com',
	org: 'acme',
	token: 'afb_TEST_TOKEN_VALUE_0123456789'
};
const GOOD = {
	sessionId: 's_1',
	tool: 'claude-code',
	externalId: 'conv-0001',
	etag: 'etag-one',
	item: {
		ref: 'ACM-20261108-0412',
		aliases: [],
		title: 'Role enforcement',
		tabName: 'ROLE_ENFORCE',
		status: 'IN PROGRESS',
		percent: 63,
		phase: { key: '2', title: 'Release', position: 2, of: 4 },
		steps: { done: 5, open: 3, waived: 0, total: 8 },
		manualChecksOpen: 1,
		resumeHere: 'Phase 1 is built.',
		blockers: 'None.',
		updatedAt: '2026-11-08T03:22:18.710Z',
		url: 'https://board.example.com/acme/ACM/ACM-20261108-0412'
	}
};
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const;
const BAND = {
	plugin: 'afb-flow-status',
	component: 'AbovePrompt',
	props: {
		hasSurvey: false,
		isWorking: false,
		maxRows: 8,
		bodyColumns: 100,
		scroll: { offset: 0, bodyRows: 8 },
		view: {}
	}
} as const;

const PANE = {
	plugin: 'afb-flow-status',
	component: 'Pane',
	requestId: 'afb-flow-status',
	props: {
		title: 'Flow item',
		isFocused: false,
		bodyColumns: 40,
		placement: 'dock',
		scroll: { offset: 0, bodyRows: 20 },
		view: {}
	}
} as const;

// -- PURE LOGIC -- //

test('the line stays quiet until an item is claimed or something needs the person', () => {
	const ok = nextView(INITIAL, { status: 200, body: GOOD }, 1000);
	expect(isQuiet(INITIAL)).toBe(true);
	expect(isQuiet(nextView(INITIAL, { status: 200, body: { ...GOOD, item: null } }, 1))).toBe(true);
	expect(isQuiet(nextView(INITIAL, { status: 404, body: {} }, 1))).toBe(true);
	expect(isQuiet(nextView(INITIAL, { failed: true }, 1))).toBe(true);
	expect(isQuiet(ok)).toBe(false);
	// An old item is still shown, marked old
	expect(isQuiet(nextView(ok, { failed: true }, 2))).toBe(false);
	// A bad token and a missing setting are shown: only the person can fix them
	expect(isQuiet(nextView(ok, { status: 401, body: {} }, 2))).toBe(false);
	expect(isQuiet({ ...INITIAL, kind: 'setup' })).toBe(false);
});

test('an answer becomes a view, and a failure never shows an old item as current', () => {
	const ok = nextView(INITIAL, { status: 200, body: GOOD }, 1000);
	expect(ok.kind).toBe('ok');
	expect(ok.item?.percent).toBe(63);
	expect(ok.etag).toBe('etag-one');
	// The board is away: the item stays, marked by the line as old
	const away = nextView(ok, { failed: true }, 2000);
	expect(away.kind).toBe('down');
	expect(away.item?.ref).toBe('ACM-20261108-0412');
	expect(away.nextAt).toBe(2000 + waitAfter(1));
	// A bad token or a wrong organisation drops it
	expect(nextView(ok, { status: 401, body: {} }, 2000).item).toBeNull();
	expect(nextView(ok, { status: 404, body: {} }, 2000).kind).toBe('notfound');
	// Unchanged keeps the item and refreshes the time
	const same = nextView(ok, { status: 200, body: { unchanged: true, etag: 'etag-one' } }, 5000);
	expect(same.kind).toBe('ok');
	expect(same.goodAt).toBe(5000);
	// No claim is a normal answer
	expect(nextView(ok, { status: 200, body: { ...GOOD, item: null } }, 3000).kind).toBe('none');
	// A body this mod cannot read is treated as a board that is away, not as no item
	expect(
		nextView(ok, { status: 200, body: { etag: 'x', item: { nonsense: true } } }, 3000).kind
	).toBe('down');
	expect(nextView(ok, { status: 500, body: null }, 3000).kind).toBe('down');
});

test('the wait doubles with every failure and stops at ten minutes', () => {
	expect(waitAfter(0)).toBe(POLL_MS);
	expect(waitAfter(2)).toBe(POLL_MS * 4);
	expect(waitAfter(30)).toBe(MAX_BACKOFF_MS);
});

test('text from the board is one plain, cut line', () => {
	const hostile = `# Heading\n\n<script>alert(1)</script> **bold** [link](https://evil.example)\u0000${'x'.repeat(10_000)}`;
	const out = plain(hostile, 280);
	expect(out.length).toBeLessThanOrEqual(280);
	expect(out).not.toContain('\n');
	expect(out).not.toContain('\u0000');
	// It stays the characters it was: nothing is turned into Markdown or HTML here
	expect(out.startsWith('# Heading <script>alert(1)</script> **bold**')).toBe(true);
	const view = nextView(
		INITIAL,
		{ status: 200, body: { ...GOOD, item: { ...GOOD.item, resumeHere: hostile } } },
		1
	);
	expect(view.item?.resumeHere.length).toBeLessThanOrEqual(280);
});

// -- THE BAND ON EVERY SURFACE -- //

test(
	'the band shows the tab name, reference, phase, percent and status, and never the token',
	{ options: SETTINGS },
	async ($, on) => {
		const seen: { url: string; headers: Record<string, string> }[] = [];
		let conversation = 'conv-0001';
		mock.clock(on, { now: 1_000_000 });
		on('command.register', () => ({ value: { command: 'afb-status' } }));
		on('session.start', (_, e) => ({ cwd: e.cwd }));
		on('session.id', () => ({ value: conversation }));
		on('session.surfaces', () => ({ value: [] }));
		on('tool.call', () => ({ result: {} }));
		on('http.fetch', (_, e) => {
			seen.push({ url: e.url, headers: (e.init?.headers ?? {}) as Record<string, string> });
			const item =
				conversation === 'conv-0001'
					? GOOD.item
					: { ...GOOD.item, ref: 'ACM-20261108-0999', tabName: 'OTHER_TAB', percent: 10 };
			return {
				value: {
					status: 200,
					ok: true,
					headers: {},
					text: JSON.stringify({ ...GOOD, externalId: conversation, item })
				}
			};
		});

		await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
		await $.tool.call({ tool: 'mcp__afb-acme__step_done' });

		for (const surface of SURFACES) {
			const ui = await $.ui.mount({ ...BAND, surface });
			expect(await ui.find({ type: 'Text', text: /ROLE_ENFORCE/ })).toBeDefined();
			expect(await ui.find({ type: 'Text', text: /63%/ })).toBeDefined();
			expect(await ui.find({ type: 'Text', text: /Phase 2 of 4/ })).toBeDefined();
			expect(await ui.find({ type: 'Text', text: /IN PROGRESS/ })).toBeDefined();
			// The token is never drawn
			expect(await ui.find({ type: 'Text', text: /afb_TEST_TOKEN/ })).toBeUndefined();
			await ui.unmount();
		}

		// The call: this conversation's id, the tool, the token as a header only, no session header, and the etag on the second call
		expect(seen[0].url).toBe(
			'https://board.example.com/api/v1/orgs/acme/sessions/by-external/conv-0001?tool=claude-code'
		);
		expect(seen[0].headers.authorization).toBe(`Bearer ${SETTINGS.token}`);
		expect(Object.keys(seen[0].headers).map((k) => k.toLowerCase())).not.toContain('x-session-id');
		expect(seen.at(-1)?.url).toContain('&etag=etag-one');
		expect(seen.every((s) => !s.url.includes('afb_TEST_TOKEN'))).toBe(true);

		// A second conversation shows its own item, not the first one's
		conversation = 'conv-0002';
		await $.tool.call({ tool: 'mcp__afb-acme__work_start' });
		const ui = await $.ui.mount({ ...BAND, surface: 'desktop' });
		expect(await ui.find({ type: 'Text', text: /OTHER_TAB/ })).toBeDefined();
		expect(await ui.find({ type: 'Text', text: /ROLE_ENFORCE/ })).toBeUndefined();
		await ui.unmount();
	}
);

test(
	'a token that stops working is said so, and the old item is gone from the line',
	{ options: SETTINGS },
	async ($, on) => {
		let status = 200;
		mock.clock(on, { now: 1_000_000 });
		on('command.register', () => ({ value: { command: 'afb-status' } }));
		on('session.start', (_, e) => ({ cwd: e.cwd }));
		on('session.id', () => ({ value: 'conv-0001' }));
		on('session.surfaces', () => ({ value: [] }));
		on('tool.call', () => ({ result: {} }));
		on('http.fetch', () => ({
			value: {
				status,
				ok: status === 200,
				headers: {},
				text: JSON.stringify(status === 200 ? GOOD : { error: { code: 'UNAUTHENTICATED' } })
			}
		}));

		await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
		await $.tool.call({ tool: 'mcp__afb-acme__work_start' });
		status = 401;
		await $.tool.call({ tool: 'mcp__afb-acme__step_done' });

		for (const surface of SURFACES) {
			const ui = await $.ui.mount({ ...BAND, surface });
			expect(await ui.find({ type: 'Text', text: /token has expired/ })).toBeDefined();
			expect(await ui.find({ type: 'Text', text: /ROLE_ENFORCE/ })).toBeUndefined();
			await ui.unmount();
		}
	}
);

test(
	'the board being away, no item claimed and a missing setting each have their own message',
	{ options: { ...SETTINGS, token: '' } },
	async ($, on) => {
		mock.clock(on, { now: 1_000_000 });
		on('command.register', () => ({ value: { command: 'afb-status' } }));
		on('session.start', (_, e) => ({ cwd: e.cwd }));
		on('session.id', () => ({ value: 'conv-0001' }));
		on('session.surfaces', () => ({ value: [] }));
		on('tool.call', () => ({ result: {} }));
		await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
		// A board tool that ran asks the board at once and waits for the answer
		await $.tool.call({ tool: 'mcp__afb-acme__work_start' });
		for (const surface of SURFACES) {
			const ui = await $.ui.mount({ ...BAND, surface });
			expect(
				await ui.find({ type: 'Text', text: /Set the board address, organisation and token/ })
			).toBeDefined();
			await ui.unmount();
		}
	}
);

test('a value an earlier version stored is declined', async ($, on) => {
	// What the code before this edit wrote stays through a reload: here it has no shape tag
	mock.clock(on, { now: 1_000_000 });
	on('state.get', () => ({
		value: { value: { kind: 'ok', item: { name: 'old shape' } }, version: 1 }
	}));
	on('ui.render', ($, e) => {
		const { Text } = $.ui.resolve(e);
		return <Text>engine</Text>;
	});
	for (const surface of SURFACES) {
		const ui = await $.ui.mount({ ...BAND, surface });
		// Nothing known yet: the band says nothing and the engine's own drawing stands
		expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine');
		expect(await ui.find({ type: 'Text', text: /Checking the board/ })).toBeUndefined();
		await ui.unmount();
	}
});

test('the band yields to a survey', async ($, on) => {
	on('ui.render', ($, e) => {
		const { Text } = $.ui.resolve(e);
		return <Text>engine</Text>;
	});
	const ui = await $.ui.mount({
		...BAND,
		props: { ...BAND.props, hasSurvey: true },
		surface: 'desktop'
	});
	expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine');
	await ui.unmount();
});

test(
	'no item claimed and the board being away each have their own message, and an old item is marked old',
	{ options: SETTINGS },
	async ($, on) => {
		let mode: 'none' | 'good' | 'away' = 'none';
		mock.clock(on, { now: 1_000_000 });
		on('ui.render', ($, e) => {
			const { Text } = $.ui.resolve(e);
			return <Text>engine</Text>;
		});
		on('command.register', () => ({ value: { command: 'afb-status' } }));
		on('session.start', (_, e) => ({ cwd: e.cwd }));
		on('session.id', () => ({ value: 'conv-0001' }));
		on('session.surfaces', () => ({ value: [] }));
		on('tool.call', () => ({ result: {} }));
		on('http.fetch', () => {
			if (mode === 'away')
				return { value: { status: 503, ok: false, headers: {}, text: 'unavailable' } };
			const body = mode === 'none' ? { ...GOOD, item: null } : GOOD;
			return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } };
		});
		await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
		await $.tool.call({ tool: 'mcp__afb-acme__work_stop' });
		for (const surface of SURFACES) {
			// No claim: the band does not show on its own. The pane, which the person asks for, says so.
			const ui = await $.ui.mount({ ...BAND, surface });
			expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine');
			await ui.unmount();
			const pane = await $.ui.mount({ ...PANE, surface });
			expect(
				await pane.find({ type: 'Text', text: /No item claimed in this conversation/ })
			).toBeDefined();
			await pane.unmount();
		}
		mode = 'good';
		await $.tool.call({ tool: 'mcp__afb-acme__work_start' });
		mode = 'away';
		await $.tool.call({ tool: 'mcp__afb-acme__step_done' });
		for (const surface of SURFACES) {
			const ui = await $.ui.mount({ ...BAND, surface });
			// The old item stays, with a tag that says the board cannot be reached and how old it is
			expect(await ui.find({ type: 'Text', text: /ROLE_ENFORCE/ })).toBeDefined();
			expect(await ui.find({ type: 'Text', text: /Board unreachable, old answer/ })).toBeDefined();
			await ui.unmount();
		}
	}
);

test('the organisation comes from the repo hooks, with its own token', () => {
	const pairs = [
		{ org: 'arbenger', token: 'a' },
		{ org: 'mangoman', token: 'm' }
	];
	const hooks =
		'"command": "agent-flow-board hook claude --server https://x.example --org mangoman"';
	expect(hookOrgOf(hooks)).toBe('mangoman');
	expect(hookOrgOf('"command": "agent-flow-board hook claude"')).toBeNull();
	expect(pickOrg(pairs, 'mangoman')?.token).toBe('m');
	expect(pickOrg(pairs, 'arbenger')?.token).toBe('a');
	// No hook organisation to go by: the first complete pair
	expect(pickOrg(pairs, null)?.org).toBe('arbenger');
	// A hook organisation with no token of its own is a missing setting, never another organisation's token
	expect(pickOrg([pairs[0], { org: 'mangoman', token: '' }], 'mangoman')).toBeNull();
	expect(pickOrg(pairs, 'other')).toBeNull();
});

// -- THE STATUS FILE OF THE BRIDGE (AFB-20261108-0427, S.3 AND S.4) -- //

const NOW = 1_000_000;
const FILE_CONVERSATION = 'conv-0001';
const fileText = (over: Record<string, unknown> = {}, status: unknown = GOOD) =>
	JSON.stringify({ v: 1, asOf: NOW - 2000, writtenAt: NOW - 1000, status, ...over });

test('a status file is trusted only when it is whole, fresh and this conversation own', () => {
	expect((readStatusFile(fileText(), FILE_CONVERSATION, NOW) as { etag: string }).etag).toBe(
		'etag-one'
	);
	// No item claimed is a good file too
	expect(
		readStatusFile(fileText({}, { ...GOOD, item: null }), FILE_CONVERSATION, NOW)
	).not.toBeNull();
	// Each of these is ignored, and the old way is used
	expect(readStatusFile('not json', FILE_CONVERSATION, NOW)).toBeNull();
	expect(readStatusFile('', FILE_CONVERSATION, NOW)).toBeNull();
	expect(readStatusFile(fileText({ v: 2 }), FILE_CONVERSATION, NOW)).toBeNull();
	expect(readStatusFile(fileText({ writtenAt: 'now' }), FILE_CONVERSATION, NOW)).toBeNull();
	expect(readStatusFile(fileText({ status: null }), FILE_CONVERSATION, NOW)).toBeNull();
	expect(
		readStatusFile(fileText({}, { ...GOOD, item: { nonsense: true } }), FILE_CONVERSATION, NOW)
	).toBeNull();
	// Another conversation's file is never shown
	expect(readStatusFile(fileText(), 'conv-9999', NOW)).toBeNull();
	// Old and from the future (a wrong clock)
	expect(
		readStatusFile(fileText({ writtenAt: NOW - FILE_STALE_MS - 1 }), FILE_CONVERSATION, NOW)
	).toBeNull();
	expect(
		readStatusFile(fileText({ writtenAt: NOW + 3_600_000 }), FILE_CONVERSATION, NOW)
	).toBeNull();
	// Negative control: just inside the limit is still good
	expect(
		readStatusFile(fileText({ writtenAt: NOW - FILE_STALE_MS + 1000 }), FILE_CONVERSATION, NOW)
	).not.toBeNull();
});

test('the file is looked for where the bridge keeps it, and never by an id that is not a plain name', () => {
	expect(statusPaths({ userProfile: 'C:/Users/Ada', home: '/home/ada' }, 'conv-0001')).toEqual([
		'C:/Users/Ada/.agent-flow-board/status/conv-0001.json',
		'/home/ada/.agent-flow-board/status/conv-0001.json'
	]);
	// The bridge's own folder comes first, and a trailing slash does not double
	expect(statusPaths({ bridgeHome: '/data/afb/', home: '/home/ada' }, 'conv-0001')[0]).toBe(
		'/data/afb/status/conv-0001.json'
	);
	expect(statusPaths({}, 'conv-0001')).toEqual([]);
	for (const bad of ['../escape-0001', 'a/b-00000001', 'short', '.hidden-0001'])
		expect(statusName(bad)).toBeNull();
	expect(statusPaths({ home: '/home/ada' }, '../escape-0001')).toEqual([]);
});

/** One conversation with a mocked file system. `files` maps a path to its text; any other path is missing. */
function fed(
	on: Parameters<typeof mock.clock>[0],
	files: Record<string, string>,
	lookups: { count: number }
) {
	const clock = mock.clock(on, { now: NOW });
	mock.env(on, { USERPROFILE: 'C:/Users/Ada' });
	on('command.register', () => ({ value: { command: 'afb-status' } }));
	on('session.start', (_, e) => ({ cwd: e.cwd }));
	on('session.id', () => ({ value: FILE_CONVERSATION }));
	on('session.surfaces', () => ({ value: [] }));
	on('tool.call', () => ({ result: {} }));
	on('fs.read', (_, e) => {
		// The engine spells a path with the platform's separator, so the test compares with slashes
		const path = e.path.replace(/\\/g, '/');
		return path in files ? { value: files[path] } : { deny: 'No such file.' };
	});
	on('http.fetch', () => {
		lookups.count += 1;
		return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(GOOD) } };
	});
	return clock;
}

const FILE_PATH = 'C:/Users/Ada/.agent-flow-board/status/conv-0001.json';

test(
	'a conversation fed by the bridge shows its item with no token and no setting, and never asks the board',
	{ options: { server: '', org: '', token: '' } },
	async ($, on) => {
		const lookups = { count: 0 };
		fed(on, { [FILE_PATH]: fileText() }, lookups);
		await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
		await $.tool.call({ tool: 'mcp__afb-acme__step_done' });
		for (const surface of SURFACES) {
			const ui = await $.ui.mount({ ...BAND, surface });
			expect(await ui.find({ type: 'Text', text: /ROLE_ENFORCE/ })).toBeDefined();
			expect(await ui.find({ type: 'Text', text: /63%/ })).toBeDefined();
			// Negative control: the missing setting message does not show for a conversation the bridge feeds
			expect(await ui.find({ type: 'Text', text: /Set the board address/ })).toBeUndefined();
			await ui.unmount();
		}
		expect(lookups.count).toBe(0);
	}
);

const FALLBACKS: Record<string, Record<string, string>> = {
	'no file': {},
	'a malformed file': { [FILE_PATH]: '{ this is not json' },
	'an old file': { [FILE_PATH]: fileText({ writtenAt: NOW - FILE_STALE_MS - 5000 }) },
	'a file of another conversation': {
		[FILE_PATH]: fileText({}, { ...GOOD, externalId: 'conv-9999' })
	}
};
for (const [name, files] of Object.entries(FALLBACKS))
	test(
		`${name}: the token lookup still works and shows the item on every surface`,
		{ options: SETTINGS },
		async ($, on) => {
			const lookups = { count: 0 };
			fed(on, files, lookups);
			await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
			await $.tool.call({ tool: 'mcp__afb-acme__step_done' });
			expect(lookups.count).toBeGreaterThan(0);
			for (const surface of SURFACES) {
				const ui = await $.ui.mount({ ...BAND, surface });
				expect(await ui.find({ type: 'Text', text: /ROLE_ENFORCE/ })).toBeDefined();
				await ui.unmount();
			}
		}
	);

test(
	'a file that stays the same keeps its answer current: minutes later the line is not drawn as old',
	{ options: { server: '', org: '', token: '' } },
	async ($, on) => {
		const lookups = { count: 0 };
		const clock = fed(on, { [FILE_PATH]: fileText() }, lookups);
		await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
		await $.tool.call({ tool: 'mcp__afb-acme__step_done' });
		// Four minutes of the same claim: past the three after which an answer from the board is drawn as old
		await clock.advance(240_000);
		for (const surface of SURFACES) {
			const ui = await $.ui.mount({ ...BAND, surface });
			expect(await ui.find({ type: 'Text', text: /ROLE_ENFORCE/ })).toBeDefined();
			// Negative control: the board's own answers do get the old tag after three minutes, so the tag text is the one to look for
			expect(await ui.find({ type: 'Text', text: /Old answer/ })).toBeUndefined();
			await ui.unmount();
		}
		expect(lookups.count).toBe(0);
	}
);

test(
	'a file that says nothing is claimed keeps the line quiet and never asks the board',
	{ options: { server: '', org: '', token: '' } },
	async ($, on) => {
		const lookups = { count: 0 };
		fed(on, { [FILE_PATH]: fileText({}, { ...GOOD, item: null }) }, lookups);
		on('ui.render', ($, e) => {
			const { Text } = $.ui.resolve(e);
			return <Text>engine</Text>;
		});
		await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
		await $.tool.call({ tool: 'mcp__afb-acme__work_stop' });
		const ui = await $.ui.mount({ ...BAND, surface: 'desktop' });
		expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine');
		await ui.unmount();
		expect(lookups.count).toBe(0);
	}
);
