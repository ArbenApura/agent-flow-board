// UI SHOTS (ADR-032): THE PRODUCT'S OWN SHOTS MODE, RUN OVER THIS REPO'S "UI changes" TABLE ON THE BUILD PREVIEW
// It opens each row's pages read only (every write is aborted), measures the levels against tests/ui-shots/scale.json and the sibling
// pages, and writes JPEG pictures plus index.json to .afb/ui-shots/<run>/. The same collecting code runs for a run asked for on a
// board (packages/runner/src/collect.ts); only where the rows come from and where the pictures go differ.
// USAGE: yarn run ui-shots [--rows tests/ui-shots/ui-changes.md] [--base http://localhost:5180] [--only /sign-in] [--no-server]

// -- DEP-MODULES -- //
import { chromium } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
// -- MODULES -- //
import { Shooter, type Row, type ShotResult } from '../../packages/runner/src/collect';
import { loadConfig } from '../../packages/runner/src/config';
import {
	flagsForPage,
	parseUiChangesTable,
	validateUiChange,
	type Flag,
	type MeasuredLevels,
	type ScaleLevels
} from '../../src/lib/shared/uiShots';

// -- CONSTANTS -- //

const root = resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const port = Number(process.env.AFB_PREVIEW_PORT ?? 5180);
const base = opt('--base', `http://localhost:${port}`);
const rowsFile = resolve(root, opt('--rows', 'tests/ui-shots/ui-changes.md'));
const only = opt('--only', '');
// The seeded people of the preview database (src/lib/server/db/seed.ts), all sharing one public preview password
const SEED_PASSWORD = 'seed-password-for-previews';
const ACCOUNTS = Object.fromEntries(
	[
		['seed owner', 'owner@acme.example'],
		['seed admin', 'admin@acme.example'],
		['seed member', 'member@acme.example'],
		['seed viewer', 'viewer@acme.example']
	].map(([name, email]) => [name, { email, password: SEED_PASSWORD }])
);

// -- FUNCTIONS -- //

let server: ChildProcess | null = null;
async function ensureServer() {
	if (args.includes('--no-server')) return;
	try {
		if ((await fetch(base + '/healthz')).ok) return;
	} catch {
		/* Not running yet */
	}
	server = spawn(
		process.execPath,
		[resolve(root, 'tests/runner/preview.mjs'), '--port', String(port)],
		{
			cwd: root,
			stdio: 'ignore'
		}
	);
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(base + '/healthz')).ok) return;
		} catch {
			/* Still building */
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error('The build preview did not start.');
}

/** tests/ui-shots/scale.json as the scale the shared flag code reads: one entry per level for a width. */
function scaleFor(viewport: number): ScaleLevels {
	const file = JSON.parse(readFileSync(resolve(root, 'tests/ui-shots/scale.json'), 'utf8')) as {
		levels: Record<string, Record<'desktop' | 'phone', Record<string, number | number[]>>>;
	};
	const out: ScaleLevels = {};
	for (const [level, widths] of Object.entries(file.levels)) {
		const entry = { ...widths[viewport >= 1000 ? 'desktop' : 'phone'] };
		delete entry.fontWeight;
		out[level] = entry;
	}
	return out;
}

async function main() {
	const markdown = readFileSync(rowsFile, 'utf8');
	let rows = parseUiChangesTable(markdown, { lenient: true });
	// A row whose only siblings are mockup files for the human reader has none to measure against, and is still shot
	rows.forEach((r) => validateUiChange(r, { allowNoSiblings: true, allowMockups: true }));
	if (only) rows = rows.filter((r) => r.page === only);
	const runId = new Date().toISOString().replace(/[:.]/g, '-');
	const outDir = resolve(root, '.afb', 'ui-shots', runId);
	mkdirSync(outDir, { recursive: true });
	await ensureServer();
	const browser = await chromium.launch();
	let n = 0;
	const shooter = new Shooter({
		browser,
		config: loadConfig(root),
		afterUrl: base,
		beforeUrl: null,
		accounts: ACCOUNTS,
		// A mockup named beside the app's own pages opens from the repo, as it did before the product had a shots mode
		resolvePage: (page) =>
			page.endsWith('.html')
				? 'file:///' + resolve(root, page).replaceAll(String.fromCharCode(92), '/')
				: null,
		log: (l) => console.log(l),
		store: async ({ filename, bytes }) => {
			const file = `${String(++n).padStart(3, '0')}-${filename}`;
			writeFileSync(resolve(outDir, file), bytes);
			return file;
		}
	});
	const results: (ShotResult & { flags?: Flag[]; error?: string })[] = [];
	for (const [i, r] of rows.entries()) {
		const row: Row = { ...r, id: String(i) };
		try {
			const got = await shooter.rows([row]);
			for (const x of got) {
				if (x.side !== 'after') {
					results.push(x);
					continue;
				}
				const sibs = got
					.filter((y) => y.side === 'sibling' && y.theme === x.theme && y.viewport === x.viewport)
					.map((y) => y.values as MeasuredLevels);
				results.push({
					...x,
					flags: flagsForPage(row.levels, x.values, sibs, scaleFor(x.viewport))
				});
			}
		} catch (e) {
			results.push({
				page: r.page,
				state: r.stateRecipe,
				theme: r.themes.join(','),
				viewport: r.viewports[0],
				side: 'after',
				values: {},
				error: String((e as Error).message ?? e).split('\n')[0]
			});
		}
	}
	await browser.close();
	server?.kill();
	const afters = results.filter((x) => x.side === 'after');
	const flagged = afters.filter((x) => x.flags?.length);
	const errors = afters.filter((x) => x.error);
	writeFileSync(
		resolve(outDir, 'index.json'),
		JSON.stringify({ runId, rowsFile, abortedWrites: shooter.aborted.writes, results }, null, 2)
	);
	const flags = flagged.reduce((k, x) => k + (x.flags?.length ?? 0), 0);
	console.log(
		`UI shots run ${runId}: ${afters.length} results, ${flags} to-fix flags, ${errors.length} errors`
	);
	for (const x of flagged)
		for (const f of x.flags ?? [])
			console.log(`  to fix: ${x.page} ${x.theme} ${x.viewport}: ${f.text}`);
	for (const x of errors) console.log(`  error: ${x.page} ${x.theme} ${x.viewport}: ${x.error}`);
	console.log(`INDEX ${resolve(outDir, 'index.json')}`);
	process.exit(flags || errors.length ? 1 : 0);
}

main().catch((e) => {
	server?.kill();
	console.error(e);
	process.exit(1);
});
