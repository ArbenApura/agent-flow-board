// BUILD PREVIEW RUNNER (ADR-017): BUILD ONLY WHEN THE APP CHANGED, THEN SERVE WITH vite preview, NEVER THE DEV SERVER
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startDatabase } from './database.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const stateDir = resolve(root, '.afb');
const stateFile = resolve(stateDir, 'build-hash.json');
// APP PATHS THAT CHANGE WHAT THE BUILD CONTAINS
const appPaths = ['src', 'static', 'package.json', 'yarn.lock', 'vite.config.ts', 'tsconfig.json'];

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || process.env.AFB_PREVIEW_PORT || 5180);
const force = args.includes('--force');
const buildOnly = args.includes('--build-only');

const vite = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });

/** Hash of HEAD plus the content of every uncommitted change in the app paths. */
export function appHash() {
	const h = createHash('sha1');
	const head = git('rev-parse', 'HEAD');
	h.update(head.status === 0 ? head.stdout.trim() : 'no-commit');
	h.update(git('diff', 'HEAD', '--no-color', '--', ...appPaths).stdout ?? '');
	const untracked = git('ls-files', '--others', '--exclude-standard', '--', ...appPaths)
		.stdout.split('\n')
		.filter(Boolean);
	for (const f of untracked.sort()) {
		h.update(f);
		try {
			h.update(readFileSync(resolve(root, f)));
		} catch {
			h.update('unreadable');
		}
	}
	// A repo with no commit has no HEAD diff, so hash tracked-in-index files too
	if (head.status !== 0) {
		for (const f of git('ls-files', '--', ...appPaths)
			.stdout.split('\n')
			.filter(Boolean)
			.sort()) {
			try {
				h.update(f + readFileSync(resolve(root, f)));
			} catch {
				h.update(f);
			}
		}
	}
	return h.digest('hex');
}

function build() {
	const hash = appHash();
	const built = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
	if (!force && built?.hash === hash && existsSync(resolve(root, 'build'))) {
		console.log(`[preview] reusing the build (${hash.slice(0, 8)})`);
		return;
	}
	console.log(`[preview] building (${hash.slice(0, 8)})`);
	const r = spawnSync(process.execPath, [vite, 'build', '--mode', 'test'], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 1 << 28
	});
	if (r.status !== 0) {
		const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
		console.error(`[preview] BUILD FAILED, refusing to run checks.\n${tail}`);
		process.exit(1);
	}
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(stateFile, JSON.stringify({ hash, at: new Date().toISOString() }));
}

build();
if (!buildOnly) {
	// The app needs a PostgreSQL, so the preview starts a throwaway one of its own and stops it when the preview ends
	console.log('[preview] starting a throwaway PostgreSQL');
	const database = await startDatabase();
	console.log(`[preview] serving on http://localhost:${port}`);
	const child = spawn(
		process.execPath,
		[vite, 'preview', '--mode', 'test', '--port', String(port), '--strictPort'],
		{
			cwd: root,
			stdio: 'inherit',
			// The gallery is served only on the preview, never in a deployment
			// DATABASE_OWNER_URL is pinned too, so a value from .env can never send the migration to a database that holds real data
			env: {
				...process.env,
				AFB_ENABLE_GALLERY: '1',
				DATABASE_URL: database.url,
				DATABASE_OWNER_URL: database.url
			}
		}
	);
	const stop = () => child.kill();
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
	child.on('exit', async (code) => {
		await database.stop();
		process.exit(code ?? 0);
	});
}
