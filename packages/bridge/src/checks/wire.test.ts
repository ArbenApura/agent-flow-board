// TESTS OF WHAT THE BOARD IS TOLD: THE REGISTRATIONS HEADER AND THE CLEANED REPORT FIELDS.

// IMPORTED DEP-MODULES
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { readBranch, registrationsHeader, sanitiseReport } from './wire.js';

// -- TYPES -- //

type Entry = { p: string; n: string; r?: string; b?: string };

// -- FUNCTIONS -- //

const decode = (header: string): Entry[] =>
	JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Entry[];
const reg = (name: string, extra: Record<string, unknown> = {}) => ({
	org: 'acme',
	name,
	boardProject: 'HAPR',
	repo: join(tmpdir(), 'work', 'hapr-gameplan'),
	...extra
});

describe('registrationsHeader', () => {
	it('is empty without registrations', () => {
		expect(registrationsHeader('acme', [])).toBe('');
	});
	it('lists only this organisation, with the folder name and the branch', () => {
		const header = registrationsHeader('acme', [
			reg('HAPRM', { branch: 'main' }),
			{ ...reg('OTHER'), org: 'beta' }
		]);
		expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decode(header)).toEqual([{ p: 'HAPR', n: 'HAPRM', r: 'hapr-gameplan', b: 'main' }]);
	});
	it('drops a bad folder name or branch but keeps the entry', () => {
		const out = decode(
			registrationsHeader('acme', [
				reg('A1', { repoName: 'bad/name', branch: 'ok-branch' }),
				reg('A2', { repoName: 'fine folder', branch: 'bad branch with spaces' }),
				reg('A3', { repoName: 'x'.repeat(101), branch: 'a'.repeat(101) }),
				reg('A4', { repoName: "it's", branch: 'feat/x;y' })
			])
		);
		expect(out).toEqual([
			{ p: 'HAPR', n: 'A1', b: 'ok-branch' },
			{ p: 'HAPR', n: 'A2', r: 'fine folder' },
			{ p: 'HAPR', n: 'A3' },
			{ p: 'HAPR', n: 'A4' }
		]);
	});
	it('leaves out an entry whose project key or name the board would refuse', () => {
		const out = decode(
			registrationsHeader('acme', [
				reg('GOOD'),
				reg('bad name'),
				{ ...reg('LOWER'), boardProject: 'hapr' }
			])
		);
		expect(out.map((e) => e.n)).toEqual(['GOOD']);
	});
	it('sends at most 16 entries', () => {
		const many = Array.from({ length: 30 }, (_, i) => reg(`R${i}`));
		expect(decode(registrationsHeader('acme', many))).toHaveLength(16);
	});
	it('never carries a path', () => {
		const header = registrationsHeader('acme', [reg('HAPRM')]);
		expect(Buffer.from(header, 'base64url').toString('utf8')).not.toContain('work');
	});
});

describe('sanitiseReport', () => {
	it('drops a bad field and keeps the rest', () => {
		expect(
			sanitiseReport({
				result: 'pass',
				registration: 'HAPR M',
				repoName: 'ok',
				branch: 'bad branch'
			})
		).toEqual({ result: 'pass', repoName: 'ok' });
		expect(sanitiseReport({ registration: 'HAPRM', repoName: 'a/b', branch: 'feat/x' })).toEqual({
			registration: 'HAPRM',
			branch: 'feat/x'
		});
	});
	it('leaves a clean report alone', () => {
		const clean = { registration: 'HAPRM', repoName: 'hapr-gameplan', branch: 'main' };
		expect(sanitiseReport(clean)).toEqual(clean);
	});
});

describe('readBranch', () => {
	let base = '';
	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-wire-')));
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));
	it('reads the branch from .git/HEAD, null when detached or missing', () => {
		mkdirSync(join(base, '.git'));
		expect(readBranch(base)).toBeNull();
		writeFileSync(join(base, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
		expect(readBranch(base)).toBe('feat/x');
		writeFileSync(join(base, '.git', 'HEAD'), 'a'.repeat(40) + '\n');
		expect(readBranch(base)).toBeNull();
	});
	it('follows a gitdir file', () => {
		mkdirSync(join(base, 'real-git'));
		writeFileSync(join(base, 'real-git', 'HEAD'), 'ref: refs/heads/main\n');
		mkdirSync(join(base, 'wt'));
		writeFileSync(join(base, 'wt', '.git'), `gitdir: ${join(base, 'real-git')}\n`);
		expect(readBranch(join(base, 'wt'))).toBe('main');
	});
});
