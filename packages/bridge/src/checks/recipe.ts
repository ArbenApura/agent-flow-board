// THE RECIPE: .afb-checks.json IN THE PROJECT'S OWN REPO SAYS HOW ITS PREVIEW IS BUILT, STARTED AND SET UP.
// The repo is the one thing an agent edits, so the recipe is never trusted as it stands: it is pinned (bind.ts) and it is checked here
// against constants of this package. A recipe cannot name another program, a port a check never uses, an env key outside the list, or a value
// that is anything but a placeholder or a short plain word. It can only ask for less than the guardrails allow.
// Sealed secrets ({secret:NAME}) are allowed only on Supabase-style and mail settings (sealedNames.ts), a mail setting takes only the sealed value of its own name, and a
// service key never goes to a PUBLIC_, VITE_ or NEXT_PUBLIC_ name. The values are filled in by secrets.ts when the preview starts; this file only checks the shape.

// -- TYPES -- //
import type { ProjectConfig } from './types.js';
import type { Scripts } from './guardrails.js';
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { FORBIDDEN_PORTS, checkRepoFolder, commandProblem } from './guardrails.js';
import { MAIL_ENV_KEY, SECRET_ENV_KEY, placeholderProblems } from './sealedNames.js';

// -- CONSTANTS -- //

export const RECIPE_FILE = '.afb-checks.json';
/** The only keys of a recipe. */
// There is no migrate or seed step: the app migrates and seeds itself at start from its env (AFB_AUTO_MIGRATE, AFB_SEED_DEMO), and a key nothing reads is refused
export const RECIPE_KEYS = [
	'version',
	'build',
	'start',
	'ready',
	'needsDatabase',
	'runtimeRole',
	'testUser',
	'env',
	'appPaths',
	'warm'
];
/** Env keys a recipe may name: the app's own settings and the database urls, never PATH, NODE_OPTIONS or anything that loads code. */
const ENV_KEY =
	/^(AFB_[A-Z0-9_]{1,50}|BETTER_AUTH_SECRET|DATABASE_URL|DATABASE_OWNER_URL|EMAIL_PROVIDER|EMAIL_FROM|ORIGIN)$/;
/** A browser-visible setting (SvelteKit PUBLIC_*, Vite VITE_*). It is inlined into the page's bundle, so it is never a secret. */
const PUBLIC_ENV_KEY = /^(PUBLIC|VITE)_[A-Z0-9_]{1,60}$/;
/** The values the tool fills in itself. */
const PLACEHOLDER = /^\{(baseUrl|port|random|databaseUrl|databaseOwnerUrl)\}$/;
/** Or a short plain word: no shell characters, no path, no url with a port. */
const PLAIN = /^[A-Za-z0-9_.:@-]{0,60}$/;
const READY_PATH = /^\/[A-Za-z0-9_\-./]*$/;
const APP_PATH = /^[A-Za-z0-9_.\-/]+$/;
/** The files that decide what runs, besides the config files found by pattern. */
const FIXED_FILES = [
	'package.json',
	'yarn.lock',
	'package-lock.json',
	'pnpm-lock.yaml',
	'.yarnrc.yml',
	RECIPE_FILE
];
const CONFIG_FILE = /^(vite|svelte|next|astro|nuxt)\.config\.[A-Za-z]+$/;

// -- FUNCTIONS -- //

const isObject = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

/** The scripts of the package.json of a repo (only string bodies). An unreadable package.json has none. */
function scriptsOf(repo: string): Scripts {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
		const raw = isObject(parsed) && isObject(parsed.scripts) ? parsed.scripts : {};
		const out: Scripts = {};
		for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
		return out;
	} catch {
		return {};
	}
}

/** The package manager the lockfile names. Yarn when there is none. */
function packageManager(repo: string): 'yarn' | 'npm' | 'pnpm' {
	if (existsSync(join(repo, 'yarn.lock'))) return 'yarn';
	if (existsSync(join(repo, 'package-lock.json'))) return 'npm';
	if (existsSync(join(repo, 'pnpm-lock.yaml'))) return 'pnpm';
	return 'yarn';
}

/** The recipe of a repo, parsed, or null when it has none. A recipe that is not valid JSON is an error, never ignored. */
export function loadRecipe(repo: string): unknown {
	const file = join(repo, RECIPE_FILE);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		throw new Error(
			`${RECIPE_FILE} in ${repo} is not valid JSON. Fix it; a recipe that cannot be read is never guessed at.`
		);
	}
}

/** Every problem of a recipe, as plain sentences. An empty list means it may be used. */
export function validateRecipe(recipe: unknown, scripts: Scripts): string[] {
	const out: string[] = [];
	if (!isObject(recipe)) return [`${RECIPE_FILE} must be a JSON object.`];
	const extra = Object.keys(recipe).filter((k) => !RECIPE_KEYS.includes(k));
	if (extra.length)
		out.push(
			`${RECIPE_FILE} names ${extra.join(', ')}, which a recipe may not set (it may set ${RECIPE_KEYS.join(', ')}).`
		);
	if (recipe.version !== 1) out.push(`${RECIPE_FILE} needs "version": 1.`);
	for (const key of ['build', 'start'] as const) {
		const value = recipe[key];
		if (value === undefined) {
			if (key === 'start') out.push(`${RECIPE_FILE} needs a "start" command.`);
			continue;
		}
		const bad = commandProblem(value, scripts, `The recipe's ${key} command`);
		if (bad) out.push(bad);
		for (const p of FORBIDDEN_PORTS)
			if (new RegExp(`(^|[^0-9])${p}([^0-9]|$)`).test(String(value)))
				out.push(`The recipe's ${key} command mentions port ${p}, which a check never uses.`);
	}
	if (recipe.ready !== undefined && !READY_PATH.test(String(recipe.ready)))
		out.push("The recipe's ready path must start with / and hold only plain path characters.");
	for (const p of FORBIDDEN_PORTS)
		if (new RegExp(`(^|[^0-9])${p}([^0-9]|$)`).test(String(recipe.ready ?? '')))
			out.push(`The recipe's ready path mentions port ${p}, which a check never uses.`);
	if (recipe.needsDatabase !== undefined && typeof recipe.needsDatabase !== 'boolean')
		out.push('"needsDatabase" must be true or false.');
	if (
		recipe.runtimeRole !== undefined &&
		!/^[a-z_][a-z0-9_]{0,40}$/.test(String(recipe.runtimeRole))
	)
		out.push('"runtimeRole" must be a plain lower case role name.');
	if (recipe.testUser !== undefined) {
		const u = recipe.testUser;
		const email = isObject(u) ? String(u.email ?? '') : '';
		const password = isObject(u) ? String(u.password ?? '') : '';
		const ok =
			isObject(u) &&
			Object.keys(u).every((k) => ['email', 'password'].includes(k)) &&
			PLAIN.test(email) &&
			email.includes('@') &&
			PLAIN.test(password) &&
			password.length >= 8;
		if (!ok)
			out.push(
				'"testUser" must be { "email": ..., "password": ... } with a plain email and a password of 8 or more plain characters. It is a preview-only account, public by design.'
			);
	}
	// Warm previews are not wired in this version (the benchmark rule waived them), so the key is refused instead of being accepted and ignored
	if (recipe.warm !== undefined) {
		if (typeof recipe.warm !== 'boolean') out.push('"warm" must be true or false.');
		else if (recipe.warm) out.push('"warm": warm previews are not enabled in this version.');
	}
	if (
		recipe.appPaths !== undefined &&
		!(
			Array.isArray(recipe.appPaths) &&
			recipe.appPaths.every((p) => typeof p === 'string' && APP_PATH.test(p) && !p.includes('..'))
		)
	)
		out.push('"appPaths" must be a list of plain folder or file names inside the repo.');
	if (recipe.env !== undefined) {
		if (!isObject(recipe.env)) out.push('"env" must be an object of setting names and values.');
		else
			for (const [k, v] of Object.entries(recipe.env)) {
				if (!ENV_KEY.test(k) && !PUBLIC_ENV_KEY.test(k) && !SECRET_ENV_KEY.test(k))
					out.push(`The recipe sets ${k}, which is not an env key a recipe may set.`);
				// A sealed value only on a Supabase-style or mail setting, and only a key of that kind: never a database, NODE_OPTIONS or a path
				else if (typeof v === 'string' && v.startsWith('{secret:'))
					out.push(...placeholderProblems(k, v));
				// A mail setting is never written in the recipe: its value comes from the sealed store, behind the mail guard
				else if (MAIL_ENV_KEY.test(k))
					out.push(
						`The recipe gives ${k}, a mail setting, a value that is not its own sealed value ({secret:${k}}).`
					);
				else if (typeof v !== 'string' || !(PLACEHOLDER.test(v) || PLAIN.test(v)))
					out.push(
						`The recipe gives ${k} a value that is not a placeholder ({baseUrl}, {port}, {random}, {databaseUrl}, {databaseOwnerUrl}) or a short plain word.`
					);
				else if (/^\d+$/.test(v) && FORBIDDEN_PORTS.has(Number(v)))
					out.push(`The recipe gives ${k} the port ${v}, which a check never uses.`);
			}
	}
	return out;
}

/** The files that decide what runs, as relative names that exist in the repo, sorted. */
export function decidingFiles(repo: string): string[] {
	const found = FIXED_FILES.filter((f) => existsSync(join(repo, f)));
	let names: string[] = [];
	try {
		names = readdirSync(repo).filter((n) => CONFIG_FILE.test(n));
	} catch {
		/* An unreadable folder has no config files */
	}
	return [...new Set([...found, ...names])].sort();
}

/** A sha256 over the names and the line-ending-normalised contents of the deciding files. Any change to them changes the pin. */
export function pinFiles(repo: string): string {
	const hash = createHash('sha256');
	for (const name of decidingFiles(repo)) {
		const text = readFileSync(join(repo, name), 'utf8').replace(/\r\n/g, '\n');
		hash.update(`${name}\0${text}\0`);
	}
	return hash.digest('hex');
}

/**
 * What a run needs to know about a repo: the checked folder, then the recipe when there is one, else plain detection from package.json.
 * Throws one plain sentence when the folder, the recipe or the commands are refused.
 */
export function resolveProjectConfig(repo: string): ProjectConfig {
	const folder = checkRepoFolder(repo);
	if (folder) throw new Error(folder);
	const scripts = scriptsOf(repo);
	const recipe = loadRecipe(repo);
	if (recipe !== null) {
		const problems = validateRecipe(recipe, scripts);
		if (problems.length) throw new Error(problems[0]);
		const r = recipe as Record<string, unknown>;
		const config: ProjectConfig = {
			repo,
			start: String(r.start),
			needsDatabase: r.needsDatabase === true,
			env: isObject(r.env)
				? Object.fromEntries(Object.entries(r.env).map(([k, v]) => [k, String(v)]))
				: {},
			appPaths: Array.isArray(r.appPaths) ? r.appPaths.map(String) : []
		};
		if (typeof r.build === 'string') config.build = r.build;
		if (typeof r.ready === 'string') config.ready = r.ready;
		if (typeof r.runtimeRole === 'string') config.runtimeRole = r.runtimeRole;
		if (isObject(r.testUser))
			config.testUser = { email: String(r.testUser.email), password: String(r.testUser.password) };
		return config;
	}
	// No recipe: detect plainly. npm needs `run` and a `--` before flags; yarn and pnpm run a script by its name.
	const pm = packageManager(repo);
	const run = (script: string) => (pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`);
	if (!Object.prototype.hasOwnProperty.call(scripts, 'preview'))
		throw new Error(
			`${repo} has no "preview" script. Add a ${RECIPE_FILE} that says how to build and start the app, or add a preview script.`
		);
	const config: ProjectConfig = {
		repo,
		start: pm === 'npm' ? 'npm run preview -- --port {port}' : `${run('preview')} --port {port}`,
		needsDatabase: false,
		env: {},
		appPaths: []
	};
	if (Object.prototype.hasOwnProperty.call(scripts, 'build')) config.build = run('build');
	const startBad = commandProblem(config.start, scripts, 'The start command');
	if (startBad) throw new Error(startBad);
	if (config.build) {
		const buildBad = commandProblem(config.build, scripts, 'The build command');
		if (buildBad) throw new Error(buildBad);
	}
	return config;
}
