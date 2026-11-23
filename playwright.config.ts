import { defineConfig } from '@playwright/test';

// THE BROWSER TESTS RUN AGAINST THE BUILD PREVIEW ON PORT 7174, NEVER THE DEV SERVER (ADR-017)
const port = Number(process.env.AFB_PREVIEW_PORT ?? 7174);

export default defineConfig({
	testDir: 'tests',
	testMatch: ['checks/**/*.spec.ts', 'perf/**/*.spec.ts'],
	timeout: 60_000,
	fullyParallel: false,
	workers: 1,
	reporter: [['list'], ['json', { outputFile: '.afb/results/latest.json' }]],
	use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
	webServer: [
		{
			command: `node tests/runner/preview.mjs --port ${port}`,
			url: `http://localhost:${port}/healthz`,
			reuseExistingServer: true,
			timeout: 240_000
		}
	]
});
