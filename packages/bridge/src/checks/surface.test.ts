// TESTS OF THE SURFACE HASH: THE DECIDING FILES, THE GIT ROOT'S FILES FOR AN APP FOLDER, LINE ENDINGS AND LINKS.

// IMPORTED DEP-MODULES
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { surfaceHash } from './surface.js';

// -- FUNCTIONS -- //

describe('surfaceHash', () => {
	let base = '';
	let app = '';
	const put = (rel: string, body: string) => {
		const file = join(app, rel);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(file, body);
	};
	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-surface-')));
		app = join(base, 'app');
		mkdirSync(app);
		put('package.json', JSON.stringify({ name: 'x', scripts: { build: 'vite build' } }));
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it('is stable and names the files', () => {
		put('yarn.lock', 'a');
		const a = surfaceHash(app);
		expect(surfaceHash(app).hash).toBe(a.hash);
		expect(a.files).toEqual(['package.json#scripts', 'yarn.lock']);
	});
	it('changes with the scripts but not with other package.json fields', () => {
		const a = surfaceHash(app).hash;
		put('package.json', JSON.stringify({ name: 'renamed', scripts: { build: 'vite build' } }));
		expect(surfaceHash(app).hash).toBe(a);
		put('package.json', JSON.stringify({ name: 'x', scripts: { build: 'node evil.js' } }));
		expect(surfaceHash(app).hash).not.toBe(a);
	});
	it('changes with a lockfile, an npmrc, the recipe, a build config and a package manager program', () => {
		const seen = new Set([surfaceHash(app).hash]);
		for (const [file, body] of [
			['pnpm-lock.yaml', 'l'],
			['.npmrc', 'x=1'],
			['.afb-checks.json', '{}'],
			['vite.config.ts', 'export default {}'],
			['.yarn/releases/yarn-4.cjs', 'program'],
			['.yarn/plugins/p.cjs', 'plugin']
		] as const) {
			put(file, body);
			seen.add(surfaceHash(app).hash);
		}
		expect(seen.size).toBe(7);
	});
	it('does not change with line endings', () => {
		put('.yarnrc.yml', 'a: 1\nb: 2\n');
		const a = surfaceHash(app).hash;
		put('.yarnrc.yml', 'a: 1\r\nb: 2\r\n');
		expect(surfaceHash(app).hash).toBe(a);
	});
	it('adds the git root fixed files and programs when an app folder is used', () => {
		const alone = surfaceHash(app);
		put('../.yarnrc.yml', 'nodeLinker: node-modules');
		expect(surfaceHash(app).hash).toBe(alone.hash);
		const withRoot = surfaceHash(app, base);
		expect(withRoot.hash).not.toBe(alone.hash);
		expect(withRoot.files).toContain('root:.yarnrc.yml');
		put('../.yarn/releases/yarn.cjs', 'p');
		expect(surfaceHash(app, base).files).toContain('root:.yarn/releases/yarn.cjs');
		// The recipe of the git root is not part of an app's surface
		put('../.afb-checks.json', '{}');
		expect(surfaceHash(app, base).files).not.toContain('root:.afb-checks.json');
		// Without a parent, or with the same folder, nothing is added
		expect(surfaceHash(app, app).hash).toBe(alone.hash);
	});
	it('hashes a link as a marker, whatever it points at', () => {
		const target = join(base, 'target.txt');
		writeFileSync(target, 'one');
		try {
			symlinkSync(target, join(app, 'yarn.lock'), 'file');
		} catch {
			return; // This machine cannot make file links
		}
		const a = surfaceHash(app).hash;
		writeFileSync(target, 'two');
		expect(surfaceHash(app).hash).toBe(a);
	});
});
