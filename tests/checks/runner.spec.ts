/* eslint-disable @typescript-eslint/no-explicit-any -- API replies are parsed from JSON and read loosely in checks */
// M11: a dev-server pass does not tick a step that needs the deployed site, a preview pass on the required target does, a later fail
// reopens it, a production site is read only, a new command waits for its owner, and no stored trace, video, screenshot or log holds a
// test account password. The runner program is started for real and works against this preview, signed in as a seeded owner.
import { expect, test, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSecret } from '../../src/lib/shared/scan';
import { SEED_PASSWORD, signIn } from './helpers';
import { runRunner } from './runnerKit';

const ACME = '/api/v1/orgs/acme';
const tag = Date.now().toString(36).toUpperCase().slice(-4);
let counter = 0;
const OWNER = 'owner@acme.example';

async function setup(
	page: Page,
	base: string,
	opts: { production?: boolean; online?: boolean } = {}
) {
	const key = `RN${tag}${++counter}`;
	const ok = async (r: Awaited<ReturnType<Page['request']['get']>>) => {
		expect(r.status(), await r.text()).toBe(200);
		return r.json();
	};
	await ok(
		await page.request.post(`${ACME}/projects`, {
			data: { key, name: `Runner ${key}`, webApp: true }
		})
	);
	for (const [name, kind, production] of [
		['dev', 'dev', false],
		['preview', 'preview', false],
		['live', 'deployed', Boolean(opts.production)]
	] as const)
		await ok(
			await page.request.put(`${ACME}/projects/${key}/environments`, {
				data: { name, url: base, kind, production }
			})
		);
	await ok(
		await page.request.put(`${ACME}/projects/${key}/accounts`, {
			data: { name: 'default', email: OWNER, password: SEED_PASSWORD }
		})
	);
	const runner = await ok(
		await page.request.post(`${ACME}/runners`, {
			data: { name: `Runner ${key}`, kind: 'local', projects: [key] }
		})
	);
	const made = await ok(
		await page.request.post(`${ACME}/projects/${key}/items`, {
			data: {
				title: 'Browser check item',
				phases: [
					{
						key: '1',
						title: 'Checks',
						steps: [
							{ text: 'Run the check on the preview', requiredTarget: 'preview' },
							{ text: 'Run the check on the live site', requiredTarget: 'deployed' }
						]
					}
				],
				manualChecks: [{ key: 'M1', text: 'The organisation page opens', auto: true }]
			}
		})
	);
	// A call to the runner API is what shows a runner as online
	if (opts.online !== false) {
		const beat = await page.request.post('/api/v1/runner/claim', {
			headers: { authorization: `Bearer ${runner.token}` }
		});
		expect(beat.status(), await beat.text()).toBe(200);
	}
	return {
		key,
		token: runner.token as string,
		ref: made.ref as string,
		runnerId: runner.id as string
	};
}

const SCRIPT_PASS = `
await page.goto('/acme');
await expect(page.getByTestId('page-title')).toBeVisible();
log('the organisation page opened');
`;
const SCRIPT_FAIL = `
await page.goto('/acme');
await expect(page.getByText('this sentence is not on the page')).toBeVisible({ timeout: 1500 });
`;

const save = (page: Page, ref: string, script: string, extra: object = {}) =>
	page.request.put(`${ACME}/items/${ref}/browser-checks`, {
		data: { key: 'M1', script, requiredTarget: 'preview', ...extra }
	});
const ask = async (page: Page, ref: string, data: object) => {
	const r = await page.request.post(`${ACME}/items/${ref}/browser-checks/runs`, {
		data: { key: 'M1', ...data }
	});
	expect(r.status(), await r.text()).toBe(200);
	return r.json();
};
const view = async (page: Page, ref: string) =>
	(await page.request.get(`${ACME}/items/${ref}/browser-checks`)).json();
const plan = async (page: Page, ref: string) => {
	const it = await (await page.request.get(`${ACME}/items/${ref}`)).json();
	const steps = Object.fromEntries(
		it.phases.flatMap((p: any) => p.steps).map((s: any) => [s.key, s.state])
	);
	return { steps, m1: it.manualChecks.find((c: any) => c.key === 'M1').state as string };
};

test('M11 a preview pass closes the plan, a dev pass does not, a fail reopens, production is read only, and no stored file holds the password', async ({
	browser,
	baseURL
}) => {
	test.setTimeout(240_000);
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await signIn(page, OWNER);
	const base = baseURL!;
	const p = await setup(page, base, { production: true });
	expect((await save(page, p.ref, SCRIPT_PASS)).status()).toBe(200);

	// A dev pass for the step that needs the live site: recorded, nothing closed
	const dev = await ask(page, p.ref, { target: 'dev', step: '1.2' });
	expect(dev.unavailable, JSON.stringify(dev)).toBe(false);
	let ran = await runRunner(base, p.token, ['--trust-all']);
	expect(ran.out, ran.out).toContain('Finished.');
	let v = await view(page, p.ref);
	expect(v.checks[0].runs[0]).toMatchObject({ target: 'dev', result: 'pass' });
	expect(v.checks[0].runs[0].reason ?? '').toMatch(/weaker|already running/i);
	expect((await plan(page, p.ref)).steps['1.2']).toBe('open');

	// A preview pass closes the check and its step
	await ask(page, p.ref, { target: 'preview', step: '1.1' });
	ran = await runRunner(base, p.token, ['--trust-all']);
	expect(ran.out, ran.out).toContain('Finished.');
	v = await view(page, p.ref);
	const pass = v.checks[0].runs[0];
	expect(pass).toMatchObject({ target: 'preview', result: 'pass' });
	// The commit is the repo's HEAD when it has one; the hash of the working tree is always there
	expect(pass.commit ?? '').toMatch(/^([0-9a-f]{7,40})?$/);
	expect(pass.diffHash ?? '').toMatch(/^[0-9a-f]{40}$/);
	expect(pass.evidence.length).toBeGreaterThanOrEqual(2);
	let state = await plan(page, p.ref);
	expect(state.steps['1.1']).toBe('done');
	expect(state.m1).toBe('waived');

	// The live site is production: read only, so a write the script tries is blocked, and the pass closes the live step
	const guard = `
await page.goto('/acme');
const blocked = await page.evaluate(() => fetch('/api/v1/orgs/acme/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => false, () => true));
expect(blocked).toBe(true);
log('a write was blocked');
`;
	expect((await save(page, p.ref, guard, { requiredTarget: 'deployed' })).status()).toBe(200);
	await ask(page, p.ref, { target: 'deployed', step: '1.2' });
	ran = await runRunner(base, p.token, ['--trust-all']);
	expect(ran.out, ran.out).toContain('Finished.');
	v = await view(page, p.ref);
	expect(v.checks[0].runs[0]).toMatchObject({ target: 'deployed', result: 'pass' });
	state = await plan(page, p.ref);
	expect(state.steps['1.2']).toBe('done');

	// A later fail on the preview reopens what the preview pass closed, and the deployed pass stays
	expect((await save(page, p.ref, SCRIPT_FAIL, { requiredTarget: 'preview' })).status()).toBe(200);
	await ask(page, p.ref, { target: 'preview', step: '1.1' });
	ran = await runRunner(base, p.token, ['--trust-all']);
	expect(ran.out, ran.out).toContain('Finished.');
	v = await view(page, p.ref);
	expect(v.checks[0].runs[0]).toMatchObject({ target: 'preview', result: 'fail' });
	expect(v.checks[0].runs[0].reason).toMatch(/this sentence is not on the page|Timeout|expect/i);
	state = await plan(page, p.ref);
	expect(state.steps['1.1']).toBe('open');
	expect(state.m1).toBe('open');
	expect(state.steps['1.2']).toBe('done');

	// Nothing stored from any run holds the password: pictures, traces, videos, logs and the activity log
	const files = await (await page.request.get(`${ACME}/items/${p.ref}/attachments`)).json();
	const list = (files.attachments ?? files) as any[];
	expect(list.length).toBeGreaterThan(0);
	for (const a of list) {
		expect(a.visibility).toBe('private');
		const link = await (await page.request.get(`${ACME}/attachments/${a.id}/link`)).json();
		const bytes = await (await page.request.get(link.url)).body();
		expect(findSecret(bytes, [{ label: 'password', value: SEED_PASSWORD }]), a.filename).toBeNull();
	}
	const runs = JSON.stringify(v);
	expect(runs).not.toContain(SEED_PASSWORD);
	const events = JSON.stringify(
		await (await page.request.get(`${ACME}/projects/${p.key}/events?limit=200`)).json()
	);
	expect(events).not.toContain(SEED_PASSWORD);
	// The log of the run says what happened and nothing more
	expect(JSON.stringify(ran.out)).not.toContain(SEED_PASSWORD);
	await ctx.close();
});

test('M11 a run with no runner online says so and offers the targets that can run, never swapping silently', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await signIn(page, OWNER);
	const p = await setup(page, baseURL!, { online: false });
	expect((await save(page, p.ref, SCRIPT_PASS)).status()).toBe(200);
	const asked = await ask(page, p.ref, { target: 'preview' });
	expect(asked.unavailable).toBe(true);
	expect(asked.run.result).toBe('unavailable');
	expect(asked.run.reason).toMatch(/No runner/);
	// A viewer cannot ask for a run
	const viewer = await browser.newContext({ baseURL });
	const vp = await viewer.newPage();
	await signIn(vp, 'viewer@acme.example');
	const refused = await vp.request.post(`${ACME}/items/${p.ref}/browser-checks/runs`, {
		data: { key: 'M1' }
	});
	expect(refused.status()).toBe(403);
	// The runner appears online after it calls, and then the same ask is queued
	await runRunner(baseURL!, p.token, ['--trust-all']);
	const again = await ask(page, p.ref, { target: 'preview' });
	expect(again.unavailable).toBe(false);
	// A wrong token is refused
	const bad = await page.request.post('/api/v1/runner/claim', {
		headers: { authorization: `Bearer ${p.token}x` }
	});
	expect(bad.status()).toBe(401);
	// A personal access token is not a runner token
	const personal = await page.request.post('/api/v1/runner/claim', {
		headers: { authorization: 'Bearer afb_nonsense' }
	});
	expect(personal.status()).toBe(401);
	await viewer.close();
	await ctx.close();
});

test('M11 a local runner waits for its owner before it runs a new script, and runs it once approved', async ({
	browser,
	baseURL
}) => {
	test.setTimeout(180_000);
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await signIn(page, OWNER);
	const p = await setup(page, baseURL!);
	expect((await save(page, p.ref, SCRIPT_PASS)).status()).toBe(200);
	const state = mkdtempSync(join(tmpdir(), 'afb-approve-'));
	await ask(page, p.ref, { target: 'preview', step: '1.1' });
	const first = await runRunner(baseURL!, p.token, [], state);
	expect(first.out).toContain('Finished.');
	let v = await view(page, p.ref);
	expect(v.checks[0].runs[0].result).toBe('error');
	expect(v.checks[0].runs[0].reason).toMatch(/needs its owner's approval/);
	expect((await plan(page, p.ref)).steps['1.1']).toBe('open');
	// The owner approves what is waiting, on the machine the runner runs on
	const approve = await new Promise<string>((resolve) => {
		const child = spawn(
			process.execPath,
			['--import', 'tsx', 'packages/runner/src/cli.ts', 'approve', '--yes', '--state', state],
			{ cwd: process.cwd() }
		);
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.on('close', () => resolve(out));
	});
	expect(approve).toContain('Approved.');
	await ask(page, p.ref, { target: 'preview', step: '1.1' });
	const second = await runRunner(baseURL!, p.token, [], state);
	expect(second.out, second.out).toContain('Finished.');
	v = await view(page, p.ref);
	expect(v.checks[0].runs[0].result).toBe('pass');
	expect((await plan(page, p.ref)).steps['1.1']).toBe('done');
	// Change one character and it asks again
	expect((await save(page, p.ref, SCRIPT_PASS + '// changed\n')).status()).toBe(200);
	await ask(page, p.ref, { target: 'preview', step: '1.1' });
	await runRunner(baseURL!, p.token, [], state);
	v = await view(page, p.ref);
	expect(v.checks[0].runs[0].result).toBe('error');
	expect(v.checks[0].runs[0].reason).toMatch(/approval/);
	await ctx.close();
});
