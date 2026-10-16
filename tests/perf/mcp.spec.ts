import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mcp, signIn } from '../checks/helpers';

const budgets = JSON.parse(readFileSync(resolve(import.meta.dirname, 'budgets.json'), 'utf8')) as {
	mcpToolP95Ms: number;
};

// Tool calls over /mcp stay inside the p95 budget (SPEC 12), measured end to end from a warm connection
test('MCP tool calls stay inside the p95 latency budget', async ({ page, request }) => {
	await signIn(page, 'owner@acme.example');
	const minted = await (
		await page.request.post('/api/v1/orgs/acme/tokens', {
			data: { name: 'perf check', permissions: ['read', 'write'] }
		})
	).json();
	const client = mcp(request, minted.token);
	const s = await client.call('session_start', { tool: 'perf' });
	const made = await client.call('item_new', {
		sessionId: s.sessionId,
		project: 'CKT',
		title: 'Latency probe item',
		phases: [{ key: '1', title: 'One', steps: [{ text: 'a' }] }]
	});
	const calls: [string, Record<string, unknown>][] = [
		['item_get', { item: made.ref }],
		['search', { q: 'Latency' }],
		['session_start', { tool: 'perf' }]
	];
	for (const [name, args] of calls) {
		await client.call(name, args);
		const times: number[] = [];
		for (let i = 0; i < 25; i++) {
			const t = performance.now();
			await client.call(name, args);
			times.push(performance.now() - t);
		}
		times.sort((a, b) => a - b);
		const p95 = times[Math.ceil(times.length * 0.95) - 1];
		expect(p95, `${name} p95 ms`).toBeLessThan(budgets.mcpToolP95Ms);
	}
});
