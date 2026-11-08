// TESTS OF THE FLOW STATUS MOD: THE BOARD'S ANSWERS BECOME LINES, ON EVERY SURFACE. RUN WITH: claude plugin test packages/claude-status-mod
import { expect, mock, test } from 'claude-code/testing';

import { MAX_BACKOFF_MS, POLL_MS, nextView, plain, waitAfter, INITIAL } from './hooks/status';

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

// -- PURE LOGIC -- //

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
		await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
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
	for (const surface of SURFACES) {
		const ui = await $.ui.mount({ ...BAND, surface });
		expect(await ui.find({ type: 'Text', text: /Checking the board/ })).toBeDefined();
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
			const ui = await $.ui.mount({ ...BAND, surface });
			expect(
				await ui.find({ type: 'Text', text: /No item claimed in this conversation/ })
			).toBeDefined();
			await ui.unmount();
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
