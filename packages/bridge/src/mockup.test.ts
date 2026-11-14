// THE MOCKUP PUSH COMMAND: NO SIGN IN, A FILE THAT IS TOO BIG OR NOT HTML, A REPEATED REQUEST ID ON A RETRY, AND THE ORDER OF THE CALLS

// IMPORTED DEP-MODULES
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	MAX_MOCKUP_BYTES,
	pullMockup,
	pushKit,
	pushMockup,
	type KitPushOptions,
	type PullOptions,
	type PushOptions
} from './mockup.js';

// -- FUNCTIONS -- //

type Call = { method: string; url: string; key: string | null; body: unknown };

describe('mockup push', () => {
	let dir = '';
	let page = '';
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'afb-mockup-'));
		page = join(dir, 'screen.html');
		writeFileSync(page, '<html><body>Hello</body></html>');
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const setup = (answer: (c: Call, n: number) => Response | Error) => {
		const calls: Call[] = [];
		const logs: string[] = [];
		const options: PushOptions = {
			server: 'https://board.test',
			org: 'acme',
			token: 'afb_token',
			file: page,
			item: 'AFB-20261107-0346',
			log: (l) => logs.push(l),
			wait: async () => undefined,
			fetch: async (url, init) => {
				const call = {
					method: String(init?.method),
					url,
					key: new Headers(init?.headers).get('idempotency-key'),
					body: init?.body
				};
				calls.push(call);
				const r = answer(call, calls.length);
				if (r instanceof Error) throw r;
				return r;
			}
		};
		return { calls, logs, options };
	};
	const made = { mockup: { id: 'm-1' }, version: { number: 2 }, projectKey: 'AFB' };

	it('refuses to run with no sign in, no target, a missing file, a link, a folder or a file that is not HTML', async () => {
		const s = setup(() => json(made));
		await expect(pushMockup({ ...s.options, token: '' })).rejects.toThrow(/Not signed in/);
		await expect(pushMockup({ ...s.options, item: undefined })).rejects.toThrow(/Name the plan/);
		await expect(pushMockup({ ...s.options, file: join(dir, 'nope.html') })).rejects.toThrow(
			/does not exist/
		);
		await expect(pushMockup({ ...s.options, file: dir })).rejects.toThrow(/not a plain file/);
		const text = join(dir, 'notes.txt');
		writeFileSync(text, 'secret');
		await expect(pushMockup({ ...s.options, file: text })).rejects.toThrow(/html/);
		const empty = join(dir, 'empty.html');
		writeFileSync(empty, '');
		await expect(pushMockup({ ...s.options, file: empty })).rejects.toThrow(/empty/);
		const link = join(dir, 'link.html');
		try {
			symlinkSync(text, link);
			await expect(pushMockup({ ...s.options, file: link })).rejects.toThrow(/not a plain file/);
		} catch (e) {
			// Making a link needs a privilege on some systems, so that check is skipped there
			if ((e as { code?: string }).code !== 'EPERM') throw e;
		}
		expect(s.calls).toHaveLength(0);
	});

	it('refuses a file over the cap before any call is made', async () => {
		const big = join(dir, 'big.html');
		writeFileSync(big, '<html>');
		truncateSync(big, MAX_MOCKUP_BYTES + 1);
		const s = setup(() => json(made));
		await expect(pushMockup({ ...s.options, file: big })).rejects.toThrow(/50 MB limit/);
		expect(s.calls).toHaveLength(0);
	});

	it('publishes, then writes the notes, then the screenshot, and says where to look', async () => {
		const shot = join(dir, 'shot.png');
		writeFileSync(shot, Buffer.from([137, 80, 78, 71]));
		const s = setup((c) => (c.url.includes('/mockups?') ? json(made) : json({ ok: true })));
		const r = await pushMockup({
			...s.options,
			title: 'Settings page',
			keepNotes: 'Keep the sidebar.',
			freeNotes: 'Colours are free.',
			screenshot: shot
		});
		expect(r).toEqual({
			mockupId: 'm-1',
			version: 2,
			url: 'https://board.test/acme/AFB/mockups/m-1',
			notes: true,
			screenshot: true,
			warnings: []
		});
		expect(
			s.calls.map((c) => `${c.method} ${c.url.replace('https://board.test/api/v1', '')}`)
		).toEqual([
			'POST /orgs/acme/mockups?item=AFB-20261107-0346&title=Settings+page',
			'PUT /orgs/acme/mockups/m-1/versions/2/notes',
			'PUT /orgs/acme/mockups/m-1/versions/2/screenshot'
		]);
		// Every call has its own request id, and none is empty
		expect(new Set(s.calls.map((c) => c.key)).size).toBe(3);
		expect(s.calls.every((c) => /^mockup-(push|notes|shot)-[0-9a-f]{16}$/.test(c.key ?? ''))).toBe(
			true
		);
	});

	it('tries again after a network failure or a 5xx with the same request id, and never on a 4xx', async () => {
		const flaky = setup((_c, n) =>
			n === 1 ? new Error('socket hang up') : n === 2 ? json({}, 503) : json(made)
		);
		await pushMockup(flaky.options);
		expect(flaky.calls).toHaveLength(3);
		expect(new Set(flaky.calls.map((c) => c.key)).size).toBe(1);
		const refused = setup(() =>
			json({ error: { code: 'FORBIDDEN', message: 'No write access.' } }, 403)
		);
		await expect(pushMockup(refused.options)).rejects.toThrow('No write access. (403)');
		expect(refused.calls).toHaveLength(1);
		const down = setup(() => new Error('connect refused'));
		await expect(pushMockup(down.options)).rejects.toThrow('connect refused');
		expect(down.calls).toHaveLength(3);
	});

	it('keeps the published version when its notes cannot be saved, and says so', async () => {
		const s = setup((c) =>
			c.url.includes('/notes') ? json({ error: { message: 'Too long.' } }, 400) : json(made)
		);
		const r = await pushMockup({ ...s.options, keepNotes: 'x' });
		expect(r).toMatchObject({ version: 2, notes: false });
		expect(s.logs.join(' ')).toContain('notes were not saved: Too long. (400)');
	});

	it('prints each warning of the board and still succeeds, and a board with none prints nothing', async () => {
		const warned = setup(() =>
			json({ ...made, warnings: ['An icon font is used.', 'Two fonts.'] })
		);
		const r = await pushMockup(warned.options);
		expect(r.warnings).toEqual(['An icon font is used.', 'Two fonts.']);
		expect(warned.logs).toEqual(['Warning: An icon font is used.', 'Warning: Two fonts.']);
		const clean = setup(() => json(made));
		expect((await pushMockup(clean.options)).warnings).toEqual([]);
		expect(clean.logs).toEqual([]);
	});
});

describe('mockup kit push', () => {
	let dir = '';
	let kit = '';
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'afb-kit-'));
		kit = join(dir, 'kit.html');
		writeFileSync(kit, '<html><body>Kit</body></html>');
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const run = (answer: Response | Error, extra: Partial<KitPushOptions> = {}) => {
		const calls: { method: string; url: string; type: string | null }[] = [];
		const logs: string[] = [];
		const options: KitPushOptions = {
			server: 'https://board.test',
			org: 'acme',
			token: 'afb_token',
			file: kit,
			project: 'AFB',
			log: (l) => logs.push(l),
			wait: async () => undefined,
			fetch: async (url, init) => {
				calls.push({
					method: String(init?.method),
					url,
					type: new Headers(init?.headers).get('content-type')
				});
				if (answer instanceof Error) throw answer;
				return answer;
			},
			...extra
		};
		return { calls, logs, options };
	};
	const ok = (body: unknown) =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});

	it('uploads the file with the commit and summary and prints the warnings without failing', async () => {
		const s = run(ok({ number: 3, warnings: ['The kit embeds no font file.'] }), {
			commit: 'abc1234',
			summary: 'Tokens and icons'
		});
		const r = await pushKit(s.options);
		expect(r).toEqual({ number: 3, warnings: ['The kit embeds no font file.'] });
		expect(s.logs).toEqual(['Warning: The kit embeds no font file.']);
		expect(s.calls).toEqual([
			{
				method: 'PUT',
				url: 'https://board.test/api/v1/orgs/acme/projects/AFB/mockup-kit?builtFromCommit=abc1234&summary=Tokens+and+icons',
				type: 'text/html'
			}
		]);
	});

	it('refuses with no sign in, a missing file or a summary that is too long, before any call', async () => {
		const s = run(ok({ number: 1 }));
		await expect(pushKit({ ...s.options, token: '' })).rejects.toThrow(/Not signed in/);
		await expect(pushKit({ ...s.options, file: join(dir, 'nope.html') })).rejects.toThrow(
			/does not exist/
		);
		await expect(pushKit({ ...s.options, summary: 'x'.repeat(4001) })).rejects.toThrow(
			/4,001 characters; the bridge sends at most 4,000/
		);
		expect(s.calls).toHaveLength(0);
	});

	it("says the server's own words on a refusal", async () => {
		const s = run(
			new Response(JSON.stringify({ error: { message: 'Only admins change the kit.' } }), {
				status: 403,
				headers: { 'content-type': 'application/json' }
			})
		);
		await expect(pushKit(s.options)).rejects.toThrow('Only admins change the kit. (403)');
	});
});

describe('mockup pull', () => {
	let dir = '';
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'afb-mockup-pull-'));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const PAGE = '<html><body>' + 'Rooms '.repeat(40) + '</body></html>';
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	// A board that serves the page 100 characters at a time, whatever limit is asked
	const board = (recorded: boolean | undefined) => {
		const urls: URL[] = [];
		const keys: (string | null)[] = [];
		const logs: string[] = [];
		const options: PullOptions = {
			server: 'https://board.test',
			org: 'acme',
			token: 'afb_token',
			mockup: 'm-1',
			out: '',
			log: (l) => logs.push(l),
			wait: async () => undefined,
			fetch: async (url, init) => {
				const u = new URL(url);
				urls.push(u);
				keys.push(new Headers(init?.headers).get('idempotency-key'));
				const offset = Number(u.searchParams.get('offset'));
				const html = PAGE.slice(offset, offset + 100);
				return json({
					html,
					version: 3,
					length: PAGE.length,
					offset,
					more: offset + 100 < PAGE.length,
					...(recorded === undefined ? {} : { recorded })
				});
			}
		};
		return { urls, keys, logs, options };
	};

	it('reads every part in order to the end, writes one file and sends the session id', async () => {
		const b = board(true);
		const out = join(dir, 'pulled.html');
		const r = await pullMockup({ ...b.options, out, session: 's_1', version: 3 });
		expect(readFileSync(out, 'utf8')).toBe(PAGE);
		expect(r).toEqual({ file: out, version: 3, length: PAGE.length, recorded: true });
		expect(b.urls.length).toBe(Math.ceil(PAGE.length / 100));
		expect(b.urls.map((u) => Number(u.searchParams.get('offset')))).toEqual(
			b.urls.map((_, i) => i * 100)
		);
		expect(b.urls[0].pathname).toBe('/api/v1/orgs/acme/mockups/m-1/html');
		expect(b.urls.every((u) => u.searchParams.get('sessionId') === 's_1')).toBe(true);
		expect(b.urls.every((u) => u.searchParams.get('version') === '3')).toBe(true);
		// Every part has its own request id, so a repeated part is never mistaken for another one
		expect(new Set(b.keys).size).toBe(b.keys.length);
		expect(b.logs.join('\n')).toMatch(/untrusted text/);
	});

	it('says so when the board did not count the read, and counts nothing without a session', async () => {
		const unrecorded = board(false);
		const a = await pullMockup({
			...unrecorded.options,
			out: join(dir, 'unrecorded.html'),
			session: 's_x'
		});
		expect(a.recorded).toBe(false);
		expect(unrecorded.logs.join('\n')).toMatch(/not recorded/);
		const plain = board(undefined);
		const b = await pullMockup({ ...plain.options, out: join(dir, 'plain.html') });
		expect(b.recorded).toBe(false);
		expect(plain.urls.every((u) => !u.searchParams.has('sessionId'))).toBe(true);
	});

	it('refuses no sign in, a file that is not HTML, an existing file, a missing folder and any path inside a git repository, before any call', async () => {
		const b = board(true);
		const run = (out: string, token = 'afb_token') => pullMockup({ ...b.options, out, token });
		await expect(run(join(dir, 'a.html'), '')).rejects.toThrow(/Not signed in/);
		await expect(run(join(dir, 'a.txt'))).rejects.toThrow(/must be a \.html file/);
		const taken = join(dir, 'taken.html');
		writeFileSync(taken, 'mine');
		await expect(run(taken)).rejects.toThrow(/already exists/);
		expect(readFileSync(taken, 'utf8')).toBe('mine');
		await expect(run(join(dir, 'nope', 'a.html'))).rejects.toThrow(/does not exist/);
		const repo = join(dir, 'repo');
		mkdirSync(join(repo, '.git'), { recursive: true });
		mkdirSync(join(repo, 'design'));
		await expect(run(join(repo, 'design', 'a.html'))).rejects.toThrow(
			/never saved inside a git repository/
		);
		expect(b.urls).toEqual([]);
	});

	it('pins the version of the first part, and writes nothing when the page changes while it is read', async () => {
		// Asked with no version: every part after the first names the version the first one came from
		const b = board(true);
		await pullMockup({ ...b.options, out: join(dir, 'pinned.html') });
		expect(b.urls[0].searchParams.has('version')).toBe(false);
		expect(b.urls.slice(1).every((u) => u.searchParams.get('version') === '3')).toBe(true);
		// A board that answers another version, or another length, half way
		for (const change of [{ version: 4 }, { length: PAGE.length + 1 }]) {
			const out = join(dir, `changed-${Object.keys(change)[0]}.html`);
			let n = 0;
			await expect(
				pullMockup({
					...b.options,
					out,
					fetch: async (url) => {
						const offset = Number(new URL(url).searchParams.get('offset'));
						n++;
						return json({
							html: PAGE.slice(offset, offset + 100),
							version: 3,
							length: PAGE.length,
							more: true,
							...(n > 1 ? change : {})
						});
					}
				})
			).rejects.toThrow(/changed while it was read/);
			expect(existsSync(out)).toBe(false);
		}
		// A board that never finishes and sends nothing more
		await expect(
			pullMockup({
				...b.options,
				out: join(dir, 'endless.html'),
				fetch: async () => json({ html: '', version: 3, length: 10, more: true })
			})
		).rejects.toThrow(/did not finish/);
	});

	it('refuses a folder that is a link into a repository, and a bare repository', async () => {
		const b = board(true);
		const repo = join(dir, 'linked-repo');
		mkdirSync(join(repo, '.git'), { recursive: true });
		mkdirSync(join(repo, 'design'));
		const link = join(dir, 'looks-outside');
		// A junction needs no special rights on Windows, and is a plain directory link elsewhere
		symlinkSync(join(repo, 'design'), link, 'junction');
		await expect(pullMockup({ ...b.options, out: join(link, 'a.html') })).rejects.toThrow(
			/never saved inside a git repository/
		);
		const bare = join(dir, 'bare.git');
		mkdirSync(join(bare, 'objects'), { recursive: true });
		writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n');
		mkdirSync(join(bare, 'sub'));
		await expect(pullMockup({ ...b.options, out: join(bare, 'sub', 'a.html') })).rejects.toThrow(
			/never saved inside a git repository/
		);
		expect(b.urls).toEqual([]);
	});

	it("says the server's own words on a refusal and writes nothing", async () => {
		const b = board(true);
		const out = join(dir, 'refused.html');
		await expect(
			pullMockup({
				...b.options,
				out,
				fetch: async () => json({ error: { message: 'No such mockup.' } }, 404)
			})
		).rejects.toThrow('No such mockup. (404)');
		expect(existsSync(out)).toBe(false);
	});
});
