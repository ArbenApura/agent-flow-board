// TESTS OF THE RECIPE: VALIDATION RULE BY RULE, PLAIN DETECTION, THE DECIDING FILES AND THE PIN.

// IMPORTED DEP-MODULES
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	RECIPE_FILE,
	decidingFiles,
	loadRecipe,
	pinFiles,
	resolveProjectConfig,
	validateRecipe
} from './recipe.js';

// -- CONSTANTS -- //

const SCRIPTS = { build: 'vite build', preview: 'vite preview', dev: 'node server.js' };
const GOOD = { version: 1, build: 'yarn build', start: 'yarn preview --port {port}' };

// -- FUNCTIONS -- //

describe('validateRecipe', () => {
	it('accepts a plain recipe', () => {
		expect(validateRecipe(GOOD, SCRIPTS)).toEqual([]);
	});
	it('accepts every allowed key', () => {
		const full = {
			...GOOD,
			ready: '/health',
			needsDatabase: true,
			runtimeRole: 'app_runtime',
			testUser: { email: 'check@example.com', password: 'abcdefgh1' },
			env: {
				AFB_SEED_DEMO: 'true',
				ORIGIN: '{baseUrl}',
				PUBLIC_X: 'a',
				DATABASE_URL: '{databaseUrl}'
			},
			appPaths: ['src', 'static/a.css']
		};
		expect(validateRecipe(full, SCRIPTS)).toEqual([]);
	});
	it('refuses a recipe that is not an object', () => {
		expect(validateRecipe([], SCRIPTS)[0]).toContain('JSON object');
		expect(validateRecipe(null, SCRIPTS)[0]).toContain('JSON object');
	});
	it('refuses an extra key', () => {
		expect(validateRecipe({ ...GOOD, migrate: 'yarn x' }, SCRIPTS).join(' ')).toContain('migrate');
	});
	it('needs version 1', () => {
		expect(validateRecipe({ ...GOOD, version: 2 }, SCRIPTS).join(' ')).toContain('"version": 1');
	});
	it('needs a start command', () => {
		expect(validateRecipe({ version: 1 }, SCRIPTS).join(' ')).toContain('"start"');
	});
	it('refuses a start command that runs a file', () => {
		expect(validateRecipe({ version: 1, start: 'node server.js' }, SCRIPTS).join(' ')).toContain(
			'starts with node'
		);
	});
	it('refuses a build that runs a script with an unplain body', () => {
		expect(validateRecipe({ version: 1, start: 'yarn dev' }, SCRIPTS).join(' ')).toContain(
			'not a plain build or preview command'
		);
	});
	it.each([5180, 5190, 5433])('refuses a ready path that names port %i', (port) => {
		expect(validateRecipe({ ...GOOD, ready: `/x${port}` }, SCRIPTS).join(' ')).toContain(
			String(port)
		);
	});
	it('refuses a ready path that does not start with a slash', () => {
		expect(validateRecipe({ ...GOOD, ready: 'health' }, SCRIPTS).join(' ')).toContain('ready path');
	});
	it('refuses needsDatabase that is not a boolean', () => {
		expect(validateRecipe({ ...GOOD, needsDatabase: 'yes' }, SCRIPTS).join(' ')).toContain(
			'needsDatabase'
		);
	});
	it('refuses a bad runtime role', () => {
		expect(validateRecipe({ ...GOOD, runtimeRole: 'Bad Role;' }, SCRIPTS).join(' ')).toContain(
			'runtimeRole'
		);
	});
	it('refuses a bad testUser', () => {
		const bad = (u: unknown) => validateRecipe({ ...GOOD, testUser: u }, SCRIPTS).join(' ');
		expect(bad({ email: 'a@b.c', password: 'short' })).toContain('testUser');
		expect(bad({ email: 'nomail', password: 'longenough1' })).toContain('testUser');
		expect(bad({ email: 'a@b.c', password: 'has space 123' })).toContain('testUser');
		expect(bad({ email: 'a@b.c', password: 'longenough1', role: 'admin' })).toContain('testUser');
		expect(bad('a@b.c')).toContain('testUser');
	});
	it('refuses appPaths that leave the repo', () => {
		expect(validateRecipe({ ...GOOD, appPaths: ['../x'] }, SCRIPTS).join(' ')).toContain(
			'appPaths'
		);
		expect(validateRecipe({ ...GOOD, appPaths: 'src' }, SCRIPTS).join(' ')).toContain('appPaths');
	});
	it('refuses an env key outside the list', () => {
		expect(
			validateRecipe({ ...GOOD, env: { NODE_OPTIONS: '--require x' } }, SCRIPTS).join(' ')
		).toContain('NODE_OPTIONS');
		expect(validateRecipe({ ...GOOD, env: { PATH: 'x' } }, SCRIPTS).join(' ')).toContain('PATH');
	});
	it('refuses an env value that is not a placeholder or a plain word', () => {
		expect(
			validateRecipe({ ...GOOD, env: { ORIGIN: 'http://x.com; rm' } }, SCRIPTS).join(' ')
		).toContain('ORIGIN');
		expect(validateRecipe({ ...GOOD, env: { ORIGIN: '{other}' } }, SCRIPTS).join(' ')).toContain(
			'ORIGIN'
		);
	});
	it('refuses an env value that is a forbidden port', () => {
		expect(validateRecipe({ ...GOOD, env: { AFB_PORT: '5433' } }, SCRIPTS).join(' ')).toContain(
			'5433'
		);
	});
	it('refuses a sealed secret on a setting that may not take one, naming the setting only', () => {
		const text = validateRecipe({ ...GOOD, env: { AFB_KEY: '{secret:AFB_KEY}' } }, SCRIPTS).join(
			' '
		);
		expect(text).toContain('AFB_KEY');
		const db = validateRecipe(
			{ ...GOOD, env: { DATABASE_URL: '{secret:PUBLIC_SUPABASE_URL}' } },
			SCRIPTS
		).join(' ');
		expect(db).toContain('DATABASE_URL');
		expect(
			validateRecipe({ ...GOOD, env: { ORIGIN: '{secret:PUBLIC_SUPABASE_URL}' } }, SCRIPTS)
		).not.toEqual([]);
	});
	it('refuses a sealed placeholder that is malformed or names a key that cannot be sealed', () => {
		const bad = (v: string) =>
			validateRecipe({ ...GOOD, env: { PUBLIC_SUPABASE_URL: v } }, SCRIPTS).join(' ');
		expect(bad('{secret:NODE_OPTIONS}')).toContain('PUBLIC_SUPABASE_URL');
		expect(bad('{secret:lower_case}')).toContain('PUBLIC_SUPABASE_URL');
		expect(bad('{secret:PUBLIC_SUPABASE_URL} extra')).toContain('PUBLIC_SUPABASE_URL');
		expect(bad('{secret:}')).toContain('PUBLIC_SUPABASE_URL');
	});
	it('accepts a sealed value only on Supabase-style and mail settings', () => {
		const ok = {
			...GOOD,
			env: {
				PUBLIC_SUPABASE_URL: '{secret:PUBLIC_SUPABASE_URL}',
				NEXT_PUBLIC_SUPABASE_ANON_KEY: '{secret:PUBLIC_SUPABASE_ANON_KEY}',
				SUPABASE_SERVICE_ROLE_KEY: '{secret:SUPABASE_SERVICE_ROLE_KEY}',
				SUPABASE_SECRET_KEY: '{secret:SUPABASE_SECRET_KEY}',
				ATTENDEE_AUTH_SECRET: '{secret:ATTENDEE_AUTH_SECRET}',
				POSTMARK_SERVER_TOKEN: '{secret:POSTMARK_SERVER_TOKEN}',
				POSTMARK_FROM_EMAIL: '{secret:POSTMARK_FROM_EMAIL}',
				POSTMARK_MESSAGE_STREAM: '{secret:POSTMARK_MESSAGE_STREAM}'
			}
		};
		expect(validateRecipe(ok, SCRIPTS)).toEqual([]);
	});
	it('never lets a service key reach a PUBLIC_, VITE_ or NEXT_PUBLIC_ setting', () => {
		for (const k of [
			'PUBLIC_SUPABASE_ANON_KEY',
			'VITE_SUPABASE_ANON_KEY',
			'NEXT_PUBLIC_SUPABASE_ANON_KEY'
		])
			for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']) {
				const text = validateRecipe({ ...GOOD, env: { [k]: `{secret:${name}}` } }, SCRIPTS).join(
					' '
				);
				expect(text, `${k} <- ${name}`).toContain('service key');
				expect(text).toContain(k);
			}
	});
	it('lets a mail setting take only the sealed value of its own name', () => {
		const bad = (k: string, name: string) =>
			validateRecipe({ ...GOOD, env: { [k]: `{secret:${name}}` } }, SCRIPTS).join(' ');
		expect(bad('POSTMARK_FROM_EMAIL', 'POSTMARK_SERVER_TOKEN')).toContain('its own name');
		expect(bad('POSTMARK_SERVER_TOKEN', 'PUBLIC_SUPABASE_URL')).toContain('its own name');
		expect(bad('PUBLIC_SUPABASE_URL', 'POSTMARK_SERVER_TOKEN')).toContain('its own name');
		expect(bad('POSTMARK_SERVER_TOKEN', 'POSTMARK_SERVER_TOKEN')).toBe('');
	});
	it('never echoes a value in a problem line', () => {
		const text = validateRecipe(
			{ ...GOOD, env: { ORIGIN: '{secret:SOMETHING_VERY_SECRET_9876}', AFB_X: 'plain; rm -rf' } },
			SCRIPTS
		).join(' ');
		expect(text).not.toContain('SOMETHING_VERY_SECRET_9876');
		expect(text).not.toContain('rm -rf');
	});
	it('refuses the warm key with one plain sentence, and accepts it switched off (warm previews are not enabled)', () => {
		expect(validateRecipe({ ...GOOD, warm: false }, SCRIPTS)).toEqual([]);
		expect(validateRecipe({ ...GOOD, warm: false, needsDatabase: true }, SCRIPTS)).toEqual([]);
		expect(validateRecipe({ ...GOOD, warm: true }, SCRIPTS)).toEqual([
			'"warm": warm previews are not enabled in this version.'
		]);
		expect(validateRecipe({ ...GOOD, warm: 'yes' }, SCRIPTS).join(' ')).toContain('"warm"');
		expect(
			validateRecipe({ ...GOOD, warm: true, needsDatabase: true }, SCRIPTS).join(' ')
		).toContain('not enabled');
	});
	it('refuses an env that is not an object', () => {
		expect(validateRecipe({ ...GOOD, env: ['a'] }, SCRIPTS).join(' ')).toContain('"env"');
	});
});

describe('files on disk', () => {
	let repo = '';
	let savedBridge: string | undefined;
	const write = (name: string, text: string) => writeFileSync(join(repo, name), text);
	const project = (scripts: Record<string, string>) => {
		mkdirSync(join(repo, '.git'));
		write('package.json', JSON.stringify({ scripts }));
	};

	beforeEach(() => {
		repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-recipe-')));
		savedBridge = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(repo, '..', 'afb-recipe-bridge-unused');
	});
	afterEach(() => {
		if (savedBridge === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = savedBridge;
		rmSync(repo, { recursive: true, force: true });
	});

	it('loadRecipe returns null with no recipe, the recipe when there is one, and throws on bad JSON', () => {
		expect(loadRecipe(repo)).toBeNull();
		write(RECIPE_FILE, JSON.stringify(GOOD));
		expect(loadRecipe(repo)).toEqual(GOOD);
		write(RECIPE_FILE, '{ nope');
		expect(() => loadRecipe(repo)).toThrow('not valid JSON');
	});

	it('detects yarn build and preview by default', () => {
		project({ build: 'vite build', preview: 'vite preview' });
		const cfg = resolveProjectConfig(repo);
		expect(cfg.build).toBe('yarn build');
		expect(cfg.start).toBe('yarn preview --port {port}');
		expect(cfg.needsDatabase).toBe(false);
		expect(cfg.repo).toBe(repo);
	});
	it('takes the package manager from the lockfile', () => {
		project({ build: 'vite build', preview: 'vite preview' });
		write('pnpm-lock.yaml', '');
		expect(resolveProjectConfig(repo).start).toBe('pnpm preview --port {port}');
		rmSync(join(repo, 'pnpm-lock.yaml'));
		write('package-lock.json', '{}');
		const cfg = resolveProjectConfig(repo);
		expect(cfg.build).toBe('npm run build');
		expect(cfg.start).toBe('npm run preview -- --port {port}');
	});
	it('needs no build when there is no build script', () => {
		project({ preview: 'vite preview' });
		expect(resolveProjectConfig(repo).build).toBeUndefined();
	});
	it('asks for a recipe when there is no preview script', () => {
		project({ build: 'vite build' });
		expect(() => resolveProjectConfig(repo)).toThrow(RECIPE_FILE);
	});
	it('refuses a detected command whose script body is not plain', () => {
		project({ build: 'node make.js', preview: 'vite preview' });
		expect(() => resolveProjectConfig(repo)).toThrow('not a plain build or preview command');
	});
	it('uses the recipe when there is one and throws its first problem when it is bad', () => {
		project({ build: 'vite build', preview: 'vite preview' });
		write(
			RECIPE_FILE,
			JSON.stringify({
				...GOOD,
				ready: '/up',
				needsDatabase: true,
				env: { ORIGIN: '{baseUrl}' },
				appPaths: ['src']
			})
		);
		const cfg = resolveProjectConfig(repo);
		expect(cfg).toMatchObject({
			start: GOOD.start,
			build: GOOD.build,
			ready: '/up',
			needsDatabase: true,
			env: { ORIGIN: '{baseUrl}' },
			appPaths: ['src']
		});
		write(RECIPE_FILE, JSON.stringify({ ...GOOD, extra: 1 }));
		expect(() => resolveProjectConfig(repo)).toThrow('extra');
	});
	it('refuses a folder the guardrails refuse', () => {
		write('package.json', JSON.stringify({ scripts: { preview: 'vite preview' } }));
		expect(() => resolveProjectConfig(repo)).toThrow('not a git project');
	});

	it('lists the deciding files that exist, sorted', () => {
		project({});
		write('yarn.lock', '');
		write('vite.config.ts', '');
		write('svelte.config.js', '');
		write('webpack.config.js', '');
		expect(decidingFiles(repo)).toEqual([
			'package.json',
			'svelte.config.js',
			'vite.config.ts',
			'yarn.lock'
		]);
	});
	it('pins the files: stable, line-ending proof, and changed by a change', () => {
		project({ build: 'vite build' });
		write('vite.config.ts', 'a\nb\n');
		const first = pinFiles(repo);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(pinFiles(repo)).toBe(first);
		write('vite.config.ts', 'a\r\nb\r\n');
		expect(pinFiles(repo)).toBe(first);
		write('vite.config.ts', 'a\nc\n');
		expect(pinFiles(repo)).not.toBe(first);
		write('vite.config.ts', 'a\nb\n');
		write(RECIPE_FILE, '{}');
		expect(pinFiles(repo)).not.toBe(first);
	});
});

// -- THE REAL HAPR RECIPES (COPIED AS THEY ARE; NO VALUE IN THEM IS SECRET, ONLY {secret:NAME} PLACEHOLDERS) -- //

const HAPR_WEB = `{
	"version": 1,
	"build": "pnpm build",
	"start": "pnpm preview --port {port} --host 127.0.0.1",
	"ready": "/login",
	"needsDatabase": false,
	"env": {
		"PUBLIC_SUPABASE_URL": "{secret:PUBLIC_SUPABASE_URL}",
		"PUBLIC_SUPABASE_ANON_KEY": "{secret:PUBLIC_SUPABASE_ANON_KEY}",
		"PUBLIC_GOOGLE_MAPS_API_KEY": "placeholder",
		"SUPABASE_SERVICE_ROLE_KEY": "{secret:SUPABASE_SERVICE_ROLE_KEY}",
		"ATTENDEE_AUTH_SECRET": "{secret:ATTENDEE_AUTH_SECRET}",
		"POSTMARK_SERVER_TOKEN": "{secret:POSTMARK_SERVER_TOKEN}",
		"POSTMARK_FROM_EMAIL": "{secret:POSTMARK_FROM_EMAIL}"
	}
}`;
const HAPR_LANDING = `{
	"version": 1,
	"build": "pnpm build",
	"start": "pnpm preview --port {port} --host 127.0.0.1",
	"ready": "/",
	"needsDatabase": false,
	"env": {
		"PUBLIC_DEMO_HUB_VERIFIED": "true"
	}
}`;

describe('the real hapr-gameplan recipes', () => {
	it('accepts the web recipe', () => {
		expect(validateRecipe(JSON.parse(HAPR_WEB), SCRIPTS)).toEqual([]);
	});
	it('accepts the landing recipe', () => {
		expect(validateRecipe(JSON.parse(HAPR_LANDING), SCRIPTS)).toEqual([]);
	});
	it('refuses each broken variant of the sealed rules in the web recipe', () => {
		const web = JSON.parse(HAPR_WEB) as { env: Record<string, string> };
		const variant = (change: Record<string, string>) =>
			validateRecipe({ ...web, env: { ...web.env, ...change } }, SCRIPTS).join(' ');
		expect(variant({ PUBLIC_SUPABASE_ANON_KEY: '{secret:SUPABASE_SERVICE_ROLE_KEY}' })).toContain(
			'service key'
		);
		expect(variant({ POSTMARK_FROM_EMAIL: '{secret:POSTMARK_SERVER_TOKEN}' })).toContain(
			'its own name'
		);
		expect(variant({ DATABASE_URL: '{secret:PUBLIC_SUPABASE_URL}' })).toContain('DATABASE_URL');
		expect(variant({ NODE_OPTIONS: '{secret:ATTENDEE_AUTH_SECRET}' })).toContain('NODE_OPTIONS');
		expect(variant({ ATTENDEE_AUTH_SECRET: 'secret:ATTENDEE_AUTH_SECRET; rm' })).toContain(
			'ATTENDEE_AUTH_SECRET'
		);
		expect(variant({ POSTMARK_SERVER_TOKEN: 'a-literal-token' })).toContain(
			'POSTMARK_SERVER_TOKEN'
		);
		expect(variant({ POSTMARK_SERVER_TOKEN: 'a-literal-token' })).not.toContain('a-literal-token');
		expect(
			validateRecipe({ ...web, start: 'pnpm preview --port 5190' }, SCRIPTS).join(' ')
		).toContain('5190');
	});
});
