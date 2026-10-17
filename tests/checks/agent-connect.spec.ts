/* eslint-disable @typescript-eslint/no-explicit-any -- API and tool replies are parsed from JSON and read loosely in checks */
// M4: an agent connects by device code, opens a session with session_start and marks a step done through MCP, two tools
// sharing one token get separate sessions, and the reply carries displayTitle. Also the OAuth consent path and the Connect page.
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { confirmAsk, mcp, signIn } from './helpers';

const ORG = '/api/v1/orgs/acme';

test('M4 a tool connects by device code, works through MCP, and two tools get separate sessions', async ({
	page,
	request
}) => {
	await signIn(page, 'member@acme.example');
	// The tool starts a device sign in and shows its code
	const dev = await (
		await request.post('/oauth/device/code', { data: { client_name: 'Gemini CLI' } })
	).json();
	expect(dev.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
	expect(dev.verification_uri).toContain('/device');
	// Until it is approved the tool is told to wait
	const pending = await request.post('/oauth/token', {
		form: {
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			device_code: dev.device_code
		}
	});
	expect((await pending.json()).error).toBe('authorization_pending');
	// The person types the code on the approval page (it is never pre filled) and approves
	await page.goto(`/device?code=${dev.user_code}`);
	await expect(page.getByLabel('Code from your tool')).toHaveValue('');
	await page.getByLabel('Code from your tool').fill(dev.user_code);
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByTestId('device-info')).toContainText('Gemini CLI');
	await page.getByRole('button', { name: 'Approve' }).click();
	await expect(page.getByTestId('device-done')).toContainText('is connected');
	// The tool now receives one token, and only once
	const granted = await request.post('/oauth/token', {
		form: {
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			device_code: dev.device_code
		}
	});
	const token = (await granted.json()).access_token as string;
	expect(token).toMatch(/^afb_/);
	expect(
		(
			await (
				await request.post('/oauth/token', {
					form: {
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
						device_code: dev.device_code
					}
				})
			).json()
		).error
	).toBe('invalid_grant');

	// It talks MCP: two tools share this token and each gets its own session
	const client = mcp(request, token);
	const hello = await client.rpc('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'gemini', version: '1' }
	});
	expect(hello.result.instructions).toContain('session_start');
	const a = await client.call('session_start', { tool: 'gemini-cli' });
	const b = await client.call('session_start', { tool: 'antigravity' });
	expect(a.sessionId).toMatch(/^s_/);
	expect(a.sessionId).not.toBe(b.sessionId);
	const made = await client.call('item_new', {
		sessionId: a.sessionId,
		project: 'CKT',
		title: 'Agent connect check item',
		tabName: 'AGENT_CONNECT',
		phases: [{ key: '1', title: 'One', steps: [{ text: 'First' }, { text: 'Second' }] }]
	});
	const claimed = await client.call('work_start', { sessionId: a.sessionId, item: made.ref });
	expect(claimed.displayTitle).toBe(`AGENT_CONNECT: ${made.ref}`);
	const done = await client.call('step_done', { sessionId: a.sessionId, keys: ['1.1'] });
	expect(done.changed).toEqual([{ key: '1.1', from: 'open', to: 'done' }]);
	expect(done.statusChanges).toEqual([{ from: 'PLANNED', to: 'IN PROGRESS', note: 'Automatic' }]);
	// The other session never claimed anything, so a claim-less write says what to do instead of guessing
	const lost = await client.call('step_done', { sessionId: b.sessionId, keys: ['1.2'] });
	expect(lost.error.message).toContain('Name an item');
	// A session id that was never issued is refused
	expect(
		(await client.call('step_done', { sessionId: 's_madeup', item: made.ref, keys: ['1.2'] })).error
			.details.needsSession
	).toBe(true);
	// The event log shows the tool that did it
	const events = await (
		await page.request.get(`${ORG}/projects/CKT/events`, { params: { item: made.ref } })
	).json();
	expect(events.some((e: any) => e.tool === 'gemini-cli' && e.verb === 'step.update')).toBe(true);
});

test('M4 OAuth with PKCE: the consent screen shows an unverified tool and its redirect host, approval returns a code, a token works', async ({
	page,
	request
}) => {
	await signIn(page, 'member@acme.example');
	const redirect = 'http://127.0.0.1:33418/callback';
	const reg = await (
		await request.post('/oauth/register', {
			data: { client_name: 'Consent Check Tool', redirect_uris: [redirect] }
		})
	).json();
	expect(reg.client_id).toMatch(/^afbc_/);
	expect(
		(
			await request.post('/oauth/register', {
				data: { client_name: 'Evil', redirect_uris: ['http://evil.example/cb'] }
			})
		).status()
	).toBe(400);
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	const authorize = (extra: Record<string, string> = {}) =>
		`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'abc123', scope: 'read write', ...extra })}`;

	// A request with a redirect address the tool never registered is an error here, never a redirect
	await page.goto(authorize({ redirect_uri: 'http://127.0.0.1:1/other' }));
	await expect(page.getByTestId('oauth-problem')).toContainText('does not match');
	expect(page.url()).toContain('/oauth/authorize');

	await page.goto(authorize());
	await expect(page.getByText('Unverified')).toBeVisible();
	await expect(page.getByText('127.0.0.1:33418')).toBeVisible();
	// The tool's address is not reachable here, so the answer is read from the 303 the server sends
	const approved = page.waitForResponse((r) => r.url().includes('/oauth/authorize/decision'));
	await page.getByRole('button', { name: 'Connect Consent Check Tool' }).click();
	const location = (await approved).headers()['location'];
	expect(location).toContain(redirect);
	const back = new URL(location);
	expect(back.searchParams.get('state')).toBe('abc123');
	const code = back.searchParams.get('code')!;
	const wrong = await request.post('/oauth/token', {
		form: {
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirect,
			code_verifier: randomBytes(32).toString('base64url'),
			client_id: reg.client_id
		}
	});
	expect((await wrong.json()).error).toBe('invalid_grant');
	// The wrong verifier burned the code? No: only a used code is burned, so the right verifier still works once
	const ok = await request.post('/oauth/token', {
		form: {
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirect,
			code_verifier: verifier,
			client_id: reg.client_id
		}
	});
	const tokens = await ok.json();
	expect(tokens.token_type).toBe('Bearer');
	expect(tokens.expires_in).toBe(3600);
	const client = mcp(request, tokens.access_token);
	const s = await client.call('session_start', { tool: 'consent-tool' });
	expect(s.sessionId).toMatch(/^s_/);
	// Refreshing swaps the pair, and the old access token stops
	const refreshed = await (
		await request.post('/oauth/token', {
			form: {
				grant_type: 'refresh_token',
				refresh_token: tokens.refresh_token,
				client_id: reg.client_id
			}
		})
	).json();
	expect(refreshed.access_token).not.toBe(tokens.access_token);
	expect(
		(
			await request.post('/mcp', {
				data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
				headers: { authorization: `Bearer ${tokens.access_token}` }
			})
		).status()
	).toBe(401);

	// Cancelling returns access_denied with the tool's own state
	await page.goto(authorize());
	const denied = page.waitForResponse((r) => r.url().includes('/oauth/authorize/decision'));
	await page.getByRole('button', { name: 'Cancel' }).click();
	const back2 = new URL((await denied).headers()['location']);
	expect(back2.searchParams.get('error')).toBe('access_denied');
	expect(back2.searchParams.get('state')).toBe('abc123');
});

test('M4 a request with no token gets the OAuth discovery hint', async ({ request }) => {
	const res = await request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
	expect(res.status()).toBe(401);
	expect(res.headers()['www-authenticate']).toContain('/.well-known/oauth-protected-resource');
	const meta = await (await request.get('/.well-known/oauth-authorization-server')).json();
	expect(meta.code_challenge_methods_supported).toEqual(['S256']);
	expect(meta.registration_endpoint).toContain('/oauth/register');
});

test('M4 the Connect page shows a snippet per tool, makes a token that is shown once, lists it and revokes it at once', async ({
	page,
	request
}) => {
	await signIn(page, 'member@acme.example');
	await page.goto('/connect');
	await expect(page.getByTestId('snippet-code')).toContainText('claude mcp add --transport http');
	for (const tool of ['VS Code', 'Antigravity', 'Any other tool', 'Claude chat']) {
		await page.getByRole('tab', { name: tool }).click();
		await expect(page.getByTestId('snippet-code')).toContainText(/\/mcp|@agent-flow-board\/bridge/);
	}
	await page.getByLabel('What is it for?').fill('Connect page token');
	await page.getByRole('button', { name: 'Create token' }).click();
	const token = (await page.getByTestId('token-value').innerText()).trim();
	expect(token).toMatch(/^afb_/);
	await expect(page.getByTestId('connected-apps')).toContainText('Connect page token');
	// It works now, and is not shown again after a reload
	const client = mcp(request, token);
	expect((await client.call('session_start', { tool: 'page-token' })).sessionId).toMatch(/^s_/);
	await page.reload();
	await expect(page.getByTestId('token-created')).toHaveCount(0);
	await page
		.getByTestId('connected-apps')
		.locator('li', { hasText: 'Connect page token' })
		.getByRole('button', { name: 'Revoke' })
		.click();
	await confirmAsk(page, 'Revoke');
	await expect(page.getByTestId('connected-apps')).not.toContainText('Connect page token');
	expect(
		(
			await request.post('/mcp', {
				data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
				headers: { authorization: `Bearer ${token}` }
			})
		).status()
	).toBe(401);
});
