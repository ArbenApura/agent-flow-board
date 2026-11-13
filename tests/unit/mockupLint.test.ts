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
		// The page reacts to the screen the board picks, so the check for a page that ignores it stays quiet too
		const declared =
			'<meta name="afb-config" content=\'{"screens":[["a","A"],["b","B"]],"options":[]}\'><style>[data-screen="b"] .a{display:none}</style>';
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

// -- WHAT THE PAGE DECLARES, AND WHETHER IT CAN REACT (AFB-20261112-2350) -- //

describe('the options and screens a page declares', () => {
	const page = (config: string, rest = '') =>
		`<!doctype html><html><head><!--afb-kit--><meta name="afb-config" content='${config}'>${rest}</head><body></body></html>`;
	const SCREENS = '"screens":[["a","A"],["b","B"]]';
	const opt = (key: string, extra = '') =>
		`{"key":"${key}","label":"${key} label","values":[["x","X"],["y","Y"]]${extra}}`;
	const REACTS =
		'<style>[data-role="y"] .a{display:none}[data-view="y"] .a{display:none}[data-flag="y"] .a{display:none}[data-screen="b"] .a{display:none}</style>';

	it('warns when an option names a screen the page did not declare', () => {
		const w = lintMockupHtml(
			page(`{${SCREENS},"options":[${opt('role', ',"screens":["a","nope"]')}]}`, REACTS)
		);
		expect(w.some((x) => x.includes('did not declare') && x.includes('nope'))).toBe(true);
	});
	it('warns about three options shown on every one of several screens, and only then', () => {
		const three = `${opt('role')},${opt('view')},${opt('flag')}`;
		expect(
			lintMockupHtml(page(`{${SCREENS},"options":[${three}]}`, REACTS)).some((x) =>
				x.includes('options show on every one')
			)
		).toBe(true);
		const scoped = `${opt('role', ',"screens":["a"]')},${opt('view', ',"screens":["a"]')},${opt('flag')}`;
		expect(lintMockupHtml(page(`{${SCREENS},"options":[${scoped}]}`, REACTS))).toEqual([]);
		// One screen only: nothing to scope
		expect(lintMockupHtml(page(`{"screens":[["a","A"]],"options":[${three}]}`, REACTS))).toEqual(
			[]
		);
	});
	it('warns about an option that nothing in the page can react to', () => {
		const w = lintMockupHtml(page(`{${SCREENS},"options":[${opt('role')}]}`));
		expect(w.some((x) => x.includes('will do nothing') && x.includes('data-role'))).toBe(true);
		expect(w.some((x) => x.includes('nothing reads data-screen'))).toBe(true);
	});
	it('stays quiet for a page that reads the attribute or defines window.afbSet', () => {
		expect(lintMockupHtml(page(`{"screens":[],"options":[${opt('role')}]}`, REACTS))).toEqual([]);
		const hook = '<script>window.afbSet = function (k, v) { show(k, v); };</script>';
		expect(lintMockupHtml(page(`{${SCREENS},"options":[${opt('role')}]}`, hook))).toEqual([]);
		expect(
			lintMockupHtml(
				page(
					`{"screens":[],"options":[${opt('dark-tone')}]}`,
					'<script>if (document.documentElement.dataset.darkTone) go();</script>'
				)
			)
		).toEqual([]);
	});
	it('does not count a commented out window.afbSet as the page reacting', () => {
		const starter = '<script>\n// window.afbSet = function (key, value) {};\n</script>';
		expect(
			lintMockupHtml(page(`{"screens":[],"options":[${opt('role')}]}`, starter)).some((x) =>
				x.includes('will do nothing')
			)
		).toBe(true);
	});
	it('leaves the colour mode to the kit stylesheet', () => {
		expect(lintMockupHtml(page(`{"screens":[],"options":[${opt('mode')}]}`))).toEqual([]);
	});
	it('reads content written with entities and says nothing about content it cannot read', () => {
		const encoded = `<!doctype html><html><head><meta name="afb-config" content="{&quot;screens&quot;:[],&quot;options&quot;:[{&quot;key&quot;:&quot;role&quot;,&quot;label&quot;:&quot;Role&quot;,&quot;values&quot;:[[&quot;x&quot;,&quot;X&quot;],[&quot;y&quot;,&quot;Y&quot;]]}]}"></head><body></body></html>`;
		expect(lintMockupHtml(encoded).some((x) => x.includes('will do nothing'))).toBe(true);
		for (const bad of [
			'{not json',
			'[]',
			'null',
			'{"options":"x","screens":5}',
			'{"options":[null,1,{"key":5}]}'
		])
			expect(lintMockupHtml(page(bad))).toEqual([]);
	});
	it('stays fast on pages built to make a pattern backtrack, and never builds a pattern from an option key', () => {
		// Many openers with the name and no closing bracket: a pattern over the whole page took seconds for a few kilobytes
		const openers = '<meta name="afb-config" '.repeat(8000);
		let start = Date.now();
		expect(() => lintMockupHtml(openers)).not.toThrow();
		expect(Date.now() - start).toBeLessThan(1500);
		// A key made of pattern characters, next to the text that makes such a pattern backtrack for minutes
		const hostile = page(
			`{"screens":[],"options":[${opt('(a|aa)+$')}]}`,
			`<script>${'dataset.' + 'a'.repeat(60) + '!'}</script>`
		);
		start = Date.now();
		expect(() => lintMockupHtml(hostile)).not.toThrow();
		expect(Date.now() - start).toBeLessThan(1500);
	});
	it('warns when the board will cut a list of screens, options or values, so the rest can never be reached', () => {
		const many = (n: number) => Array.from({ length: n }, (_, i) => [`v${i}`, `V${i}`]);
		const longOption = `{"key":"role","label":"Role","values":${JSON.stringify(many(14))}}`;
		const w = lintMockupHtml(
			page(`{"screens":${JSON.stringify(many(13))},"options":[${longOption}]}`, REACTS)
		);
		expect(w.some((x) => x.includes('13 screens') && x.includes('first 12'))).toBe(true);
		expect(w.some((x) => x.includes('14 values') && x.includes('first 12'))).toBe(true);
		const seven = Array.from({ length: 7 }, (_, i) => opt(`o${i}`)).join(',');
		expect(
			lintMockupHtml(page(`{"screens":[],"options":[${seven}]}`, REACTS)).some((x) =>
				x.includes('7 options')
			)
		).toBe(true);
		// At the limits nothing is said
		const atLimit = `{"key":"role","label":"Role","values":${JSON.stringify(many(12))}}`;
		expect(
			lintMockupHtml(
				page(`{"screens":${JSON.stringify(many(12))},"options":[${atLimit}]}`, REACTS)
			).some((x) => x.includes('cannot be reached'))
		).toBe(false);
	});
	it('keeps the other warnings of a page whose options hold keys the board would refuse', () => {
		const w = lintMockupHtml(
			page(
				`{"screens":[],"options":[${opt('(')},${opt('\\\\')}]}`,
				'<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inter">'
			)
		);
		expect(w.some((x) => x.includes('fonts.googleapis.com'))).toBe(true);
	});
});
