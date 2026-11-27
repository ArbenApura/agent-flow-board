// THE SURFACES OF A REPO (AFB-20261127-0438): THE PAGES, MCP TOOLS AND API ENDPOINTS FOUND IN THE CODE, FOR THE TESTING COVERAGE VIEW
// Read from the files, never from memory, so a new page or tool shows as not covered on the next run. A SvelteKit repo is read
// for its routes (src/routes/**/+page.svelte and +server.ts), MCP tools named as tool('name', ...) and route tables that pair a
// method with a path. Any other repo answers unsupported, and the agent lists its surfaces itself.

// IMPORTED DEP-MODULES
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// -- TYPES -- //

export type Surface = { kind: 'route' | 'mcp' | 'api'; key: string };

// -- CONSTANTS -- //

const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'.svelte-kit',
	'build',
	'dist',
	'.yarn',
	'coverage'
]);
const MCP_TOOL = /\btool\(\s*['"]([a-z][a-z0-9_]{2,60})['"]/g;
const ROUTE_ROW =
	/method:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*path:\s*['"](\/[^'"]{1,200})['"]/g;
const SERVER_VERB = /export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
const MAX_FILES = 20000;

// -- FUNCTIONS -- //

function walk(dir: string, out: string[]) {
	if (out.length > MAX_FILES) return;
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const full = join(dir, name);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(full);
		} catch {
			// A broken link or a file removed while the scan runs is skipped, not a crash
			continue;
		}
		if (st.isDirectory()) walk(full, out);
		else out.push(full);
	}
}

/** A route folder as its address: groups dropped, the rest kept as written ([org] stays [org]). */
function routeOf(routesDir: string, file: string): string {
	const parts = relative(routesDir, file).split(sep).slice(0, -1);
	const kept = parts.filter((p) => !/^\(.*\)$/.test(p));
	return `/${kept.join('/')}`;
}

/** True when the folder is a SvelteKit app this command can read. */
export function isSupported(dir: string): boolean {
	return (
		existsSync(join(dir, 'src', 'routes')) &&
		(existsSync(join(dir, 'svelte.config.js')) || existsSync(join(dir, 'svelte.config.ts')))
	);
}

/** Every page, MCP tool and API endpoint of a SvelteKit repo, sorted and without repeats. */
export function scanSurfaces(dir: string): Surface[] {
	const files: string[] = [];
	walk(join(dir, 'src'), files);
	const routesDir = join(dir, 'src', 'routes');
	const seen = new Map<string, Surface>();
	const add = (s: Surface) => seen.set(`${s.kind}:${s.key}`, s);
	for (const f of files) {
		const name = f.split(sep).pop() ?? '';
		if (f.startsWith(routesDir + sep) && name === '+page.svelte')
			add({ kind: 'route', key: routeOf(routesDir, f) });
		if (!/\.(ts|js|svelte)$/.test(name)) continue;
		const text = readFileSync(f, 'utf8');
		if (f.startsWith(routesDir + sep) && name.startsWith('+server.')) {
			for (const m of text.matchAll(SERVER_VERB))
				add({ kind: 'api', key: `${m[1]} ${routeOf(routesDir, f)}` });
		}
		for (const m of text.matchAll(MCP_TOOL)) add({ kind: 'mcp', key: m[1] });
		for (const m of text.matchAll(ROUTE_ROW)) add({ kind: 'api', key: `${m[1]} ${m[2]}` });
	}
	return [...seen.values()].sort((a, b) => (a.kind + a.key).localeCompare(b.kind + b.key));
}
