// THE APP FOLDER: NORMALISATION, THE SEGMENT RULES, LINK AND JUNCTION REFUSAL, THE PACKAGE.JSON, ESCAPES AND THE RELATIVE APP PATHS

// -- DEP-MODULES -- //
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	appDirProblem,
	appDirText,
	appRoot,
	gitAppPaths,
	normalizeAppDir,
	sandboxAppRoot,
	walkAppDir
} from './appdir.js';

// -- FUNCTIONS -- //

describe('appdir', () => {
	let base = '';
	let outside = '';
	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), 'afb-appdir-'));
		outside = mkdtempSync(join(tmpdir(), 'afb-appdir-out-'));
		mkdirSync(join(base, 'web'));
		writeFileSync(join(base, 'web', 'package.json'), '{}');
		mkdirSync(join(base, 'apps', 'site'), { recursive: true });
		writeFileSync(join(base, 'apps', 'site', 'package.json'), '{}');
	});
	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it('makes the cosmetic forms one value', () => {
		for (const raw of ['web', 'web/', 'web\\', './web', '.\\web\\', ' web ', './/web'])
			expect(normalizeAppDir(raw)).toBe(raw === './/web' ? '/web' : 'web');
		expect(normalizeAppDir('apps\\site')).toBe('apps/site');
		expect(normalizeAppDir(undefined)).toBe('');
	});

	it('accepts plain folder names, up to four deep', () => {
		for (const ok of ['web', 'landing', 'apps/site', 'a/b/c/d', 'my-app_2', 'v1.2', '_x'])
			expect(appDirText(ok)).toBeNull();
	});

	it('refuses everything that is not a plain relative folder name', () => {
		const bad = [
			'',
			'web/',
			'./web',
			'web\\sub',
			'/etc',
			'C:/x',
			'C:x',
			'..',
			'../web',
			'web/..',
			'web/./x',
			'.',
			'a/b/c/d/e',
			'.git',
			'web/.git',
			'node_modules',
			'Node_Modules',
			'web/node_modules/x',
			'web.',
			'a b',
			'we$b',
			'web:x',
			'con',
			'NUL',
			'aux.txt',
			'com1',
			'lpt9.log',
			'-web',
			'.hidden',
			'x'.repeat(62)
		];
		for (const b of bad) expect(appDirText(b), JSON.stringify(b)).not.toBeNull();
		expect(appDirText(5)).not.toBeNull();
		expect(appDirText(null)).not.toBeNull();
	});

	it('finds a real app folder and reads it relative to the base', () => {
		const r = walkAppDir(base, 'apps/site');
		expect(r.problem).toBeUndefined();
		expect(r.dir).toBe(join(base, 'apps', 'site'));
		expect(appRoot({ repo: base, appDir: 'apps/site' })).toBe(join(base, 'apps', 'site'));
		expect(appRoot({ repo: base })).toBe(base);
	});

	it('says plainly when the folder is missing or is a file', () => {
		expect(walkAppDir(base, 'nope').problem).toMatch(/is not in the repo/);
		expect(walkAppDir(base, 'nope', 'the private copy of the repo').problem).toMatch(
			/is it committed/
		);
		writeFileSync(join(base, 'afile'), 'x');
		expect(walkAppDir(base, 'afile').problem).toMatch(/is not a folder/);
	});

	it('refuses a link or junction as the app folder or on the way to it', () => {
		mkdirSync(join(outside, 'inner'));
		try {
			symlinkSync(outside, join(base, 'linked'), 'junction');
			symlinkSync(outside, join(base, 'web', 'sub'), 'junction');
		} catch {
			return; // This machine does not allow links for this user
		}
		expect(walkAppDir(base, 'linked').problem).toMatch(/link/);
		expect(walkAppDir(base, 'web/sub').problem).toMatch(/link/);
		expect(walkAppDir(base, 'linked/inner').problem).toMatch(/link/);
		expect(appDirProblem(base, 'linked')).toMatch(/link/);
		rmSync(join(base, 'linked'), { force: true });
		rmSync(join(base, 'web', 'sub'), { force: true });
	});

	it('refuses a link inside the private copy and a missing package.json there', () => {
		// The copy is a folder like any other: the same walk runs on it
		try {
			symlinkSync(outside, join(base, 'linkweb'), 'junction');
		} catch {
			return;
		}
		expect(() => sandboxAppRoot(base, 'linkweb')).toThrow(/link/);
		rmSync(join(base, 'linkweb'), { force: true });
		mkdirSync(join(base, 'empty'));
		expect(() => sandboxAppRoot(base, 'empty')).toThrow(/no package\.json in the private copy/);
		expect(sandboxAppRoot(base, 'web')).toBe(join(base, 'web'));
		expect(sandboxAppRoot(base)).toBe(base);
	});

	it('requires a package.json in the app folder of the live repo', () => {
		mkdirSync(join(base, 'bare'));
		expect(appDirProblem(base, 'bare')).toMatch(/no package\.json/);
		expect(appDirProblem(base, 'web')).toBeNull();
		expect(appDirProblem(base, '../web')).toMatch(/\.\./);
	});

	it('writes the app paths relative to the git root', () => {
		expect(gitAppPaths(['src', '.', 'package.json'], 'web')).toEqual([
			'web/src',
			'web',
			'web/package.json'
		]);
		expect(gitAppPaths(['src', '.'])).toEqual(['src', '.']);
	});
});
