// THE RENDER QUALITY CHECKS (rules R5 to R9, AFB-20261114-0611): FIXTURES IN A REAL BROWSER FOR THE THREE
// CHECKS, AND THE GROUPING AND SUMMARY AS PURE TESTS. THE CHECKS ARE ADVISORY: A FINDING IS NEVER A GATE.

// -- DEP-MODULES -- //
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { inspectUrl } from './inspect.js';
import {
	groupQualityFindings,
	summarizeQualityChecks,
	type RawQualityFinding
} from './qualityChecks.js';

// -- HELPERS -- //

function startServer(
	body: string,
	status = 200
): Promise<{ server: Server; origin: string; url: string }> {
	return new Promise((resolve) => {
		const server = createServer((_req, res) => {
			res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
			res.end(body);
		});
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address() as { port: number };
			const origin = `http://127.0.0.1:${addr.port}`;
			resolve({ server, origin, url: `${origin}/m/a/file` });
		});
	});
}

const find = (checks: RawQualityFinding[] | undefined, selector: string, kind: string) =>
	(checks ?? []).filter((c) => c.selector === selector && c.kind === kind);

const severitiesOf = (checks: RawQualityFinding[] | undefined, selector: string, kind: string) =>
	find(checks, selector, kind).map((c) => c.severity);

const CONTRAST_PAGE = `<!doctype html><html><head><style>
body { margin: 0; background: #ffffff; font-family: Arial; }
.grad { color: #111111; background-color: #f8fafc; background-image: linear-gradient(rgb(37, 99, 235), rgb(37, 99, 235)); padding: 8px; }
.grad-light { color: #ffffff; background-image: linear-gradient(rgb(37, 99, 235), rgb(37, 99, 235)); padding: 8px; }
.fade { color: #111111; background-color: #ffffff; background-image: linear-gradient(rgba(37, 99, 235, 0), rgba(37, 99, 235, 0)); padding: 8px; }
.over-image { color: #111111; background-color: #ffffff; background-image: url('nope.png'); padding: 8px; }
.half { color: #111111; background-color: #ffffff; opacity: 0.5; }
.big { font-size: 24px; color: #808080; background-color: #ffffff; }
.small { font-size: 16px; color: #808080; background-color: #ffffff; }
.weird-bg { color: #111111; background-color: oklch(0.5 0.1 200); }
.weird-fg { color: oklch(0.3 0.1 200); background-color: #ffffff; }
button.skipbtn { color: #999999; background-color: #ffffff; }
.ghost { visibility: hidden; color: #999999; background-color: #ffffff; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style></head><body>
<p class="grad">Dark on blue</p>
<p class="grad-light">Light on blue</p>
<p class="fade">Transparent stops</p>
<p class="over-image">Over an image</p>
<p class="half">Half hidden</p>
<p class="big">Big grey</p>
<p class="small">Small grey</p>
<p class="weird-bg">Weird background</p>
<p class="weird-fg">Weird text</p>
<button class="skipbtn" disabled>Skip me</button>
<span class="ghost">Invisible</span>
<span class="sr-only">Screen reader only</span>
</body></html>`;

const PHONE_PAGE = `<!doctype html><html><head><style>
body { margin: 0; background: #fff; }
.row { display: flex; overflow-x: auto; overflow-y: hidden; gap: 8px; }
.row span { flex: 0 0 300px; height: 60px; display: block; }
.scroller { overflow-y: auto; height: 100px; width: 100%; }
.scroller div { width: 800px; height: 50px; }
</style></head><body>
<div class="row"><span>one</span><span>two</span><span>three</span></div>
<div class="scroller"><div data-ref="wide-child">Wide child</div></div>
<a id="tiny-link" style="display: block; width: 30px; height: 20px;">tiny</a>
<a data-ref="${'r'.repeat(300)}" style="display: block; width: 10px; height: 10px;">long name</a>
<button id="ok-button" style="width: 44px; height: 44px;">ok</button>
<button id="narrow-button" style="width: 43px; height: 44px;">narrow</button>
<button disabled style="width: 10px; height: 10px;">dead</button>
<a style="display: block; width: 10px; height: 10px;"><span role="button" style="display: block; width: 8px; height: 8px;">in</span></a>
</body></html>`;

const BROKEN_PAGE = `<!doctype html><html><head></head><body>
<script>
// Only the quality checks read the clock, so breaking it breaks exactly them
const tick = performance.now.bind(performance);
performance.now = () => { throw new Error('tick'); };
</script>
<p>Hello</p></body></html>`;

const HANGING_PAGE = `<!doctype html><html><head></head><body>
<script>
// Only the quality checks read the clock, so freezing it freezes exactly them
performance.now = () => { for (;;) {} };
</script>
<p>Hello</p></body></html>`;

// -- TESTS -- //

describe('render quality checks (rules R5 to R9)', () => {
	let home = '';
	let beforeHome: string | undefined;
	const servers: Server[] = [];

	beforeEach(() => {
		beforeHome = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-quality-'));
		process.env.AFB_BRIDGE_HOME = home;
	});

	afterEach(async () => {
		for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
		if (beforeHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = beforeHome;
		rmSync(home, { recursive: true, force: true });
	});

	it('contrast: an opaque gradient paints over background-color, url and blends are unknown, opacity multiplies, 3.0 holds for large only, and hidden text is skipped', async () => {
		const srv = await startServer(CONTRAST_PAGE);
		servers.push(srv.server);
		const r = await inspectUrl({
			url: srv.url,
			expectedOrigin: srv.origin,
			target: 'mockup',
			width: 1280,
			qualityChecks: true
		});
		const checks = r.checks ?? [];
		const contrast = checks.filter((c) => c.kind === 'contrast');
		// Dark text on the blue gradient fails even though the background-color is light
		expect(severitiesOf(contrast, 'p.grad', 'contrast')).toEqual(['fail']);
		// Light text on the same blue passes
		expect(find(contrast, 'p.grad-light', 'contrast')).toEqual([]);
		// A transparent-stop gradient composites over the light background: it passes
		expect(find(contrast, 'p.fade', 'contrast')).toEqual([]);
		// A url() image layer is unknown, never a guess
		expect(severitiesOf(contrast, 'p.over-image', 'contrast')).toEqual(['unknown']);
		// Opacity .5 multiplies the text alpha down: it fails
		expect(severitiesOf(contrast, 'p.half', 'contrast')).toEqual(['fail']);
		// 3.0 passes for large text and fails for the same colour as normal text
		expect(find(contrast, 'p.big', 'contrast')).toEqual([]);
		expect(severitiesOf(contrast, 'p.small', 'contrast')).toEqual(['fail']);
		// Disabled, hidden and sr-only text is skipped
		expect(find(contrast, 'button.skipbtn', 'contrast')).toEqual([]);
		expect(find(contrast, 'span.ghost', 'contrast')).toEqual([]);
		expect(find(contrast, 'span.sr-only', 'contrast')).toEqual([]);
		// A colour the parser cannot read (oklch) is unknown, never a guess and never a silent skip
		expect(severitiesOf(contrast, 'p.weird-bg', 'contrast')).toEqual(['unknown']);
		expect(severitiesOf(contrast, 'p.weird-fg', 'contrast')).toEqual(['unknown']);
		// The findings are ranked fail before unknown
		const firstUnknown = contrast.findIndex((c) => c.severity === 'unknown');
		const lastFail = contrast.map((c) => c.severity).lastIndexOf('fail');
		expect(firstUnknown).toBeGreaterThan(lastFail);
	}, 90_000);

	it('overflow: the document is reported, a wide child in an overflow-y-auto container fails and an intentional chip row passes', async () => {
		const srv = await startServer(PHONE_PAGE);
		servers.push(srv.server);
		const r = await inspectUrl({
			url: srv.url,
			expectedOrigin: srv.origin,
			target: 'mockup',
			width: 390,
			qualityChecks: true
		});
		const checks = r.checks ?? [];
		const overflow = checks.filter((c) => c.kind === 'overflow');
		expect(overflow.map((c) => c.selector)).toContain('[data-ref="wide-child"]');
		// The chip row passes: no overflow finding names it or its children
		expect(
			overflow
				.map((c) => c.selector)
				.some((s) => (s ?? '').includes('.row') || (s ?? '').includes('span'))
		).toBe(false);
		// The document itself does not scroll sideways here
		expect(overflow.map((c) => c.selector)).not.toContain('document');
	}, 90_000);

	it('tap targets below 640px: 44 by 44 passes, 43 by 44 fails, disabled and nested targets are skipped', async () => {
		const srv = await startServer(PHONE_PAGE);
		servers.push(srv.server);
		const r = await inspectUrl({
			url: srv.url,
			expectedOrigin: srv.origin,
			target: 'mockup',
			width: 390,
			qualityChecks: true
		});
		const checks = r.checks ?? [];
		const tap = checks.filter((c) => c.kind === 'tap');
		expect(severitiesOf(tap, '#tiny-link', 'tap')).toEqual(['fail']);
		// A very long data-ref is clamped to the server's selector cap instead of costing the render
		const longRef = tap.find((c) => (c.selector ?? '').startsWith('[data-ref="rrr'));
		expect(longRef).toBeTruthy();
		expect((longRef?.selector ?? '').length).toBeLessThanOrEqual(200);
		expect(longRef?.ref?.length).toBeLessThanOrEqual(80);
		// 44 by 44 passes, 43 by 44 fails
		expect(find(tap, '#ok-button', 'tap')).toEqual([]);
		expect(severitiesOf(tap, '#narrow-button', 'tap')).toEqual(['fail']);
		// Disabled and nested interactive elements are skipped
		expect(tap.some((c) => c.selector === 'button' || c.selector === 'span')).toBe(false);
	}, 90_000);

	it('a throwing check says it could not run and the render is still saved', async () => {
		const srv = await startServer(BROKEN_PAGE);
		servers.push(srv.server);
		const r = await inspectUrl({
			url: srv.url,
			expectedOrigin: srv.origin,
			target: 'mockup',
			width: 1280,
			captureScreenshot: true,
			qualityChecks: true
		});
		expect(r.screenshot).toBeTruthy();
		expect(r.dump.elements).toBeDefined();
		const unknowns = (r.checks ?? []).filter((c) => c.severity === 'unknown');
		expect(unknowns.length).toBeGreaterThanOrEqual(1);
		expect(unknowns.map((c) => c.detail).join(' ')).toMatch(/check could not run: .*tick/);
	}, 90_000);

	it('a hanging check is stopped by its outside timeout, says so, and the render is still saved', async () => {
		const srv = await startServer(HANGING_PAGE);
		servers.push(srv.server);
		const r = await inspectUrl({
			url: srv.url,
			expectedOrigin: srv.origin,
			target: 'mockup',
			width: 1280,
			captureScreenshot: true,
			qualityChecks: true
		});
		expect(r.screenshot).toBeTruthy();
		expect(r.dump.elements).toBeDefined();
		const unknowns = (r.checks ?? []).filter((c) => c.severity === 'unknown');
		expect(unknowns.length).toBeGreaterThanOrEqual(1);
		expect(unknowns.map((c) => c.detail).join(' ')).toMatch(/check could not run/);
	}, 120_000);
});

describe('grouping and summary (rule R9)', () => {
	const one = (
		kind: RawQualityFinding['kind'],
		severity: RawQualityFinding['severity'],
		selector: string
	): RawQualityFinding => ({
		kind,
		severity,
		selector,
		detail: 'x'
	});

	it('groups by kind, selector and severity with the count in the detail, fail before unknown, capped at 60', () => {
		const raw: RawQualityFinding[] = [
			...Array.from({ length: 58 }, (_, i) => one('contrast', 'fail', `.c${i}`)),
			one('overflow', 'fail', 'document'),
			one('overflow', 'unknown', 'document')
		];
		const grouped = groupQualityFindings(raw);
		expect(grouped).toHaveLength(60);
		// fail before unknown, overflow before contrast
		expect(grouped[0]).toMatchObject({ kind: 'overflow', severity: 'fail', selector: 'document' });
		expect(grouped[1]).toMatchObject({ kind: 'contrast', severity: 'fail', selector: '.c0' });
		expect(grouped[59]).toMatchObject({ kind: 'overflow', severity: 'unknown' });
		// Repeated findings of one group are counted in the detail
		const counted = groupQualityFindings([one('tap', 'fail', '#a'), one('tap', 'fail', '#a')]);
		expect(counted).toHaveLength(1);
		expect(counted[0]?.detail).toContain('(2 elements)');
		// Control characters never reach the output
		const dirty = groupQualityFindings([
			{ kind: 'tap', severity: 'fail', selector: '#a', detail: 'bad\u0007detail' }
		]);
		expect(dirty[0]?.detail).toBe('bad detail');
	});

	it('summarizes one line per push with the counts and up to five top groups', () => {
		expect(summarizeQualityChecks([])).toBe('');
		const checks = groupQualityFindings([
			...Array.from({ length: 8 }, () => one('overflow', 'fail', 'document')),
			one('tap', 'fail', '#tiny'),
			one('contrast', 'unknown', '.img')
		]);
		const line = summarizeQualityChecks(checks);
		expect(line).toMatch(/Quality warnings: 2 fail, 1 could not run \(advisory, never gating\)/);
		expect(line).toMatch(/Top: overflow document/);
		expect(line).toMatch(/tap #tiny/);
	});
});
