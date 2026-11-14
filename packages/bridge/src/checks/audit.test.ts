// THE AUDIT CHAIN: A TRUE CHAIN VERIFIES, AND AN EDITED MIDDLE LINE, A CUT TAIL AND A DELETED LINE ALL SHOW

// IMPORTED DEP-MODULES
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { appendAudit, verifyAudit } from './audit.js';
import { auditFile, checksHome } from './paths.js';

// -- FUNCTIONS -- //

describe('audit chain', () => {
	let home = '';
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-audit-'));
		process.env.AFB_BRIDGE_HOME = home;
		for (let i = 0; i < 4; i++) appendAudit('run', { n: i, ok: true, item: 'AFB-1' });
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});

	const lines = () => readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean);
	const write = (l: string[]) => writeFileSync(auditFile(), l.join('\n') + '\n');

	it('verifies an untouched chain', () => {
		const v = verifyAudit();
		expect(v.ok).toBe(true);
		expect(v.lines).toBe(4);
		expect(v.head).toMatch(/^[0-9a-f]{64}$/);
	});

	it('shows an edited middle line', () => {
		const l = lines();
		l[1] = (l[1] ?? '').replace('"n":1', '"n":9');
		write(l);
		expect(verifyAudit().ok).toBe(false);
	});

	it('shows a cut tail and a deleted middle line', () => {
		const l = lines();
		write(l.slice(0, 3));
		expect(verifyAudit().ok).toBe(false);
		write([l[0] ?? '', l[2] ?? '', l[3] ?? '']);
		expect(verifyAudit().ok).toBe(false);
	});

	it('keeps appending after a verify, and cleans the action and the values', () => {
		appendAudit('a very long action word!!! '.repeat(10), { text: 'x'.repeat(500), 'bad key!': 1 });
		const last = JSON.parse(lines().at(-1) ?? '{}') as {
			action: string;
			detail: Record<string, unknown>;
		};
		expect(last.action.length).toBeLessThanOrEqual(40);
		expect(String(last.detail.text).length).toBe(200);
		expect(last.detail.badkey).toBe(1);
		expect(verifyAudit().ok).toBe(true);
	});

	it('keeps the key in its own file and makes it once', () => {
		const key = join(checksHome(), 'audit.key');
		const first = readFileSync(key, 'utf8');
		appendAudit('again');
		expect(readFileSync(key, 'utf8')).toBe(first);
		if (process.platform !== 'win32') expect(statSync(key).mode & 0o777).toBe(0o600);
	});
});
