// THE SCREEN PUSH COMMAND (AFB-20261124-0926): NO SIGN IN, A FILE THAT IS NOT A PNG OR TOO BIG, ONE CALL WITH A STABLE REQUEST ID, AND THE ANSWER

// IMPORTED DEP-MODULES
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { pushScreen, type ScreenPushOptions } from './mockup.js';

// -- TYPES -- //

type Call = { method: string; url: string; key: string | null; type: string | null };

// -- FUNCTIONS -- //

describe('screen push', () => {
	let dir = '';
	let shot = '';
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'afb-screen-'));
		shot = join(dir, 'members.png');
		writeFileSync(shot, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const answer = { screen: { id: 's-1', role: 'before', image: '/pictures/screen/s-1' } };
	const setup = (respond: (n: number) => Response | Error = () => json(answer)) => {
		const calls: Call[] = [];
		const options: ScreenPushOptions = {
			server: 'https://board.test',
			org: 'acme',
			token: 'afb_token',
			file: shot,
			item: 'AFB-20261124-0926',
			screen: 'settings-members',
			mode: 'light',
			width: 1440,
			log: () => undefined,
			wait: async () => undefined,
			fetch: async (url, init) => {
				const h = new Headers(init?.headers);
				calls.push({
					method: String(init?.method),
					url,
					key: h.get('idempotency-key'),
					type: h.get('content-type')
				});
				const r = respond(calls.length);
				if (r instanceof Error) throw r;
				return r;
			}
		};
		return { calls, options };
	};
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

	it('refuses to run with no sign in, no plan, a missing file or a file that is not a PNG', async () => {
		const s = setup();
		await expect(pushScreen({ ...s.options, token: '' })).rejects.toThrow(/Not signed in/);
		await expect(pushScreen({ ...s.options, item: '' })).rejects.toThrow(/--item/);
		await expect(pushScreen({ ...s.options, file: join(dir, 'none.png') })).rejects.toThrow(
			/does not exist/
		);
		const html = join(dir, 'page.html');
		writeFileSync(html, '<html></html>');
		await expect(pushScreen({ ...s.options, file: html })).rejects.toThrow(/png/);
		expect(s.calls).toHaveLength(0);
	});

	it('accepts each picture extension and sends the type of its extension, and refuses a .gif', async () => {
		for (const [name, type] of [
			['a.jpg', 'image/jpeg'],
			['b.jpeg', 'image/jpeg'],
			['c.webp', 'image/webp'],
			['d.avif', 'image/avif'],
			['e.PNG', 'image/png']
		] as const) {
			const file = join(dir, name);
			writeFileSync(file, Buffer.from([1, 2, 3, 4]));
			const s = setup();
			await pushScreen({ ...s.options, file });
			expect(s.calls[0].type).toBe(type);
		}
		const gif = join(dir, 'f.gif');
		writeFileSync(gif, Buffer.from([1, 2, 3, 4]));
		const s = setup();
		await expect(pushScreen({ ...s.options, file: gif })).rejects.toThrow(/\.png/);
		expect(s.calls).toHaveLength(0);
	});

	it('refuses a picture over 10 MB before any call is made', async () => {
		const big = join(dir, 'big.png');
		writeFileSync(big, Buffer.from([137, 80, 78, 71]));
		truncateSync(big, 10 * 1024 * 1024 + 1);
		const s = setup();
		await expect(pushScreen({ ...s.options, file: big })).rejects.toThrow(/10 MB limit/);
		expect(s.calls).toHaveLength(0);
	});

	it('makes one call with the picture as the body and says where it is', async () => {
		const s = setup();
		const r = await pushScreen({ ...s.options, caption: 'The members page', phase: 'ui' });
		expect(r).toEqual({
			id: 's-1',
			role: 'before',
			image: 'https://board.test/pictures/screen/s-1'
		});
		expect(s.calls).toHaveLength(1);
		expect(s.calls[0].method).toBe('POST');
		expect(s.calls[0].type).toBe('image/png');
		expect(s.calls[0].url).toContain('/api/v1/orgs/acme/screens?');
		for (const part of [
			'item=AFB-20261124-0926',
			'screen=settings-members',
			'mode=light',
			'width=1440',
			'phase=ui'
		])
			expect(s.calls[0].url).toContain(part);
	});

	it('tries again after a network failure or a 5xx with the same request id, and never on a 4xx', async () => {
		const flaky = setup((n) =>
			n === 1 ? new Error('offline') : n === 2 ? json({}, 503) : json(answer)
		);
		await pushScreen(flaky.options);
		expect(flaky.calls.length).toBe(3);
		expect(new Set(flaky.calls.map((c) => c.key)).size).toBe(1);
		expect(flaky.calls[0].key).toMatch(/^screen-push-/);
		const refused = setup(() => json({ error: { message: 'No such plan.' } }, 404));
		await expect(pushScreen(refused.options)).rejects.toThrow();
		expect(refused.calls).toHaveLength(1);
	});
});
