// TESTS OF THE ROOTS: AT MOST FIVE, SEALED, THE REFUSED FOLDERS, AN APPROVAL TO ADD OR REMOVE, AND THE HOLDING ROOT BY REAL PATH.

// IMPORTED DEP-MODULES
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { mintApproval } from './approve.js';
import { rootsFile } from './paths.js';
import { MAX_ROOTS, addRoot, listRoots, readRoots, removeRoot, rootHolding } from './roots.js';

// -- FUNCTIONS -- //

describe('roots', () => {
	let base = '';
	let work = '';
	let saved: string | undefined;
	const code = (dir: string) => mintApproval('roots', dir, { isTTY: true }).code;
	const folder = (name: string) => {
		const d = join(work, name);
		mkdirSync(d, { recursive: true });
		return realpathSync.native(d);
	};

	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-roots-')));
		saved = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
		work = join(base, 'work');
		mkdirSync(work);
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = saved;
		rmSync(base, { recursive: true, force: true });
	});

	it('has no roots at first', () => {
		expect(listRoots()).toEqual([]);
		expect(readRoots().problem).toBeNull();
	});
	it('adds a root only with a valid code for that folder', () => {
		const a = folder('a');
		expect(() => addRoot(a, undefined)).toThrow(/needs a code/);
		expect(() => addRoot(a, 'AAAA-AAAA-AAAA')).toThrow(/needs a code/);
		const c = code(a);
		expect(() => addRoot(folder('b'), c)).toThrow(/needs a code/);
		expect(addRoot(a, c)).toBe(a);
		expect(listRoots()).toEqual([a]);
		// The code was used up
		expect(() => addRoot(folder('b'), c)).toThrow(/needs a code/);
	});
	it('does not use up a code on a folder that is refused', () => {
		const c = code(parse(work).root);
		expect(() => addRoot(parse(work).root, c)).toThrow(/top of a drive/);
	});
	it('refuses a drive, the home folder, the bridge home and key folders', () => {
		expect(() => addRoot(parse(work).root, 'x')).toThrow(/top of a drive/);
		expect(() => addRoot(homedir(), 'x')).toThrow(/home folder/);
		expect(() => addRoot(dirname(homedir()), 'x')).toThrow(/home folder or above/);
		mkdirSync(process.env.AFB_BRIDGE_HOME ?? '', { recursive: true });
		expect(() => addRoot(process.env.AFB_BRIDGE_HOME ?? '', 'x')).toThrow(/bridge home/);
		expect(() => addRoot(base, 'x')).toThrow(/bridge home/);
		const ssh = join(work, '.ssh', 'projects');
		mkdirSync(ssh, { recursive: true });
		expect(() => addRoot(ssh, 'x')).toThrow(/keys or logins/);
		expect(() => addRoot(join(work, 'missing'), 'x')).toThrow(/does not exist/);
		const file = join(work, 'file.txt');
		writeFileSync(file, 'x');
		expect(() => addRoot(file, 'x')).toThrow(/not a folder/);
	});
	it('keeps at most five roots', () => {
		for (let i = 0; i < MAX_ROOTS; i++) {
			const d = folder(`r${i}`);
			addRoot(d, code(d));
		}
		const extra = folder('extra');
		expect(() => addRoot(extra, code(extra))).toThrow(/already 5 roots/);
		expect(listRoots()).toHaveLength(MAX_ROOTS);
	});
	it('removes a root only with a code', () => {
		const a = folder('a');
		addRoot(a, code(a));
		expect(() => removeRoot(a, undefined)).toThrow(/needs a code/);
		expect(listRoots()).toEqual([a]);
		expect(removeRoot(a, code(a))).toBe(a);
		expect(listRoots()).toEqual([]);
		expect(() => removeRoot(a, code(a))).toThrow(/not a root/);
	});
	it('refuses a roots file that was written by hand or changed', () => {
		const a = folder('a');
		addRoot(a, code(a));
		const doc = JSON.parse(readFileSync(rootsFile(), 'utf8')) as {
			body: { roots: string[] };
			mac: string;
		};
		doc.body.roots.push(folder('b'));
		writeFileSync(rootsFile(), JSON.stringify(doc));
		expect(listRoots()).toEqual([]);
		expect(readRoots().problem).toMatch(/not written by/);
		writeFileSync(rootsFile(), JSON.stringify({ body: { roots: [folder('b')] } }));
		expect(readRoots().problem).toMatch(/not one this tool wrote/);
	});
	it('finds the root that holds a repo by real path', () => {
		const a = folder('a');
		addRoot(a, code(a));
		const repo = join(a, 'deep', 'repo');
		mkdirSync(repo, { recursive: true });
		expect(rootHolding(repo)).toBe(a);
		expect(rootHolding(a)).toBe(a);
		expect(rootHolding(join(a, 'deep', '..', '..', 'work'))).toBeNull();
		expect(rootHolding(folder('elsewhere'))).toBeNull();
		expect(rootHolding(join(a, 'missing'))).toBeNull();
	});
	it('does not let a link inside a root lead out of it', () => {
		const a = folder('a');
		const outside = folder('outside');
		addRoot(a, code(a));
		const link = join(a, 'link');
		try {
			symlinkSync(outside, link, 'junction');
		} catch {
			return; // This machine cannot make links; nothing to prove
		}
		expect(rootHolding(link)).toBeNull();
	});
});
