/* eslint-disable @typescript-eslint/no-explicit-any -- API and tool replies are parsed from JSON and read loosely in checks */
// SHARED HELPERS FOR THE PRODUCT'S BROWSER CHECKS: SIGN IN, FRESH PEOPLE, THE MAIL OUTBOX AND A TINY MCP CLIENT OVER HTTP

// -- DEP-MODULES -- //
import { expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

// -- CONSTANTS -- //

export const SEED_PASSWORD = 'seed-password-for-previews';
export const PASSWORD = 'a long enough password';
const OUTBOX = '.afb/outbox.jsonl';
const tag = Date.now().toString(36);
let counter = 0;

// -- FUNCTIONS -- //

export const fresh = (prefix = 'qa') => `${prefix}-${tag}-${++counter}@example.com`;

export async function signIn(page: Page, email: string, password = SEED_PASSWORD) {
	await page.goto('/sign-in');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { name: 'Your organisations' })).toBeVisible();
}

type Mail = { to: string; subject: string; text: string };
export function mailsTo(email: string): Mail[] {
	if (!existsSync(OUTBOX)) return [];
	return readFileSync(OUTBOX, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Mail)
		.filter((m) => m.to === email);
}
export const linkOf = (m: Mail) => /(https?:\/\/\S+)/.exec(m.text)![1];

/** Signs up a brand new person through the pages and verifies the email, leaving them signed in on this page. */
export async function newPerson(page: Page, prefix = 'person') {
	const email = fresh(prefix);
	await page.goto('/sign-up');
	await page.getByLabel('Your name').fill('Fresh Person');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Create account' }).click();
	await expect(page).toHaveURL(/\/verify/);
	await page.goto(linkOf(mailsTo(email)[0]));
	await expect(page.getByRole('heading', { name: 'Your organisations' })).toBeVisible();
	return email;
}

/** A minimal MCP client over HTTP with a bearer token: one JSON-RPC call per request, like the server expects. */
export function mcp(api: APIRequestContext, token: string) {
	let id = 0;
	const rpc = async (method: string, params?: unknown): Promise<any> => {
		const res = await api.post('/mcp', {
			data: { jsonrpc: '2.0', id: ++id, method, params },
			headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' }
		});
		expect(res.status(), `MCP ${method}`).toBe(200);
		return res.json();
	};
	return {
		rpc,
		async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
			const r = await rpc('tools/call', { name, arguments: args });
			return r.result.structuredContent ?? JSON.parse(r.result.content[0].text);
		}
	};
}

export async function bearer(baseURL: string, token: string) {
	return pwRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
}

/** Answers yes to the question a final action asks first (remove, revoke, end a session). */
export async function confirmAsk(page: import('@playwright/test').Page, label: string | RegExp) {
	await page.getByRole('dialog').getByRole('button', { name: label }).click();
}
