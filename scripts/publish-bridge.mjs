// PUBLISH THE BRIDGE TO NPM: yarn publish:bridge [--dry-run] [--allow-dirty]
// Builds dist, checks that the version is new and that the tarball holds only dist, the README, the licence and package.json, then runs `npm publish`
// in an interactive terminal (npm asks you to approve with your passkey or one time code), and waits until the registry shows the new version.
// npm is used for the publish only: it holds your npm sign in (yarn npm has none configured here). Nothing is committed or pushed by this script.

// IMPORTED DEP-MODULES
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// -- CONSTANTS -- //

const ROOT = process.cwd();
const PKG_DIR = join(ROOT, 'packages', 'bridge');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const allowDirty = args.includes('--allow-dirty');
const ALLOWED = /^(dist\/.+|README\.md|LICENSE|package\.json)$/;
const WAIT_MS = 5 * 60_000;

// -- FUNCTIONS -- //

const say = (line) => process.stdout.write(`${line}\n`);
const fail = (line) => {
	process.stderr.write(`${line}\n`);
	process.exit(1);
};
/** Runs a program in a folder and returns its exit status and output. shell:true so yarn.cmd and npm.cmd work on Windows. */
const run = (command, argv, { cwd = ROOT, inherit = false } = {}) =>
	spawnSync(command, argv, {
		cwd,
		shell: true,
		encoding: 'utf8',
		stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
	});

const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
say(`Publishing ${pkg.name}@${pkg.version}${dryRun ? ' (dry run)' : ''}.`);

// -- 1. THE VERSION MUST BE NEW -- //
const seen = run('npm', ['view', pkg.name, 'versions', '--json']);
if (seen.status === 0) {
	let versions = [];
	try {
		const parsed = JSON.parse(seen.stdout);
		versions = Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		fail('Could not read the published versions from npm.');
	}
	if (versions.includes(pkg.version))
		fail(
			`${pkg.name}@${pkg.version} is already on npm. Bump "version" in packages/bridge/package.json first.`
		);
} else if (!/E404/.test(seen.stderr)) fail(`npm view failed: ${seen.stderr.trim().slice(0, 300)}`);

// -- 2. THE SOURCE MUST BE COMMITTED, SO THE PACKAGE MATCHES GIT -- //
const dirty = run('git', ['status', '--porcelain', '--', 'packages/bridge']).stdout.trim();
if (dirty && !allowDirty)
	fail(
		`packages/bridge has uncommitted changes. Commit them first (or pass --allow-dirty):\n${dirty.split('\n').slice(0, 10).join('\n')}`
	);

// -- 3. BUILD -- //
say('Building dist...');
if (run('yarn', ['tsc', '-p', 'packages/bridge/tsconfig.json'], { inherit: true }).status !== 0)
	fail('The build failed.');
const rebuilt = run('git', ['status', '--porcelain', '--', 'packages/bridge/dist']).stdout.trim();
if (rebuilt && !allowDirty)
	fail(
		`The build changed dist, so the committed dist is out of date. Commit it, then publish again:\n${rebuilt.split('\n').slice(0, 10).join('\n')}`
	);

// -- 4. THE TARBALL HOLDS ONLY WHAT IT SHOULD -- //
const packed = run('yarn', ['pack', '--dry-run'], { cwd: PKG_DIR });
if (packed.status !== 0) fail(`yarn pack failed: ${packed.stderr.trim().slice(0, 300)}`);
const files = [...packed.stdout.matchAll(/YN0000: (\S+)\s*$/gm)]
	.map((m) => m[1])
	.filter((f) => !/^Done$/.test(f));
const stray = files.filter((f) => !ALLOWED.test(f));
if (stray.length) fail(`The package would include files it should not:\n${stray.join('\n')}`);
if (!files.some((f) => f === 'dist/cli.js') || !files.some((f) => f.endsWith('mailguard-hook.cjs')))
	fail('The package is missing dist/cli.js or the mail guard hook. Build again.');
say(`The package holds ${files.length} files (dist, README, LICENSE, package.json).`);

// -- 5. PUBLISH: INTERACTIVE, SO NPM CAN ASK FOR YOUR PASSKEY -- //
if (!process.stdin.isTTY && !dryRun)
	fail(
		'Run this in an interactive terminal: npm opens a browser or asks for a code to approve the publish.'
	);
const published = run('npm', ['publish', '--access', 'public', ...(dryRun ? ['--dry-run'] : [])], {
	cwd: PKG_DIR,
	inherit: true
});
if (published.status !== 0)
	fail('npm publish did not finish. Nothing was published unless npm said so above.');
if (dryRun) {
	say('Dry run done: nothing was published.');
	process.exit(0);
}

// -- 6. WAIT UNTIL THE REGISTRY SHOWS IT (it can lag a few minutes) -- //
say('Waiting for the registry to show the new version...');
const until = Date.now() + WAIT_MS;
while (Date.now() < until) {
	const v = run('npm', ['view', pkg.name, 'version']).stdout.trim();
	if (v === pkg.version) {
		say(`Published: ${pkg.name}@${pkg.version} is the latest version on npm.`);
		process.exit(0);
	}
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
}
say(
	`npm accepted the publish, but the registry does not show ${pkg.version} yet. Check again in a few minutes: npm view ${pkg.name} version`
);
