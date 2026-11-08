import adapterNode from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// FORCE RUNES MODE FOR THE PROJECT, EXCEPT FOR LIBRARIES
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapterNode(),
			// Form posts are checked by our own origin check in hooks.server.ts, which exempts the token, device, registration, API and MCP endpoints (called by tools that send no Origin)
			csrf: { trustedOrigins: ['*'] }
		})
	],
	// TWO FIXED PORTS: 5180 IS THE DEV SERVER, 5190 IS THE LOCAL BUILD PREVIEW FOR CHECKS (THE LIVE BOARD IS THE VPS). strictPort FAILS INSTEAD OF MOVING TO ANOTHER PORT
	server: { port: 5180, strictPort: true },
	preview: { port: 5190, strictPort: true, allowedHosts: ['afb.arbenger.com'] },
	test: {
		include: [
			'src/**/*.test.ts',
			'packages/**/*.test.ts',
			'tests/unit/**/*.test.ts',
			'tests/db/**/*.test.ts',
			'tests/auth/**/*.test.ts',
			'tests/ops/**/*.test.ts',
			'tests/mcp/**/*.test.ts'
		],
		environment: 'node',
		// ONE EMBEDDED POSTGRESQL SERVER FOR THE RUN, SHARED WITH THE TEST FILES THROUGH provide AND inject
		globalSetup: ['tests/support/globalSetup.ts'],
		// A BRIDGE TEST THAT FORGETS AFB_BRIDGE_HOME GETS A THROWAWAY HOME
		setupFiles: ['tests/support/bridgeHome.ts'],
		testTimeout: 60_000,
		hookTimeout: 180_000
	}
});
