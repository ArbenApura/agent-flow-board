// TESTS OF THE FOLDER BINDING: STORE, READ, LIST, REMOVE, VALIDATION AND THE PIN STATUS.

// -- DEP-MODULES -- //
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { bindFolder, boundFolder, listBindings, pinStatus, unbind } from './bind.js';
import { bindingsFile } from './paths.js';
import { pinFiles } from './recipe.js';

// -- FUNCTIONS -- //

describe('bind', () => {
	let base = '';
	let repo = '';
	let savedBridge: string | undefined;

	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-bind-')));
		savedBridge = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
		repo = join(base, 'repo');
		mkdirSync(join(repo, '.git'), { recursive: true });
		writeFileSync(
			join(repo, 'package.json'),
			JSON.stringify({ scripts: { preview: 'vite preview' } })
		);
	});
	afterEach(() => {
		if (savedBridge === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = savedBridge;
		rmSync(base, { recursive: true, force: true });
	});

	it('has no binding at first', () => {
		expect(boundFolder('acme', 'AFB')).toBeNull();
		expect(listBindings()).toEqual([]);
		expect(pinStatus('acme', 'AFB')).toBe('unbound');
	});
	it('stores the real path and the pin', () => {
		bindFolder('acme', 'AFB', repo, 'pin-1');
		expect(boundFolder('acme', 'AFB')).toEqual({ folder: repo, pin: 'pin-1' });
		expect(listBindings()).toEqual([
			{ org: 'acme', projectKey: 'AFB', folder: repo, pin: 'pin-1' }
		]);
	});
	it('replaces a binding for the same project and keeps others', () => {
		bindFolder('acme', 'AFB', repo, 'a');
		bindFolder('acme', 'WEB', repo, 'b');
		bindFolder('acme', 'AFB', repo, 'c');
		expect(listBindings().map((b) => `${b.projectKey}:${b.pin}`)).toEqual(['AFB:c', 'WEB:b']);
	});
	it('writes atomically: no temp file is left and the file is JSON', () => {
		bindFolder('acme', 'AFB', repo, 'a');
		expect(existsSync(bindingsFile())).toBe(true);
		expect(readdirSync(dirname(bindingsFile())).filter((n) => n.endsWith('.tmp'))).toEqual([]);
		expect(JSON.parse(readFileSync(bindingsFile(), 'utf8')).version).toBe(1);
	});
	it('refuses a folder the guardrails refuse', () => {
		expect(() => bindFolder('acme', 'AFB', join(base, 'missing'), 'p')).toThrow('does not exist');
		expect(boundFolder('acme', 'AFB')).toBeNull();
	});
	it('refuses a bad org and a bad key', () => {
		expect(() => bindFolder('Bad Org', 'AFB', repo, 'p')).toThrow('slug');
		expect(() => bindFolder('acme', 'afb', repo, 'p')).toThrow('capital');
		expect(() => bindFolder('acme', 'A', repo, 'p')).toThrow('capital');
		expect(() => bindFolder('acme', 'ABCDEFGHIJK', repo, 'p')).toThrow('capital');
		expect(() => boundFolder('acme', '../x')).toThrow('capital');
		expect(() => unbind('../x', 'AFB')).toThrow('slug');
	});
	it('removes a binding', () => {
		bindFolder('acme', 'AFB', repo, 'a');
		expect(unbind('acme', 'AFB')).toBe(true);
		expect(unbind('acme', 'AFB')).toBe(false);
		expect(boundFolder('acme', 'AFB')).toBeNull();
	});
	it('reports ok while the files are as pinned and changed after a change', () => {
		bindFolder('acme', 'AFB', repo, pinFiles(repo));
		expect(pinStatus('acme', 'AFB')).toBe('ok');
		writeFileSync(
			join(repo, 'package.json'),
			JSON.stringify({ scripts: { preview: 'vite preview --host 127.0.0.1' } })
		);
		expect(pinStatus('acme', 'AFB')).toBe('changed');
	});
	it('reports changed when the folder is gone', () => {
		bindFolder('acme', 'AFB', repo, pinFiles(repo));
		rmSync(repo, { recursive: true, force: true });
		expect(pinStatus('acme', 'AFB')).toBe('changed');
	});
	it('fails loudly on a damaged bindings file', () => {
		bindFolder('acme', 'AFB', repo, 'a');
		writeFileSync(bindingsFile(), '{ nope');
		expect(() => listBindings()).toThrow('not valid JSON');
	});
});
