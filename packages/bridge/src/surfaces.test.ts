// THE SURFACES OF A REPO (AFB-20261127-0438): PAGES, MCP TOOLS AND API ENDPOINTS READ FROM THE FILES

// IMPORTED DEP-MODULES
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { isSupported, scanSurfaces } from './surfaces.js';

// -- FUNCTIONS -- //

describe('scanSurfaces', () => {
	const dir = mkdtempSync(join(tmpdir(), 'afb-surfaces-'));
	const put = (path: string, text: string) => {
		mkdirSync(join(dir, path, '..'), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('reads pages, server routes, MCP tools and route tables, and says when a repo is not supported', () => {
		expect(isSupported(dir)).toBe(false);
		put('svelte.config.js', 'export default {}');
		put('src/routes/+page.svelte', '<p>home</p>');
		put('src/routes/(app)/[org]/notes/+page.svelte', '<p>notes</p>');
		put('src/routes/api/health/+server.ts', 'export const GET = () => new Response("ok");');
		put(
			'src/lib/mcp/tools.ts',
			"tool('note_get', 'Read a note', {}, ro, fn);\ntool( \"step_done\", 'x')"
		);
		put('src/lib/api/routes.ts', "{ method: 'POST', path: '/orgs/{org}/notes', summary: 'x' }");
		put('node_modules/x/tools.ts', "tool('should_not_count', 'x')");
		expect(isSupported(dir)).toBe(true);
		expect(scanSurfaces(dir)).toEqual([
			{ kind: 'api', key: 'GET /api/health' },
			{ kind: 'api', key: 'POST /orgs/{org}/notes' },
			{ kind: 'mcp', key: 'note_get' },
			{ kind: 'mcp', key: 'step_done' },
			{ kind: 'route', key: '/' },
			{ kind: 'route', key: '/[org]/notes' }
		]);
	});

	it('reads a SvelteKit 3 repo, which has no svelte.config, by its @sveltejs/kit dependency', () => {
		const kit3 = mkdtempSync(join(tmpdir(), 'afb-kit3-'));
		try {
			mkdirSync(join(kit3, 'src', 'routes'), { recursive: true });
			expect(isSupported(kit3)).toBe(false);
			writeFileSync(
				join(kit3, 'package.json'),
				JSON.stringify({ devDependencies: { '@sveltejs/kit': '^3.0.0' } })
			);
			expect(isSupported(kit3)).toBe(true);
		} finally {
			rmSync(kit3, { recursive: true, force: true });
		}
	});
});
