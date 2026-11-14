// THE TAILWIND COMPILE AT PUSH TIME (AFB-20261114-0409, C.1): THE PROJECT'S OWN TAILWIND, THE PAGE AS THE ONLY SOURCE

// IMPORTED DEP-MODULES
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	compileTailwind,
	dropLayer,
	findTailwindRoot,
	injectGeneratedStyle,
	pruneKeyframes
} from './tailwind.js';

// -- CONSTANTS -- //

// This repository has Tailwind 4 installed, so it stands in for a project
const REPO = resolve(__dirname, '..', '..', '..');

// -- FUNCTIONS -- //

describe('tailwind compile for a mockup', () => {
	let dir = '';
	let entry = '';
	beforeAll(() => {
		// The entry sits where `tailwindcss/theme.css` resolves (a project's entry does too), in a cache folder git ignores
		const cache = join(REPO, 'node_modules', '.cache');
		mkdirSync(cache, { recursive: true });
		dir = mkdtempSync(join(cache, 'afb-tw-test-'));
		entry = join(dir, 'app.css');
		writeFileSync(
			entry,
			`@layer theme, base, components, utilities;
@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/utilities.css' layer(utilities);
@theme { --color-brand: #07549a; }
@utility font-inherit { font: inherit; }
`
		);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('finds the folder that holds the installed Tailwind, or says there is none', () => {
		expect(findTailwindRoot(join(REPO, 'src', 'app.css'))).toBe(REPO);
		expect(findTailwindRoot(entry, dir)).toBeNull();
	});

	it('emits only the utilities the page uses, in the project theme, and nothing from the app', async () => {
		const html = `<html><body><div class="flex gap-3 rounded-lg bg-brand p-4 transition duration-300 ease-out font-inherit">Hello</div><script>const c = 'text-sm ' + 'hover:underline';</script></body></html>`;
		const built = await compileTailwind({ entry, html, root: REPO });
		expect(built.version.startsWith('4.')).toBe(true);
		for (const rule of [
			'.flex',
			'.gap-3',
			'.rounded-lg',
			'.bg-brand',
			'.transition',
			'.duration-300',
			'.font-inherit'
		])
			expect(built.css).toContain(rule);
		// A class that is not in the page is not in the style
		expect(built.css).not.toContain('.grid-cols-3');
		expect(built.css).not.toContain('.text-5xl');
		// A class that only appears as a string in the page script is still found
		expect(built.css).toContain('.text-sm');
		expect(built.css).toContain('hover\\:underline');
		// The project's own theme variable is defined
		expect(built.css).toMatch(/--color-brand:\s*#07549a/);
	});

	it('compiles @apply rules given as extra CSS with the project theme', async () => {
		const built = await compileTailwind({
			entry,
			html: '',
			root: REPO,
			extraCss: '.card{@apply rounded-lg bg-brand p-4;}'
		});
		expect(built.css).toMatch(/\.card\s*\{[^}]*padding/);
		expect(built.css).toContain('--color-brand');
	});

	it('drops a whole cascade layer, braces and all', () => {
		const css =
			'@layer theme{a{b:c}}@layer base{label{margin:0}@media (x){p{q:r}}}@layer utilities{.x{y:z}}';
		expect(dropLayer(css, 'base')).toBe('@layer theme{a{b:c}}@layer utilities{.x{y:z}}');
	});

	it('keeps only the keyframes the page mentions, and drops the rest of the app', () => {
		const css =
			'.a{animation:drop .3s}@keyframes drop{from{opacity:0}to{opacity:1}}@keyframes auth-in{0%{transform:scale(.9)}100%{transform:none}}.b{color:red}@keyframes other{50%{opacity:.5}}';
		const kept = pruneKeyframes(css, '<div class="x" style="animation:drop"></div>');
		expect(kept).toContain('@keyframes drop');
		expect(kept).not.toContain('auth-in');
		expect(kept).not.toContain('@keyframes other');
		// Rules around a dropped block stay, and nothing is left half cut
		expect(kept).toContain('.a{animation:drop .3s}');
		expect(kept).toContain('.b{color:red}');
		expect((kept.match(/\{/g) ?? []).length).toBe((kept.match(/\}/g) ?? []).length);
		expect(pruneKeyframes('.a{}', 'x')).toBe('.a{}');
	});

	it('refuses a missing entry and a project with no Tailwind, without touching the network', async () => {
		await expect(
			compileTailwind({ entry: join(dir, 'nope.css'), html: '<p></p>' })
		).rejects.toThrow(/does not exist/);
		await expect(compileTailwind({ entry, html: '<p></p>', root: dir })).rejects.toThrow(
			/No installed Tailwind/
		);
	});

	it('puts the generated style at its marker, before </head>, or at the top, and replaces an older one', () => {
		const css = '.a{color:red}';
		expect(injectGeneratedStyle('<head><!--afb-generated--></head>', css)).toContain(
			'<style data-afb-generated>\n.a{color:red}\n</style>'
		);
		const headed = injectGeneratedStyle('<html><head></head><body></body></html>', css);
		expect(headed.indexOf('data-afb-generated')).toBeLessThan(headed.indexOf('</head>'));
		expect(injectGeneratedStyle('<p>x</p>', css).startsWith('<style data-afb-generated>')).toBe(
			true
		);
		const twice = injectGeneratedStyle(headed, '.b{color:blue}');
		expect(twice).toContain('.b{color:blue}');
		expect(twice).not.toContain('.a{color:red}');
		expect(twice.match(/data-afb-generated/g)).toHaveLength(1);
		// A closing style tag inside the css cannot end the block early
		expect(injectGeneratedStyle('<head></head>', 'a::after{content:"</style>"}')).not.toMatch(
			/content:"<\/style>"/
		);
	});
});
