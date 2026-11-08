// THE UPDATE LINE FOR AN OLDER EDITOR STATUS MOD (AFB-20261108-0856): THE COMPARE AND WHAT A START EVENT ANSWERS
// The compare is checked on its own, then through the real hook handler with real rows. Each case that stays quiet sits next to one that speaks.

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { modVersion } from '../../src/lib/server/editor-status';
import { isOlder, updateNotice } from '../../src/lib/server/editor-status/version';
import { handleHook } from '../../src/lib/server/ops/hooks';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('the version compare', () => {
	it('speaks only when the installed mod is older than the served one', () => {
		expect(isOlder('0.1.0', '0.1.1')).toBe(true);
		expect(isOlder('0.9.9', '1.0.0')).toBe(true);
		expect(isOlder('0.1.9', '0.1.10')).toBe(true);
		// Equal, newer and unknown say nothing
		expect(isOlder('0.1.1', '0.1.1')).toBe(false);
		expect(isOlder('0.2.0', '0.1.1')).toBe(false);
		expect(isOlder('1.0.0', '0.9.9')).toBe(false);
		expect(isOlder(undefined, '0.1.1')).toBe(false);
		// Anything that is not a plain version is ignored, never compared
		for (const odd of [
			'',
			'latest',
			'0.1',
			'0.1.0-beta',
			'^0.1.0',
			'1.2.3.4',
			'0.1.0 ',
			'9999999.0.0'
		])
			expect(isOlder(odd, '0.1.1'), odd).toBe(false);
		expect(isOlder('0.1.0', 'dev')).toBe(false);
	});

	it('writes one constant line with the two versions and nothing else', () => {
		expect(updateNotice('0.1.0', '0.1.1')).toBe(
			'Agent Flow Board editor status: mod 0.1.1 is available (you have 0.1.0). Re-run the setup prompt from Connect a tool.'
		);
		expect(updateNotice('0.1.1', '0.1.1')).toBeNull();
		expect(updateNotice('<b>0.1.0</b>', '0.1.1')).toBeNull();
	});

	it('serves a real version, so the compare has something to hold against', () => {
		expect(modVersion()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe('the start event', () => {
	let db: TestDb;
	let w: World;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	});
	afterAll(async () => {
		await db.close();
	});

	const start = (
		over: { tool?: 'claude-code' | 'gemini'; event?: 'start' | 'prompt'; modVersion?: string },
		id: string
	) =>
		handleHook(w.ctx('member'), {
			tool: over.tool ?? 'claude-code',
			event: over.event ?? 'start',
			externalId: id,
			...(over.modVersion !== undefined ? { modVersion: over.modVersion } : {})
		});

	it('carries the notice for an older mod and not for a current, missing or odd one', async () => {
		const served = modVersion();
		const older = await start({ modVersion: '0.0.1' }, 'conversation-notice-0001');
		expect(older.notice).toContain(`mod ${served} is available (you have 0.0.1)`);
		expect(
			(await start({ modVersion: served }, 'conversation-notice-0002')).notice
		).toBeUndefined();
		expect((await start({}, 'conversation-notice-0003')).notice).toBeUndefined();
		expect(
			(await start({ modVersion: 'x'.repeat(20) }, 'conversation-notice-0004')).notice
		).toBeUndefined();
	});

	it('says it at a start only, and only to Claude Code', async () => {
		expect(
			(await start({ event: 'prompt', modVersion: '0.0.1' }, 'conversation-notice-0005')).notice
		).toBeUndefined();
		expect(
			(await start({ tool: 'gemini', modVersion: '0.0.1' }, 'conversation-notice-0006')).notice
		).toBeUndefined();
	});
});
