// PERFORMANCE BUDGET CHECK (SPEC 12): FIRST LOAD JAVASCRIPT (GZIP) AND SERVER RESPONSE p95 PER PAGE, AGAINST THE RUNNING BUILD PREVIEW
// USAGE: node tests/perf/run.mjs [--base http://localhost:5180] [--paths /,/healthz] [--runs 30]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const base = opt('--base', `http://localhost:${process.env.AFB_PREVIEW_PORT ?? 5180}`);
const paths = opt('--paths', '/').split(',');
const runs = Number(opt('--runs', 30));
const budgets = JSON.parse(readFileSync(resolve(import.meta.dirname, 'budgets.json'), 'utf8'));

const p95 = (xs) =>
	[...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)];
const rows = [];
let failed = false;

for (const path of paths) {
	// RESPONSE TIME, THE FIRST REQUEST IS A WARM-UP
	await fetch(base + path);
	const times = [];
	let html = '';
	for (let i = 0; i < runs; i++) {
		const t = performance.now();
		const res = await fetch(base + path);
		html = await res.text();
		times.push(performance.now() - t);
	}
	// FIRST LOAD JAVASCRIPT, EVERY SCRIPT AND MODULEPRELOAD THE PAGE ASKS FOR
	const urls = new Set([...html.matchAll(/(?:href|src)="([^"]+\.js)"/g)].map((m) => m[1]));
	for (const m of html.matchAll(/import\("([^"]+\.js)"\)/g)) urls.add(m[1]);
	for (const m of html.matchAll(/import\(\s*"([^"]+\.js)"/g)) urls.add(m[1]);
	let bytes = 0;
	for (const u of urls) {
		const res = await fetch(new URL(u, base + path));
		bytes += gzipSync(Buffer.from(await res.arrayBuffer())).length;
	}
	const kb = bytes / 1024;
	const resp = p95(times);
	const okJs = kb <= budgets.firstLoadJsGzipKb;
	const okResp = resp <= budgets.pageResponseP95Ms;
	if (!okJs || !okResp) failed = true;
	rows.push({
		path,
		'js gzip KB': kb.toFixed(1),
		budget: budgets.firstLoadJsGzipKb,
		'p95 ms': resp.toFixed(1),
		'budget ms': budgets.pageResponseP95Ms,
		result: okJs && okResp ? 'pass' : 'FAIL'
	});
}
console.table(rows);
process.exit(failed ? 1 : 0);
