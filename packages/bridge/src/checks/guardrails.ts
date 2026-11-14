// THE GUARDRAILS OF THE CHECK COMMANDS. THEY ARE CONSTANTS IN THIS FILE, NEVER DATA: NOTHING IN THE REPO UNDER TEST OR IN A RECIPE CAN WIDEN THEM.
// WHAT THIS DOES AND DOES NOT PROTECT. The preview runs the code of the repo under test, and the agent writes that code. So no rule here can
// stop an agent that means harm: it could put anything in the app. The rules stop mistakes and keep real things safe: the database that holds
// real data, the ports of the servers a person runs, the programs a build is allowed to start, and folders that were never meant to be built.

// IMPORTED DEP-MODULES
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
// IMPORTED MODULES
import { configDir } from '../tokenStore.js';

// -- TYPES -- //

/** The scripts of a package.json: name to body. */
export type Scripts = Record<string, string>;

// -- CONSTANTS -- //

/** Never used by a check: the dev server, the build preview that is served, and the local Docker PostgreSQL that holds real data. */
export const FORBIDDEN_PORTS: ReadonlySet<number> = new Set([5180, 5190, 5433]);
/** The only flags of a build or start command, besides the script name. Anything else could run a file the agent wrote. */
const ARG_OK = /^(--port|\{port\}|--host|127\.0\.0\.1|--strictPort|--)$/;
/** The one word a script may be given besides flags: what a database command should do. */
const SUBCOMMAND_OK = /^migrate$/;
const WORD = /^[A-Za-z0-9_:.@-]+$/;
/**
 * What the body of a package.json script may be: a known build or preview program with a plain command and plain flags. A body that runs a
 * file, chains commands or sets variables is refused, because that is where an arbitrary program would hide.
 */
const BODY_OK =
	/^(vite|svelte-kit|next|astro|nuxt|nuxi|remix) [a-z][a-z-]*( --?[A-Za-z][A-Za-z-]*( [A-Za-z0-9_.:{}/-]+)?){0,4}$/;
/** Folders that hold keys and logins: a build never runs inside or at one of them. */
const SECRET_FOLDERS = ['.ssh', '.gnupg', '.aws', '.kube', '.docker'];

// -- FUNCTIONS -- //

const hasPort = (text: string, port: number) =>
	new RegExp(`(^|[^0-9])${port}([^0-9]|$)`).test(text);
/** Paths compare without case on Windows only. */
const same = (a: string, b: string) =>
	process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const insideOrSame = (parent: string, child: string) => {
	const p = process.platform === 'win32' ? parent.toLowerCase() : parent;
	const c = process.platform === 'win32' ? child.toLowerCase() : child;
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
};

/** One plain sentence when a package.json script is not a plain build or preview command, else null. */
export function scriptBodyProblem(name: string, scripts: Scripts): string | null {
	const body = String(scripts[name] ?? '');
	if (!BODY_OK.test(body))
		return `The script "${name}" runs "${body}", which is not a plain build or preview command (vite, svelte-kit, next, astro, nuxt or remix with plain flags).`;
	// A script body may not name a port a check never uses, nor bind to anything but this machine
	for (const p of FORBIDDEN_PORTS)
		if (hasPort(body, p))
			return `The script "${name}" mentions port ${p}, which a check never uses.`;
	const host = /--host(?:\s+(\S+))?/.exec(body);
	if (host && host[1] !== '127.0.0.1')
		return `The script "${name}" binds the preview to something other than 127.0.0.1.`;
	// A pre or post script runs by itself around it, so it is held to the same rule
	for (const hook of [`pre${name}`, `post${name}`])
		if (Object.prototype.hasOwnProperty.call(scripts, hook) && !BODY_OK.test(String(scripts[hook])))
			return `The script "${hook}" runs by itself around "${name}" and is "${scripts[hook]}", which is not a plain build or preview command.`;
	return null;
}

/**
 * One plain sentence when a build or start command is outside the allowed forms, else null. Allowed: `yarn|npm|pnpm [run] <script>` where the
 * script is named in package.json and its body is a plain build or preview command, with only the flags above. No shell characters, no `..`,
 * no other program, and not `node <file>`: a file is where the agent's own program would run.
 */
export function commandProblem(cmd: unknown, scripts: Scripts, what: string): string | null {
	const text = String(cmd ?? '').trim();
	if (!text) return `${what} is empty.`;
	if (/[&|;<>`$()\\\r\n"'*?%^!]/.test(text) || text.includes('..'))
		return `${what} "${text}" has a character a shell would act on.`;
	const t = text.split(/\s+/);
	if (!['yarn', 'npm', 'pnpm'].includes(t[0]))
		return `${what} "${text}" starts with ${t[0]}. Only yarn, npm or pnpm running a package.json script are allowed.`;
	let i = 1;
	if (t[i] === 'run') i++;
	const script = t[i];
	if (!script || !WORD.test(script)) return `${what} "${text}" names no package.json script.`;
	if (!Object.prototype.hasOwnProperty.call(scripts, script))
		return `${what} "${text}" runs "${script}", which is not a script in package.json.`;
	const body = scriptBodyProblem(script, scripts);
	if (body) return `${what} "${text}": ${body}`;
	const rest = t.slice(i + 1);
	for (let j = 0; j < rest.length; j++) {
		if (j === 0 && SUBCOMMAND_OK.test(rest[j])) continue;
		if (!ARG_OK.test(rest[j]))
			return `${what} "${text}" has the argument ${rest[j]}, which is not one of --port, --host 127.0.0.1 or --strictPort.`;
		if (rest[j] === '--host' && rest[j + 1] !== '127.0.0.1')
			return `${what} "${text}" binds the preview to something other than 127.0.0.1.`;
		if (rest[j] === '--port' && rest[j + 1] !== '{port}')
			return `${what} "${text}" fixes the port. It must be {port}, so the tool picks a free one.`;
	}
	return null;
}

/** True when the folder is a git project or sits inside one (a .git folder or file here or in a parent). */
function insideGit(folder: string): boolean {
	let dir = folder;
	for (;;) {
		if (existsSync(join(dir, '.git'))) return true;
		const up = dirname(dir);
		if (up === dir) return false;
		dir = up;
	}
}

/** The real path of a folder, or its plain resolved path when it cannot be read. */
function realOrResolved(folder: string): string {
	try {
		return realpathSync.native(folder);
	} catch {
		return resolve(folder);
	}
}

/**
 * One plain sentence when the folder may not be built by a check, else null. The rules: it is a folder that exists, a git project (or inside
 * one), not a drive root, the home folder, the bridge home or a folder of keys and logins, it has no link in its path (a symlink or a Windows
 * junction would let the build leave the folder the person named), and it holds a package.json.
 */
export function checkRepoFolder(folder: string): string | null {
	if (typeof folder !== 'string' || !folder.trim()) return 'No folder is given.';
	const resolved = resolve(folder);
	let stat;
	try {
		stat = statSync(resolved);
	} catch {
		return `The folder ${resolved} does not exist.`;
	}
	if (!stat.isDirectory()) return `${resolved} is not a folder.`;
	if (parse(resolved).root === resolved)
		return `${resolved} is the top of a drive. Pick the project's own folder.`;
	// The real path must be the path as written, component by component: any link on the way is refused
	let real: string;
	try {
		real = realpathSync.native(resolved);
	} catch {
		return `The folder ${resolved} cannot be read.`;
	}
	if (!same(real, resolved))
		return `${resolved} goes through a link (it really is ${real}). Give the real folder path.`;
	if (same(resolved, resolve(homedir())))
		return 'That is the home folder. Pick the project folder inside it.';
	if (insideOrSame(realOrResolved(configDir()), real))
		return 'That folder is the bridge home, which holds the sign-in. A check never builds there.';
	for (const part of resolved.split(sep)) {
		if (SECRET_FOLDERS.includes(part.toLowerCase()))
			return `${resolved} is inside a ${part} folder, which holds keys or logins. A check never builds there.`;
	}
	if (!insideGit(resolved)) return `${resolved} is not a git project (no .git here or above it).`;
	if (!existsSync(join(resolved, 'package.json'))) return `${resolved} has no package.json.`;
	return null;
}
