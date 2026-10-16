import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import adapterNode from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// ADAPTER IS CHOSEN BY AFB_ADAPTER: "node" (DEFAULT, VPS AND DOCKER) OR "cloudflare" (WORKERS)
const adapter =
	process.env.AFB_ADAPTER === 'cloudflare'
		? adapterCloudflare({ config: 'wrangler.adapter.jsonc' })
		: adapterNode();

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// FORCE RUNES MODE FOR THE PROJECT, EXCEPT FOR LIBRARIES
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter,
			// Form posts are checked by our own origin check in hooks.server.ts, which exempts the token, device, registration, API and MCP endpoints (called by tools that send no Origin)
			csrf: { trustedOrigins: ['*'] }
		})
	],
	test: {
		include: [
			'src/**/*.test.ts',
			'packages/**/*.test.ts',
			'importer/**/*.test.ts',
			'tests/unit/**/*.test.ts',
			'tests/db/**/*.test.ts',
			'tests/auth/**/*.test.ts',
			'tests/ops/**/*.test.ts',
			'tests/mcp/**/*.test.ts'
		],
		environment: 'node',
		testTimeout: 60_000,
		hookTimeout: 180_000
	}
});
