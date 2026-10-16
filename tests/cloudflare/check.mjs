// THE WORKER CHECK: RUNS AGAINST A RUNNING WORKER (`wrangler dev` OR A DEPLOYMENT) THAT USES HYPERDRIVE, R2, QUEUES AND THE HUB OBJECT (SPEC 12, M3)
// It signs two people up, lets the first build a project, and proves that the second sees nothing of it, through the pages and REST.
//   WORKER_URL=http://localhost:8787 ADMIN_DATABASE_URL=postgres://... node tests/cloudflare/check.mjs
// ADMIN_DATABASE_URL is only used to mark the test emails as verified, because no mail is sent in this check.
import { chromium } from '@playwright/test';
import pg from 'pg';

const base = process.env.WORKER_URL ?? 'http://localhost:8787';
const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
await admin.connect();
const stamp = Date.now().toString(36);
const password = 'a long enough password 123';
const failures = [];
const check = (name, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
	if (!ok) failures.push(name);
};

const browser = await chromium.launch();

async function signedIn(label) {
	const ctx = await browser.newContext({ baseURL: base });
	const page = await ctx.newPage();
	const email = `cf-${label}-${stamp}@example.com`;
	await page.goto('/sign-up');
	await page.getByLabel('Your name').fill(`CF ${label}`);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: /create account/i }).click();
	await page.getByRole('heading', { name: 'Check your email' }).waitFor({ timeout: 20000 });
	await admin.query(`update "user" set email_verified = true where email = $1`, [email]);
	await page.goto('/sign-in');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 20000 });
	return page;
}

const a = await signedIn('a');
const slugA = `cfa${stamp}`;
await a.getByLabel('Organisation name').fill('CF Org A');
await a.getByLabel('Address').fill(slugA);
await a
	.getByRole('button', { name: /create/i })
	.last()
	.click();
await a.waitForURL(new RegExp(slugA), { timeout: 20000 });
check('organisation created through the Worker and Hyperdrive', true);

const project = await a.request.post(`/api/v1/orgs/${slugA}/projects`, {
	data: { key: 'CFP', name: 'CF project' }
});
check('project created', project.status() === 200, String(project.status()));
const item = await a.request.post(`/api/v1/orgs/${slugA}/projects/CFP/items`, {
	data: {
		title: 'Secret item of A',
		phases: [{ key: '1', title: 'Build', steps: [{ text: 'Do it' }] }]
	}
});
check('item created', item.status() === 200, String(item.status()));
const ref = (await item.json()).ref;

// A live update arrives through the project's Durable Object without a reload
await a.goto(`/${slugA}/CFP`);
await a.request.post(`/api/v1/orgs/${slugA}/projects/CFP/items`, {
	data: { title: 'Appears live on workers' }
});
const live = await a
	.getByText('Appears live on workers')
	.waitFor({ timeout: 15000 })
	.then(
		() => true,
		() => false
	);
check('live update arrives through the Durable Object', live);

// A file goes to R2 and comes back through a signed link
const up = await a.request.post(
	`/api/v1/orgs/${slugA}/items/${ref}/attachments?filename=note.txt&caption=A%20note`,
	{
		data: Buffer.from('hello r2')
	}
);
check('file stored in R2', up.status() === 200, String(up.status()));
const att = (await up.json()).attachment;
const link = await (await a.request.get(`/api/v1/orgs/${slugA}/attachments/${att.id}/link`)).json();
const got = await a.request.get(link.url);
check(
	'file read back through its signed link',
	got.status() === 200 && (await got.text()) === 'hello r2'
);

// The second person sees nothing of the first person's organisation
const b = await signedIn('b');
for (const path of [
	`/api/v1/orgs/${slugA}/projects`,
	`/api/v1/orgs/${slugA}/projects/CFP/items`,
	`/api/v1/orgs/${slugA}/items/${ref}`,
	`/api/v1/orgs/${slugA}/attachments/${att.id}/link`
]) {
	const res = await b.request.get(path);
	const text = await res.text();
	check(
		`B is refused ${path}`,
		[401, 403, 404].includes(res.status()) && !text.includes('Secret item of A'),
		String(res.status())
	);
}
// The page is a client rendered shell, so its document is always 200 and the refusal is the page that shows
await b.goto(`/${slugA}/CFP`);
await b.getByTestId('page-title').waitFor();
check(
	'B gets no project page of A',
	(await b.getByTestId('page-title').textContent()) === 'This page does not exist' &&
		!(await b.content()).includes('Secret item of A')
);
check(
	'B cannot write into A',
	(
		await b.request.post(`/api/v1/orgs/${slugA}/projects/CFP/items`, {
			data: { title: 'Planted by B' }
		})
	).status() >= 400
);
const listing = await a.request.get(`/api/v1/orgs/${slugA}/projects/CFP/items`);
check('nothing planted in A', !(await listing.text()).includes('Planted by B'));
// The link A made is a bearer link, so it also stays readable only for as long as it lives: a damaged one is refused
const damaged = await b.request.get(link.url.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')));
check('a damaged file link is refused', damaged.status() >= 400, String(damaged.status()));

await browser.close();
await admin.end();
if (failures.length) {
	console.error(`${failures.length} failed: ${failures.join('; ')}`);
	process.exit(1);
}
console.log('The Worker check passed.');
