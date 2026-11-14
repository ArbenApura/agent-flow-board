// THE RENDERS TAKEN AFTER A PUSH (AFB-20261114-0409, C.2): WHICH SCREENS A PAGE DECLARES, AND THE UPLOAD OF EACH RENDER

// -- DEP-MODULES -- //
import { describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import {
	DEFAULT_RENDER_WIDTHS,
	captureRenders,
	renderVersionCommand,
	screensOfPage
} from './renders.js';
import { declaredMockupScreenKeys } from '../../../src/lib/shared/screenGlobs';

// The browser step is faked: its failure may name the signed address, and the failed reason may not (rule R1)
const { inspectUrl } = vi.hoisted(() => ({ inspectUrl: vi.fn() }));
vi.mock('./checks/inspect.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./checks/inspect.js')>();
	return { ...actual, inspectUrl };
});

// -- FUNCTIONS -- //

const mintResponse = () =>
	new Response(
		JSON.stringify({
			url: 'http://h.test/m/a/file?exp=1790000000&sig=deadbeef',
			relativePath: '/m/a/file?exp=1790000000&sig=deadbeef',
			mockupId: 'm',
			projectId: 'p',
			version: 1,
			kind: 'html',
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			isolatedOrigin: true,
			devOnlySameHost: false,
			notice: null,
			isPublic: false
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);

describe('renders after a push', () => {
	it('reads the screens a page declares in its afb-config tag, in order', () => {
		const html = `<head><meta name="afb-config" content='{"screens": [["today", "Today"], ["consult", "Consultation"], ["x y", "Bad"]], "options": []}'></head>`;
		expect(screensOfPage(html)).toEqual(['today', 'consult']);
	});

	it('has no screens for a page that declares none or whose tag is not valid JSON', () => {
		expect(screensOfPage('<html></html>')).toEqual([]);
		expect(screensOfPage(`<meta name="afb-config" content='not json'>`)).toEqual([]);
		expect(screensOfPage(`<meta name="afb-config" content='{"options": []}'>`)).toEqual([]);
	});

	it('uses the four viewer widths unless told otherwise', () => {
		expect(DEFAULT_RENDER_WIDTHS).toEqual([408, 820, 1280, 1600]);
	});

	it('agrees with the server on the declared screens of a page (rule R3)', () => {
		for (const html of [
			`<meta name="afb-config" content='{"screens": [["today", "Today"], ["Consult", "C"]]}'>`,
			`<meta name="afb-config" content='{"screens": ["today", "consult"]}'>`,
			`<section data-screen="Cases">Cases</section>`,
			`<meta name="afb-config" content='not json'><section data-screen="cases">`,
			`<meta name="afb-config" content='{"screens": [["x y", "Bad"], ["OK", "Good"]]}'>`,
			`<section data-screen="a"></section><section data-screen="b"></section><section data-screen="c"></section><section data-screen="d"></section><section data-screen="e"></section><section data-screen="f"></section><section data-screen="g"></section><section data-screen="h"></section><section data-screen="i"></section><section data-screen="j"></section><section data-screen="k"></section><section data-screen="l"></section><section data-screen="m"></section><section data-screen="n"></section>`,
			'<html></html>'
		])
			expect(screensOfPage(html)).toEqual(declaredMockupScreenKeys(html));
		// The cap holds on both sides
		expect(
			screensOfPage(
				'n'.repeat(0) + Array.from({ length: 15 }, (_, i) => `<i data-screen="s${i}">`).join('')
			)
		).toHaveLength(12);
	});

	it('leaves no sig= or exp= in a failed render, in the result and in the log (rule R1)', async () => {
		inspectUrl.mockRejectedValueOnce(
			new Error('page.goto: http://h.test/m/a/file?exp=1790000000&sig=deadbeef refused')
		);
		const lines: string[] = [];
		const result = await captureRenders({
			server: 'http://board.test',
			org: 'arbenger',
			token: 'afb_test_token_value',
			fetch: () => Promise.resolve(mintResponse()),
			mockup: 'm',
			version: 1,
			screens: ['today'],
			widths: [1280],
			log: (line) => lines.push(line)
		});
		expect(result.captured).toBe(0);
		expect(result.failed).toEqual([
			{ screen: 'today', width: 1280, reason: 'page.goto: http://h.test/m/a/file?[hidden] refused' }
		]);
		expect(lines.join('\n')).not.toMatch(/sig=|exp=/);
	});

	it('retries a capture once on a new lease when the browser died, and never a broken page (rule R4)', async () => {
		const ok = {
			dump: { elements: [] as unknown[] },
			screenshot: Buffer.from('x'),
			manualRequired: false
		} as never;
		inspectUrl
			.mockRejectedValueOnce(new Error('Target page, context or browser has been closed'))
			.mockResolvedValueOnce(ok);
		const lines: string[] = [];
		const result = await captureRenders({
			server: 'http://board.test',
			org: 'arbenger',
			token: 'afb_test_token_value',
			fetch: () => Promise.resolve(mintResponse()),
			mockup: 'm',
			version: 1,
			screens: ['today'],
			widths: [1280],
			log: (line) => lines.push(line)
		});
		expect(inspectUrl).toHaveBeenCalledTimes(2);
		expect(result.captured).toBe(1);
		expect(result.failed).toEqual([]);
		expect(lines.join('\n')).toMatch(/browser died/);

		// A page that is simply unreachable is not retried
		inspectUrl.mockClear();
		inspectUrl.mockRejectedValueOnce(
			new Error('net::ERR_CONNECTION_REFUSED at http://h.test/m/a/file')
		);
		const second = await captureRenders({
			server: 'http://board.test',
			org: 'arbenger',
			token: 'afb_test_token_value',
			fetch: () => Promise.resolve(mintResponse()),
			mockup: 'm',
			version: 1,
			screens: ['today'],
			widths: [1280],
			log: (line) => lines.push(line)
		});
		expect(inspectUrl).toHaveBeenCalledTimes(1);
		expect(second.captured).toBe(0);
		expect(second.failed).toHaveLength(1);
	});

	it('renders a version from its own html, with a nonce key per run and a retry on 429 (rules R3 and R11)', async () => {
		const page = `<meta name="afb-config" content='{"screens": ["today", "lab"]}'>body`;
		const puts: { key?: string; screen?: string }[] = [];
		const serve = (status: number, once = false): (() => Response) => {
			let used = false;
			return () => {
				if (once && used) status = 200;
				used = true;
				return new Response(
					JSON.stringify({
						version: 3,
						screen: 'today',
						state: 'default',
						width: 1,
						picture: true
					}),
					{ status, headers: { 'content-type': 'application/json' } }
				);
			};
		};
		const fetchFake = (init?: { put: () => Response }) =>
			((_input: RequestInfo | URL, i?: RequestInit) => {
				const url = String(_input);
				if (url.includes('/mockups/m/url')) return Promise.resolve(mintResponse());
				if (url.includes('/html?'))
					return Promise.resolve(
						new Response(
							JSON.stringify({ html: page, version: 3, length: page.length, more: false }),
							{
								status: 200,
								headers: { 'content-type': 'application/json' }
							}
						)
					);
				if (i?.method === 'PUT') {
					const h = i.headers as Record<string, string>;
					puts.push({ key: h['idempotency-key'], screen: JSON.parse(String(i.body)).screen });
					return Promise.resolve(init?.put() ?? new Response('', { status: 200 }));
				}
				return Promise.resolve(new Response('nope', { status: 404 }));
			}) as never;
		inspectUrl.mockResolvedValue({
			dump: { elements: [] },
			screenshot: Buffer.from('x'),
			manualRequired: false
		} as never);
		const lines: string[] = [];
		const waits: number[] = [];
		const wait = async (ms: number) => void waits.push(ms);

		// Two screens at one width, all saved
		const first = await renderVersionCommand({
			server: 'http://board.test',
			org: 'arbenger',
			token: 'afb_test_token_value',
			fetch: fetchFake(),
			mockup: 'm',
			widths: [1280],
			runNonce: 'one',
			log: (l) => lines.push(l),
			wait
		});
		expect(first.version).toBe(3);
		expect(first.captured).toBe(2);
		expect(first.failed).toEqual([]);
		expect(puts.map((p) => p.screen)).toEqual(['today', 'lab']);
		const keysOfFirst = puts.map((p) => p.key);

		// A second run replaces the first: a different nonce makes a different idempotency key
		const second = await renderVersionCommand({
			server: 'http://board.test',
			org: 'arbenger',
			token: 'afb_test_token_value',
			fetch: fetchFake(),
			mockup: 'm',
			widths: [1280],
			runNonce: 'two',
			log: (l) => lines.push(l),
			wait
		});
		expect(second.captured).toBe(2);
		const allKeys = [...keysOfFirst, ...puts.slice(2).map((p) => p.key)];
		expect(new Set(allKeys).size).toBe(4);

		// A rate-limited PUT waits and retries with the same key (rule R11)
		puts.length = 0;
		const rate = await captureRenders({
			server: 'http://board.test',
			org: 'arbenger',
			token: 'afb_test_token_value',
			fetch: fetchFake({ put: serve(429, true) }),
			mockup: 'm',
			version: 3,
			screens: ['today'],
			widths: [1280],
			log: (l) => lines.push(l),
			wait
		});
		expect(rate.captured).toBe(1);
		expect(rate.failed).toEqual([]);
		expect(waits.length).toBeGreaterThan(0);
		expect(puts).toHaveLength(2);
		expect(puts[0].key).toBe(puts[1].key);

		// A server refusal of an undeclared screen lands in the failed list and the rest still render
		puts.length = 0;
		let refusedOnce = false;
		const refusalFetch = ((input: RequestInfo | URL, i?: RequestInit) => {
			const url = String(input);
			if (url.includes('/mockups/m/url')) return Promise.resolve(mintResponse());
			if (url.includes('/html?'))
				return Promise.resolve(
					new Response(
						JSON.stringify({ html: page, version: 3, length: page.length, more: false }),
						{
							status: 200,
							headers: { 'content-type': 'application/json' }
						}
					)
				);
			if (i?.method === 'PUT') {
				const screen = JSON.parse(String(i.body)).screen as string;
				if (screen === 'lab' && !refusedOnce) {
					refusedOnce = true;
					return Promise.resolve(
						new Response(
							JSON.stringify({
								error: { message: 'The screen "lab" is not declared by this version.' }
							}),
							{ status: 400, headers: { 'content-type': 'application/json' } }
						)
					);
				}
				return Promise.resolve(new Response('', { status: 200 }));
			}
			return Promise.resolve(new Response('nope', { status: 404 }));
		}) as never;
		const partial = await renderVersionCommand({
			server: 'http://board.test',
			org: 'arbenger',
			token: 'afb_test_token_value',
			fetch: refusalFetch,
			mockup: 'm',
			widths: [1280],
			runNonce: 'three',
			log: (l) => lines.push(l),
			wait
		});
		expect(partial.captured).toBe(1);
		expect(partial.failed).toEqual([
			{
				screen: 'lab',
				width: 1280,
				reason: 'The screen "lab" is not declared by this version. (400)'
			}
		]);
	});
});
