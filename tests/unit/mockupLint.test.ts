// THE FAITHFUL RENDERING CHECK: EVERY WARNING, A CLEAN PAGE, A CLEAN KIT AND A HOSTILE PAGE

// -- DEP-MODULES -- //
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { kitFacts, lintKitHtml, lintMockupHtml } from '../../src/lib/server/mockups/lint';

// -- CONSTANTS -- //

const FONT = `url(data:font/woff2;base64,${'A'.repeat(400)})`;
const KIT = `<!doctype html><html><head><meta charset="utf-8">
<!--afb-kit:start-->
<style>
@font-face{font-family:'Poppins';src:${FONT} format('woff2');font-weight:400}
:root,[data-mode="light"]{--bg:#f3f4f7;--ink:#14171c;--accent:#2563eb}
[data-mode="dark"]{--bg:#0c0e11;--ink:#f1f3f6;--accent:#6b9bff}
body{font-family:'Poppins',sans-serif}
</style>
<svg style="display:none"><symbol id="i-home" viewBox="0 0 24 24"><path d="M3 9l9-7"/></symbol></svg>
<!--afb-kit:end-->
</head><body></body></html>`;
const PAGE = `<!doctype html><html><head><!--afb-kit--><style>
body{font-family:'Poppins',sans-serif;background:var(--bg);color:var(--ink)}
.btn{background:#2563eb}
</style></head><body><svg><use href="#i-home"/></svg><h1>Registry</h1></body></html>`;

// -- FUNCTIONS -- //

describe('tools of the viewer drawn inside a page', () => {
	const page = (body: string, head = '') =>
		`<!doctype html><html><head><!--afb-kit-->${head}</head><body>${body}</body></html>`;

	it('warns about a colour mode switch the page draws, however it is named', () => {
		for (const body of [
			'<button id="theme-toggle">x</button>',
			'<button class="mode-switch">x</button>',
			'<button aria-label="Switch between light and dark">x</button>'
		]) {
			const got = lintMockupHtml(page(body));
			expect(got.some((w) => w.includes('colour mode switch'))).toBe(true);
		}
	});
	it('warns about a row of the screens of the mockup when none are declared', () => {
		const got = lintMockupHtml(page('<div class="screen-switcher"></div>'));
		expect(got.some((w) => w.includes('row of screens'))).toBe(true);
	});
	it('stays quiet when the screens are declared, and for an ordinary page', () => {
		const declared =
			'<meta name="afb-config" content=\'{"screens":[["a","A"],["b","B"]],"options":[]}\'>';
		expect(lintMockupHtml(page('<div class="screen-switcher"></div>', declared))).toEqual([]);
		expect(lintMockupHtml(page('<nav class="tabs"><button>One</button></nav>'))).toEqual([]);
	});
});

describe('lintMockupHtml', () => {
	const kit = kitFacts(KIT);
	it('has no warning for a clean page that uses the kit', () => {
		expect(lintMockupHtml(PAGE, kit)).toEqual([]);
		expect(lintMockupHtml('<p>Hello</p>')).toEqual([]);
	});
	it('reads the kit families and palette', () => {
		expect(kit.families).toEqual(['poppins']);
		expect([...kit.palette].sort()).toEqual(
			['#0c0e11', '#14171c', '#2563eb', '#6b9bff', '#f1f3f6', '#f3f4f7'].sort()
		);
	});
	it('warns about a font, stylesheet, image or script loaded by address', () => {
		const w = lintMockupHtml(
			`<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inter">
<style>@import url(//cdn.example.com/a.css);.x{background:url('http://img.example.com/a.png')}</style>
<img src="https://img.example.com/b.png"><script src="https://cdn.example.com/x.js"></script>`
		);
		const text = w.join('\n');
		expect(text).toContain('from the network');
		expect(text).toContain('fonts.googleapis.com');
		expect(text).toContain('script');
		expect(text).toContain('image');
		expect(text).toContain('sandboxed with no network');
	});
	it('does not warn about an ordinary link to another page', () => {
		expect(lintMockupHtml('<a href="https://example.com/docs">Docs</a>')).toEqual([]);
	});
	it('warns about an icon font with no embedded file, by family and by class', () => {
		expect(
			lintMockupHtml(
				`<style>.i{font-family:'Material Icons'}</style><span class="i">home</span>`
			).join(' ')
		).toContain('icon font Material Icons');
		expect(lintMockupHtml('<i class="fa fa-home"></i>').join(' ')).toContain('icon font classes');
		const embedded = `<style>@font-face{font-family:'Material Icons';src:${FONT}}.i{font-family:'Material Icons'}</style>`;
		expect(lintMockupHtml(embedded)).toEqual([]);
	});
	it('warns about a font that is not one of the kit families, only when the kit has fonts', () => {
		const page = `<style>body{font-family:'Inter',sans-serif}</style>`;
		expect(lintMockupHtml(page, kit).join(' ')).toContain('font Inter');
		expect(lintMockupHtml(page, { families: [], palette: new Set() })).toEqual([]);
		expect(lintMockupHtml(page)).toEqual([]);
		expect(lintMockupHtml(`<style>body{font-family:var(--font-sans)}</style>`, kit)).toEqual([]);
	});
	it('accepts an icon font the kit embeds, and warns about files a stylesheet loads by a relative address', () => {
		const iconKit = kitFacts(
			`<!--afb-kit:start--><style>@font-face{font-family:'Phosphor';src:${FONT}}:root{--a:#fff}</style><!--afb-kit:end-->`
		);
		const page = `<style>.i{font-family:'Phosphor'}</style><i class="ph ph-house"></i>`;
		expect(lintMockupHtml(page, iconKit)).toEqual([]);
		expect(lintMockupHtml(page).join(' ')).toContain('icon font');
		const rel = lintMockupHtml(
			`<style>@font-face{font-family:'X';src:url(/fonts/x.woff2)}.a{background:url(./a.png)}.b{fill:url(#g)}.c{src:url(data:font/woff2;base64,AAAA)}</style>`
		).join(' ');
		expect(rel).toContain('2 files are loaded by a relative address');
		// A percent-encoded fragment inside an encoded SVG data address is not a file
		expect(
			lintMockupHtml(
				`<style>.a{background:url("data:image/svg+xml,%3csvg fill='url(%23a)'%3e")}</style>`
			)
		).toEqual([]);
	});
	it('reads oklch colours into the kit palette', () => {
		const facts = kitFacts(
			`<!--afb-kit:start--><style>:root{--c:oklch(0.62 0.19 259)}</style><!--afb-kit:end-->`
		);
		expect(facts.palette.has('oklch(0.620.19259)')).toBe(true);
		expect(lintMockupHtml('<style>.a{color:oklch(0.5 0.1 10)}</style>', facts).join(' ')).toContain(
			'1 colour is'
		);
	});
	it('warns about emoji and symbols used as icons, but not about a trade mark or code', () => {
		expect(
			lintMockupHtml('<button>⚙ Settings</button><span>✓ Saved</span><b>🔥</b>').join(' ')
		).toContain('3 emoji or symbol characters');
		expect(lintMockupHtml('<p>Acme© and ™</p><script>var a="🔥";</script>')).toEqual([]);
	});
	it('counts colours that are not in the kit palette, and ignores the ones that are', () => {
		const page = `<style>.a{color:#ff0000}.b{color:#FF0000}.c{background:rgb(1, 2, 3)}.d{color:#2563eb}</style><div style="color:#00ff00"></div>`;
		const w = lintMockupHtml(page, kit);
		expect(w).toHaveLength(1);
		expect(w[0]).toContain('3 colours are');
		expect(w[0]).toContain("project's own classes or colour tokens");
		expect(lintMockupHtml(page)).toEqual([]);
	});
	it('has no warning for the starter page the skill ships, so the starter cannot drift into warnings', () => {
		const md = readFileSync('src/lib/server/system-skills/skills/flow-mockup/starter.md', 'utf8');
		const html = /```html\r?\n([\s\S]*?)```/.exec(md)?.[1] ?? '';
		expect(html).toContain('<!--afb-kit-->');
		expect(lintMockupHtml(html, kitFacts(KIT))).toEqual([]);
	});
	it('echoes only printable text in a warning, so the stored answer is valid in any database', () => {
		const w = lintMockupHtml(
			`<style>@import url(//a\u0000b.example/x.css);.i{font-family:'Font Awesome\u0000 5'}</style><p>\ud83d\ude00</p>`
		).join('\n');
		expect([...w].every((c) => c >= ' ' || c === '\n')).toBe(true);
		expect(w).not.toMatch(/[\ud800-\udfff]/);
	});
	it('stays fast and never throws on a hostile page', () => {
		const hostile = [
			'<link '.repeat(500_000),
			'<style>' + 'font-family:'.repeat(300_000),
			'x'.repeat(5_000_000),
			'<img src="https://a.example/' + 'a'.repeat(3_000_000),
			`url(data:${'A'.repeat(4_000_000)}`,
			'\u0000\uD800<<<>>>"\'`'.repeat(100_000),
			'@font-face{'.repeat(200_000),
			'@import' + ' '.repeat(1_900_000),
			'url(' + ' '.repeat(1_900_000),
			'url(' + ' x'.repeat(900_000),
			'src="' + ' '.repeat(1_900_000),
			'<script '.repeat(250_000),
			'<style>'.repeat(280_000) + '<svg ' + '<svg '.repeat(100_000),
			'class="' + 'fa '.repeat(400_000),
			// Past the 8 MB scan cap, and the worst case of the relative address check
			'url(' + ' '.repeat(11) + '#',
			('url(' + ' '.repeat(11) + '#').repeat(300_000),
			'<style>' + '.a{background:url(a.png)}'.repeat(350_000)
		];
		for (const h of hostile) {
			const start = Date.now();
			expect(() => lintMockupHtml(h, kit)).not.toThrow();
			expect(Date.now() - start).toBeLessThan(2500);
		}
	});
});

describe('lintKitHtml', () => {
	it('has no warning for a clean kit', () => {
		expect(lintKitHtml(KIT)).toEqual([]);
	});
	it('warns when no font is embedded, and says so when a font is loaded by address', () => {
		expect(lintKitHtml(KIT.replace(FONT, 'url(x)')).join(' ')).toContain('loaded by address');
		expect(lintKitHtml('<style>body{}</style>').join('\n')).toContain('embeds no font file');
		const byAddress = `<style>@font-face{font-family:'Poppins';src:url(https://fonts.example/p.woff2)}</style>`;
		expect(lintKitHtml(byAddress).join('\n')).toContain('loaded by address');
	});
	it('needs no icon sprite, and warns about one colour mode only or no marked head', () => {
		const bare = `<style>@font-face{font-family:'P';src:${FONT}}:root{--a:#fff}</style>`;
		const w = lintKitHtml(bare).join('\n');
		expect(w).not.toContain('icon');
		expect(w).toContain('one colour mode only');
		expect(
			lintKitHtml(`${bare}<style>[data-bs-theme=dark]{--a:#000}</style>`).join('\n')
		).not.toContain('one colour mode only');
		expect(w).toContain('<!--afb-kit:start-->');
	});
	it('stays fast and never throws on a hostile kit', () => {
		for (const h of [
			'<symbol '.repeat(500_000),
			'x'.repeat(5_000_000),
			'@font-face{'.repeat(300_000)
		]) {
			const start = Date.now();
			expect(() => lintKitHtml(h)).not.toThrow();
			expect(Date.now() - start).toBeLessThan(2500);
		}
	});
});
