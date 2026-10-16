/* eslint-disable @typescript-eslint/no-explicit-any -- API replies are parsed from JSON and read loosely in checks */
// M17: a done step moves PLANNED to IN PROGRESS and the last one to IN REVIEW with "Automatic" history, a reopened step
// leaves IN REVIEW, a log-only call moves nothing, and an agent's COMPLETED is refused where the project keeps it for
// people. Runs against the build preview as a person (session cookie) and as an agent (personal access token).
import {
	expect,
	request as pwRequest,
	test,
	type APIRequestContext,
	type Browser,
	type Page
} from '@playwright/test';

const ORG = '/api/v1/orgs/acme';
const PASSWORD = 'seed-password-for-previews';

async function signIn(page: Page, email: string) {
	await page.goto('/sign-in');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { name: 'Your organisations' })).toBeVisible();
}

type Json = Record<string, any>;
const json = async (res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<Json> =>
	res.json();

test('M17 status follows the work, over REST as a person and as an agent', async ({
	page,
	baseURL,
	browser
}) => {
	// A person signs in and mints a token for an agent
	await signIn(page, 'member@acme.example');
	const minted = await json(
		await page.request.post(`${ORG}/tokens`, {
			data: { name: 'claude-code', permissions: ['read', 'write', 'complete'] }
		})
	);
	expect(minted.token).toMatch(/^afb_/);
	const agent = await pwRequest.newContext({
		baseURL,
		extraHTTPHeaders: { authorization: `Bearer ${minted.token}` }
	});
	const person = page.request;

	const created = await json(
		await agent.post(`${ORG}/projects/CKT/items`, {
			data: {
				title: 'Status check item',
				phases: [
					{ key: '1', title: 'Build', steps: [{ text: 'First' }, { text: 'Second' }] },
					{ key: '2', title: 'Ship', steps: [{ text: 'Third' }] }
				],
				manualChecks: [{ key: 'M1', text: 'Checked by hand' }]
			}
		})
	);
	const ref: string = created.ref;
	const record = async (who: APIRequestContext, body: Json) =>
		json(await who.post(`${ORG}/items/${ref}/record`, { data: body }));
	const read = async () => json(await person.get(`${ORG}/items/${ref}`));

	// A log line alone moves nothing
	expect((await record(agent, { marks: [], log: 'Looking around' })).statusChanges).toEqual([]);
	expect((await read()).item.status).toBe('PLANNED');

	// The first done step moves PLANNED to IN PROGRESS
	const first = await record(agent, { marks: [{ key: '1.1', mark: 'done' }] });
	expect(first.statusChanges).toEqual([{ from: 'PLANNED', to: 'IN PROGRESS', note: 'Automatic' }]);
	// A manual check never moves a status
	expect(
		(await record(agent, { marks: [{ key: 'M1', mark: 'waived', reason: 'Closed by Arben' }] }))
			.statusChanges
	).toEqual([]);
	// The last counted step moves it to IN REVIEW
	await record(agent, { marks: [{ key: '1.2', mark: 'done' }] });
	const last = await record(agent, { marks: [{ key: '2.1', mark: 'done' }] });
	expect(last.statusChanges).toEqual([{ from: 'IN PROGRESS', to: 'IN REVIEW', note: 'Automatic' }]);
	expect(last.percent).toBe(100);
	expect(last.phaseComplete).toBe(true);

	// Reopening a step leaves it in IN REVIEW, and the drift warning says so
	const reopened = await record(agent, { marks: [{ key: '2.1', mark: 'open' }] });
	expect(reopened.statusChanges).toEqual([]);
	let d = await read();
	expect(d.item.status).toBe('IN REVIEW');
	expect(d.item.health.drift).toContain('in-review-with-open-steps');

	// The history carries the Automatic notes
	const events = (await json(
		await person.get(`${ORG}/projects/CKT/events`, { params: { item: ref, limit: '100' } })
	)) as unknown as Json[];
	const moves = events.filter((e) => e.verb === 'item.status').map((e) => e.after.note);
	expect(moves).toEqual(['Automatic', 'Automatic'].slice(0, moves.length));
	expect(moves).toHaveLength(2);

	// COMPLETED is refused while a counted step is open
	const early = await agent.post(`${ORG}/items/${ref}/status`, {
		data: { status: 'COMPLETED', note: 'Too early to close' }
	});
	expect(early.status()).toBe(409);
	expect((await json(early)).error.details.reason).toBe('open-steps');
	await record(agent, { marks: [{ key: '2.1', mark: 'done' }] });

	// Where the project keeps COMPLETED for people, an agent is refused and a person may close it
	await signInOwnerAndSetSwitch(browser, baseURL!, false);
	const refused = await agent.post(`${ORG}/items/${ref}/status`, {
		data: { status: 'COMPLETED', note: 'An agent closes it' }
	});
	expect(refused.status()).toBe(409);
	expect((await json(refused)).error.details.reason).toBe('people-only');
	const closed = await person.post(`${ORG}/items/${ref}/status`, {
		data: { status: 'COMPLETED', note: 'A person closes it' }
	});
	expect(closed.status()).toBe(200);
	d = await read();
	expect(d.item.status).toBe('COMPLETED');
	await signInOwnerAndSetSwitch(browser, baseURL!, true);
	await agent.dispose();
});

test('a repeated request id returns the stored result over REST', async ({ page }) => {
	await signIn(page, 'member@acme.example');
	const created = await json(
		await page.request.post(`${ORG}/projects/CKT/items`, {
			data: {
				title: 'Replay check item',
				phases: [{ key: '1', title: 'One', steps: [{ text: 'Only' }] }]
			}
		})
	);
	const call = () =>
		page.request.post(`${ORG}/items/${created.ref}/record`, {
			data: { marks: [{ key: '1.1', mark: 'done' }] },
			headers: { 'idempotency-key': 'replay-check-0001' }
		});
	const a = await json(await call());
	const b = await json(await call());
	expect(b).toEqual(a);
	expect(a.statusChanges.map((c: Json) => c.to)).toEqual(['IN PROGRESS', 'IN REVIEW']);
	const events = (await json(
		await page.request.get(`${ORG}/projects/CKT/events`, {
			params: { item: created.ref, limit: '100' }
		})
	)) as unknown as Json[];
	expect(events.filter((e) => e.verb === 'step.update')).toHaveLength(1);
});

test('another org and an unknown person get 404 and 401, never data', async ({ page, baseURL }) => {
	await signIn(page, 'member@acme.example');
	expect((await page.request.get('/api/v1/orgs/lumora/projects')).status()).toBe(404);
	const anonymous = await pwRequest.newContext({ baseURL });
	expect((await anonymous.get(`${ORG}/projects`)).status()).toBe(401);
	expect((await anonymous.get('/api/v1/openapi.json')).status()).toBe(200);
	await anonymous.dispose();
});

/** Signs in as the seed owner in its own browser context and sets the project's "agents may set COMPLETED" switch. */
async function signInOwnerAndSetSwitch(browser: Browser, baseURL: string, on: boolean) {
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	const res = await page.request.patch(`${ORG}/projects/CKT`, { data: { agentsMayComplete: on } });
	expect(res.status()).toBe(200);
	await ctx.close();
}
