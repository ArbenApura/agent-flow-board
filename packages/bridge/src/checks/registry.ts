// THE REGISTRATIONS OF THIS MACHINE. A registration is a bare NAME per organisation that says which board project it serves, which repo folder (and app folder) builds it, or which live
// site it checks. One JSON file each in registrations/<org>/<NAME>.json, sealed with an HMAC so a hand edit (an adoptEnv switched on, a repo moved outside the roots) is refused.
// Sign-ins, sealed secrets and kept builds live in stateDirFor(org, NAME) and belong to that one registration.

// -- TYPES -- //
import type { ProjectConfig, Registration } from './types.js';
// -- DEP-MODULES -- //
import { createHash, randomBytes } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
// -- MODULES -- //
import { appendAudit } from './audit.js';
import { appDirText, normalizeAppDir, walkAppDir } from './appdir.js';
import { Refusal, consumeApproval, peekApproval, sameMac, seal } from './approve.js';
import { FORBIDDEN_PORTS, checkRepoFolder } from './guardrails.js';
import { withLockSync } from './lock.js';
import { ORG_SLUG, ensureDir, registrationsDir, stateDirFor } from './paths.js';
import { renameRetry, withRetry } from './fsretry.js';
import { resolveProjectConfig, RECIPE_FILE } from './recipe.js';
import { insideOrSame, rootHolding } from './roots.js';
import { surfaceHash } from './surface.js';

// -- TYPES -- //

export type RegisterInput = {
	org: string;
	name: string;
	/** The board project key this serves. Defaults to the name when the name is a project key. */
	boardProject?: string;
	repo?: string;
	appDir?: string;
	recipe?: boolean;
	url?: string;
	extraHosts?: string[];
	adoptEnv?: boolean;
	uploadSignedInPictures?: boolean;
};
export type RegisterApprovals = {
	/** For a live site (no repo folder to be inside a root). */
	register?: string;
	adoptEnv?: string;
	pictures?: string;
};
export type PinState = 'unpinned' | 'ok' | 'changed';

// -- CONSTANTS -- //

/** A registration name: what the board knows it by. */
export const REGISTRATION_NAME = /^[A-Za-z0-9_-]{1,32}$/;
export const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const MAX_EXTRA_HOSTS = 16;
const HOSTNAME =
	/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_HOSTS = new Set(['localhost', 'host.docker.internal', 'ip6-localhost']);

// -- FUNCTIONS: SMALL HELPERS -- //

const fold = (v: string) => v.toLowerCase();
const same = (a: string, b: string) => fold(a) === fold(b);
const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

function realOrResolved(p: string): string {
	try {
		return realpathSync.native(resolve(p));
	} catch {
		return resolve(p);
	}
}
/** One folder inside the other (or the same), by real path, so a link, a junction, a short name or a `..` cannot hide it. */
const nested = (a: string, b: string) => {
	const [ra, rb] = [realOrResolved(a), realOrResolved(b)];
	return insideOrSame(ra, rb) || insideOrSame(rb, ra);
};

// -- FUNCTIONS: APP FOLDER -- //

/** `web\`, `./web` and `web/` are all `web`. Throws a Refusal for anything that is not a plain relative folder of at most four plain names (the rules are appdir.ts's). */
export function normaliseAppDir(raw: string): string {
	const text = normalizeAppDir(raw);
	const problem = appDirText(text);
	if (problem) throw new Refusal(problem);
	return text;
}

/** One plain sentence when the app folder is not a real folder inside the repo with a package.json, walked without following links (appdir.ts), else null. */
export function checkAppDir(repo: string, appDir: string): string | null {
	const walked = walkAppDir(repo, appDir);
	if (walked.problem !== undefined) return walked.problem;
	try {
		const pkg = lstatSync(join(walked.dir, 'package.json'));
		if (!pkg.isFile()) return `${appDir}/package.json is not a plain file.`;
	} catch {
		return `The app folder ${appDir} has no package.json.`;
	}
	return null;
}

// -- FUNCTIONS: LIVE SITES -- //

const isIpLiteral = (h: string) =>
	h.includes(':') || h.startsWith('[') || /^[0-9.]+$/.test(h) || /^0x/i.test(h);
const isLocalName = (h: string) => LOCAL_HOSTS.has(h) || h.endsWith('.localhost');

/** Exact host names only: no IP literal, no loopback name, no wildcard, no port. Returns the list lower cased and without repeats. */
export function cleanExtraHosts(raw: string[]): string[] {
	const out: string[] = [];
	for (const item of raw) {
		const h = String(item).trim().toLowerCase();
		if (!HOSTNAME.test(h) || isIpLiteral(h) || isLocalName(h))
			throw new Refusal(
				`"${h.slice(0, 60)}" is not an exact host name (no IP address, no localhost, no wildcard, no port).`
			);
		if (!out.includes(h)) out.push(h);
	}
	if (out.length > MAX_EXTRA_HOSTS)
		throw new Refusal(`At most ${MAX_EXTRA_HOSTS} extra hosts are allowed.`);
	return out;
}

/** The live site url, cleaned, or a Refusal. A local url may not use a port a check never uses. */
export function cleanSiteUrl(raw: string): string {
	let u: URL;
	try {
		u = new URL(String(raw ?? '').trim());
	} catch {
		throw new Refusal('The live site address is not a url.');
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:')
		throw new Refusal('A live site address starts with http:// or https://.');
	if (u.username || u.password)
		throw new Refusal('A live site address carries no user name or password.');
	const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	const loopback =
		isLocalName(host) ||
		host === '::1' ||
		host === '0.0.0.0' ||
		/^127\./.test(host) ||
		host === '::';
	const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
	if (loopback && FORBIDDEN_PORTS.has(port))
		throw new Refusal(`The live site address uses port ${port}, which a check never uses.`);
	u.hash = '';
	return u.href;
}

// -- FUNCTIONS: STORAGE -- //

type Stored = Registration & { mac: string };

const canon = (r: Registration): Registration => ({
	org: r.org,
	name: r.name,
	boardProject: r.boardProject,
	...(r.repo !== undefined ? { repo: r.repo } : {}),
	...(r.appDir !== undefined ? { appDir: r.appDir } : {}),
	recipe: r.recipe,
	database: r.database,
	...(r.url !== undefined ? { url: r.url } : {}),
	...(r.extraHosts !== undefined ? { extraHosts: r.extraHosts } : {}),
	adoptEnv: r.adoptEnv,
	uploadSignedInPictures: r.uploadSignedInPictures,
	...(r.pin !== undefined ? { pin: r.pin } : {}),
	createdAt: r.createdAt
});

const macOf = (r: Registration) => seal('registration', JSON.stringify(canon(r)));
const fileOf = (org: string, name: string) => join(registrationsDir(), org, `${name}.json`);

function parseRegistration(v: unknown, org: string): Registration | null {
	if (!isRecord(v)) return null;
	const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
	const name = str('name');
	const boardProject = str('boardProject');
	if (v.org !== org || !name || !REGISTRATION_NAME.test(name)) return null;
	if (!boardProject || !PROJECT_KEY.test(boardProject)) return null;
	if (typeof v.recipe !== 'boolean' || typeof v.adoptEnv !== 'boolean') return null;
	if (typeof v.uploadSignedInPictures !== 'boolean') return null;
	if (v.database !== 'none' && v.database !== 'tool') return null;
	const createdAt = str('createdAt');
	if (!createdAt) return null;
	if (
		v.extraHosts !== undefined &&
		!(Array.isArray(v.extraHosts) && v.extraHosts.every((h) => typeof h === 'string'))
	)
		return null;
	const reg: Registration = {
		org,
		name,
		boardProject,
		recipe: v.recipe,
		database: v.database,
		adoptEnv: v.adoptEnv,
		uploadSignedInPictures: v.uploadSignedInPictures,
		createdAt
	};
	const repo = str('repo');
	const appDir = str('appDir');
	const url = str('url');
	const pin = str('pin');
	if (repo !== undefined) reg.repo = repo;
	if (appDir !== undefined) reg.appDir = appDir;
	if (url !== undefined) reg.url = url;
	if (pin !== undefined) reg.pin = pin;
	if (Array.isArray(v.extraHosts)) reg.extraHosts = v.extraHosts as string[];
	return reg;
}

// -- FILE ACCESS WITH RETRY -- //

/** The file calls of this module. A test replaces `rename` to simulate the errors Windows gives while another process holds the file. */
export const registryIo = {
	rename: (from: string, to: string): void => renameSync(from, to)
};
/** The lock of one registration file, by a hash of org and name so the lock name is always a plain name. */
const lockOf = (org: string, name: string) =>
	`registration-${createHash('sha256').update(`${org}/${name.toLowerCase()}`).digest('hex').slice(0, 32)}`;

/** Writes a registration file with its seal. No rule is checked here (registerProject does that); the tests and the importer use this too. */
export function saveRegistration(reg: Registration): void {
	const stored: Stored = { ...canon(reg), mac: macOf(reg) };
	const file = fileOf(reg.org, reg.name);
	const text = JSON.stringify(stored, null, 2) + '\n';
	ensureDir(dirname(file));
	// One writer at a time per file, and the rename tried again while another process still has the file open
	withLockSync(lockOf(reg.org, reg.name), () => {
		const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
		try {
			writeFileSync(temp, text, { mode: 0o600 });
			renameRetry(temp, file, registryIo.rename);
		} catch (e) {
			rmSync(temp, { force: true });
			throw e;
		}
	});
}

/** Every registration on this machine (or of one organisation), sorted, and one sentence for each file that could not be trusted. */
export function readRegistrations(org?: string): {
	registrations: Registration[];
	problems: string[];
} {
	const registrations: Registration[] = [];
	const problems: string[] = [];
	const root = registrationsDir();
	if (!existsSync(root)) return { registrations, problems };
	let orgs: string[];
	try {
		orgs = readdirSync(root).filter((d) => ORG_SLUG.test(d) && (!org || d === org));
	} catch {
		return { registrations, problems };
	}
	for (const o of orgs.sort()) {
		let files: string[];
		try {
			files = readdirSync(join(root, o)).filter((f) => f.endsWith('.json'));
		} catch {
			continue;
		}
		for (const f of files.sort()) {
			try {
				const doc: unknown = JSON.parse(withRetry(() => readFileSync(join(root, o, f), 'utf8')));
				const reg = parseRegistration(doc, o);
				const mac = isRecord(doc) && typeof doc.mac === 'string' ? doc.mac : '';
				if (!reg || `${reg.name}.json` !== f)
					problems.push(`${o}/${f} is not a registration this tool wrote.`);
				else if (!sameMac(macOf(reg), mac))
					problems.push(
						`${o}/${reg.name} was changed outside "check project", so it is not used. Register it again.`
					);
				else registrations.push(reg);
			} catch {
				problems.push(`${o}/${f} cannot be read.`);
			}
		}
	}
	return { registrations, problems };
}

export const listRegistrations = (org?: string): Registration[] =>
	readRegistrations(org).registrations;

/** A registration by name, without regard to case. */
export function findRegistration(org: string, name: string): Registration | null {
	return listRegistrations(org).find((r) => same(r.name, name)) ?? null;
}

/** True when the registration kept something (sign-ins, sealed secrets, builds). A registration with state cannot be pointed at another folder. */
export function hasState(org: string, name: string): boolean {
	try {
		return readdirSync(stateDirFor(org, name)).length > 0;
	} catch {
		return false;
	}
}

// -- FUNCTIONS: UNIQUENESS RULES -- //

/** The registration of ANOTHER organisation that holds this folder (one organisation per folder), or null. */
export function repoHeldElsewhere(org: string, repo: string): string | null {
	for (const r of listRegistrations())
		if (r.org !== org && r.repo && nested(r.repo, repo)) return `${r.org}/${r.name}`;
	return null;
}

/**
 * The registration of the same organisation that already holds this folder, or null. Two registrations never share a folder, however it is spelled (the same real path, a
 * folder inside the other, a link, a junction). The one exception is one repo holding two apps in different app folders.
 */
export function repoHeldBySibling(
	org: string,
	name: string,
	repo: string,
	appDir: string | undefined
): string | null {
	for (const r of listRegistrations(org)) {
		if (same(r.name, name) || !r.repo || !nested(r.repo, repo)) continue;
		const identical = same(realOrResolved(r.repo), realOrResolved(repo));
		if (identical && !same(r.appDir ?? '', appDir ?? '')) continue;
		return `${r.org}/${r.name}`;
	}
	return null;
}

/** A registration of the organisation whose name differs from this one only by letter case, or null. */
export function nameClash(org: string, name: string): string | null {
	const other = listRegistrations(org).find((r) => same(r.name, name) && r.name !== name);
	return other ? `${org}/${other.name}` : null;
}

/** A registration whose name is the board project another registration serves while it serves a different one (ambiguous for a person typing the name), either way round. */
export function nameShadowsBoard(org: string, name: string, boardProject: string): string | null {
	for (const r of listRegistrations(org)) {
		if (same(r.name, name)) continue;
		if (same(name, r.boardProject) && !same(boardProject, r.boardProject))
			return `${org}/${r.name}`;
		if (same(r.name, boardProject) && !same(r.boardProject, boardProject))
			return `${org}/${r.name}`;
	}
	return null;
}

// -- FUNCTIONS: THE PROJECT CONFIG OF A REGISTRATION -- //

/**
 * What a run needs to know about a registration. For a repo it is the recipe or plain detection of the app folder (the repo itself without one), checked against the guardrails
 * and the roots again every time, with the git root as `repo`. For a live site nothing is built or started. Throws one plain sentence when it cannot be used.
 */
export function configFor(reg: Registration): ProjectConfig {
	const registration = { org: reg.org, name: reg.name };
	if (reg.url) {
		return {
			repo: '',
			start: '',
			needsDatabase: false,
			env: {},
			appPaths: [],
			url: reg.url,
			extraHosts: reg.extraHosts ?? [],
			registration
		};
	}
	if (!reg.repo)
		throw new Refusal(`The registration ${reg.name} has neither a repo folder nor a live site.`);
	if (!rootHolding(reg.repo))
		throw new Refusal(
			`The repo of ${reg.name} is not inside a folder the owner approved (check roots list). Ask the owner to approve its parent folder.`
		);
	let appRoot = reg.repo;
	if (reg.appDir) {
		const dir = normaliseAppDir(reg.appDir);
		const bad = checkAppDir(reg.repo, dir);
		if (bad) throw new Refusal(bad);
		if (!existsSync(join(reg.repo, '.git')))
			throw new Refusal(`${reg.repo} is not the root of a git project (no .git there).`);
		appRoot = join(reg.repo, dir);
	}
	let cfg: ProjectConfig;
	try {
		cfg = resolveProjectConfig(appRoot);
	} catch (e) {
		throw new Refusal(e instanceof Error ? e.message : String(e));
	}
	cfg.repo = reg.repo;
	if (reg.appDir) cfg.appDir = normaliseAppDir(reg.appDir);
	cfg.registration = registration;
	if (reg.adoptEnv) cfg.adoptEnv = true;
	if (reg.extraHosts?.length) cfg.extraHosts = reg.extraHosts;
	return cfg;
}

// -- FUNCTIONS: PIN -- //

const appRootOf = (reg: Registration) =>
	reg.repo && reg.appDir ? join(reg.repo, reg.appDir) : (reg.repo ?? '');

/** The surface hash of a repo registration: its deciding files, plus the git root's when an app folder is used. A live site has none. */
export function surfaceOf(reg: Registration): { hash: string; files: string[] } | null {
	if (!reg.repo) return null;
	return surfaceHash(appRootOf(reg), reg.appDir ? reg.repo : null);
}

/** Whether the files that decide what runs are still the ones that were pinned. */
export function pinState(reg: Registration): PinState {
	const s = surfaceOf(reg);
	if (!s) return 'ok';
	if (!reg.pin) return 'unpinned';
	return reg.pin === s.hash ? 'ok' : 'changed';
}

/**
 * Pins the current surface. The commands are checked against the guardrails again first (configFor), so a changed script that is no longer a plain build command is refused and
 * the old pin stays. The change is audited and returned for the caller to print.
 */
export function pinRegistration(
	org: string,
	name: string
): { name: string; before: string | null; after: string; changed: boolean; files: string[] } {
	const reg = findRegistration(org, name);
	if (!reg) throw new Refusal(`There is no registration ${name} in ${org}.`);
	const s = surfaceOf(reg);
	if (!s) throw new Refusal(`${reg.name} is a live site; it has no build files to pin.`);
	configFor(reg);
	const before = reg.pin ?? null;
	if (before !== s.hash) {
		saveRegistration({ ...reg, pin: s.hash });
		appendAudit('surface pinned', {
			registration: `${org}/${reg.name}`,
			from: before ? before.slice(0, 12) : 'none',
			to: s.hash.slice(0, 12),
			files: s.files.length
		});
	}
	return { name: reg.name, before, after: s.hash, changed: before !== s.hash, files: s.files };
}

// -- FUNCTIONS: REGISTER AND FORGET -- //

/**
 * Registers (or updates) a registration. Every rule is checked before anything is written or any approval code is used. A repo registration needs a repo inside an owner-approved
 * root; a live site, a whole-.env adoption and the upload of signed-in pictures each need the owner's single-use code.
 */
export function registerProject(
	input: RegisterInput,
	approvals: RegisterApprovals = {}
): Registration {
	const org = String(input.org ?? '');
	const name = String(input.name ?? '');
	if (!ORG_SLUG.test(org)) throw new Refusal('The organisation is not a slug.');
	if (!REGISTRATION_NAME.test(name))
		throw new Refusal(
			`"${name.slice(0, 40)}" is not a registration name (1 to 32 letters, digits, dash or underscore).`
		);
	const boardProject = input.boardProject ?? name;
	if (!PROJECT_KEY.test(boardProject))
		throw new Refusal(
			`The board project "${boardProject.slice(0, 20)}" must be 2 to 10 capital letters or digits, starting with a letter. Give --board-project.`
		);
	const hasRepo = input.repo !== undefined && input.repo !== '';
	const hasUrl = input.url !== undefined && input.url !== '';
	if (hasRepo === hasUrl)
		throw new Refusal(
			'Give either a repo folder (--repo) or a live site (--url), not both and not neither.'
		);
	const clash = nameClash(org, name);
	if (clash)
		throw new Refusal(`${clash} already exists; names are unique without regard to letter case.`);
	const shadow = nameShadowsBoard(org, name, boardProject);
	if (shadow)
		throw new Refusal(
			`The name ${name} and ${shadow} would shadow each other's board project. Pick another name.`
		);
	const existing = findRegistration(org, name);

	const reg: Registration = {
		org,
		name,
		boardProject,
		recipe: input.recipe === true,
		database: 'none',
		adoptEnv: input.adoptEnv === true,
		uploadSignedInPictures: input.uploadSignedInPictures === true,
		createdAt: existing?.createdAt ?? new Date().toISOString()
	};
	if (input.extraHosts?.length) reg.extraHosts = cleanExtraHosts(input.extraHosts);
	// What an existing registration already guards (an adopted .env, saved sign-ins, sealed secrets, kept builds) is not re-pointed without the owner
	const hostsOf = (r: { extraHosts?: string[] } | null) =>
		[...(r?.extraHosts ?? [])].sort().join(',');
	const guarded = existing !== null && (existing.adoptEnv || hasState(org, existing.name));
	const hostsChanged = existing !== null && hostsOf(existing) !== hostsOf(reg);
	let needRegister: boolean;
	/** True when the registration now points at another repo, app folder or site than the one it had. */
	let repointed: boolean;

	if (hasUrl) {
		if (input.appDir) throw new Refusal('A live site has no app folder.');
		if (input.adoptEnv) throw new Refusal('A live site has no .env to adopt.');
		reg.url = cleanSiteUrl(input.url as string);
		repointed = existing?.url !== reg.url;
		// A live site is approved for its host: the code names NAME@host, so a code for one site cannot register another
		needRegister = repointed || (guarded && hostsChanged);
		if (existing?.pin) reg.pin = existing.pin;
	} else {
		const given = String(input.repo);
		const appDir = input.appDir ? normaliseAppDir(input.appDir) : undefined;
		const folderProblem = appDir
			? checkRepoFolder(join(resolve(given), appDir))
			: checkRepoFolder(given);
		if (folderProblem) throw new Refusal(folderProblem);
		const repo = realpathSync.native(resolve(given));
		if (appDir) {
			const bad = checkAppDir(repo, appDir);
			if (bad) throw new Refusal(bad);
			if (!existsSync(join(repo, '.git')))
				throw new Refusal(
					`${repo} is not the root of a git project (no .git there). Give the git root as --repo and the app folder as --app-dir.`
				);
		}
		if (!rootHolding(repo))
			throw new Refusal(
				`${repo} is not inside a folder the owner approved. The owner approves its parent folder: check approve --action roots --target <folder>, then check roots add <folder> --approval <code>.`
			);
		const elsewhere = repoHeldElsewhere(org, repo);
		if (elsewhere)
			throw new Refusal(
				`That folder is already held by ${elsewhere}, in another organisation. A folder belongs to one organisation.`
			);
		const sibling = repoHeldBySibling(org, name, repo, appDir);
		if (sibling)
			throw new Refusal(
				`That folder is already held by ${sibling}. The same repo can be registered twice only with a different --app-dir.`
			);
		if (input.recipe && !existsSync(join(appDir ? join(repo, appDir) : repo, RECIPE_FILE)))
			throw new Refusal(
				`--recipe was given but there is no ${RECIPE_FILE} in the ${appDir ? 'app folder' : 'repo'}.`
			);
		const moved =
			existing?.repo !== undefined &&
			(!same(realOrResolved(existing.repo), repo) || !same(existing.appDir ?? '', appDir ?? ''));
		if ((moved || (existing && !existing.repo)) && hasState(org, existing?.name ?? name))
			throw new Refusal(
				`${name} holds saved state (sign-ins, sealed secrets or kept builds) that belongs to its old folder. Run "check project forget ${name} --org ${org}" first, then register it again.`
			);
		repointed = moved || (existing !== null && !existing.repo);
		needRegister = guarded && (repointed || hostsChanged);
		reg.repo = repo;
		if (appDir) reg.appDir = appDir;
		if (existing && !moved && existing.pin) reg.pin = existing.pin;
		reg.database = configFor({ ...reg, adoptEnv: false }).needsDatabase ? 'tool' : 'none';
	}

	// Owner approvals: every rule is checked and every code is looked at (not used) first; the codes are used last, so a refusal never burns one.
	// Adopting the whole .env is per folder: an adoption that was approved for another repo, app folder or site does not carry over to the new one
	const needAdopt = reg.adoptEnv && !(existing?.adoptEnv && !repointed);
	const needPictures = reg.uploadSignedInPictures && !existing?.uploadSignedInPictures;
	const registerTarget = reg.url ? `${name}@${new URL(reg.url).hostname}` : name;
	if (needRegister && !approvals.register)
		throw new Refusal(
			reg.url
				? `Registering a live site, or changing the site or its hosts, needs a code from the owner: check approve --action register --target ${registerTarget}, on an interactive terminal, then --approval <code>.`
				: `Changing the folder or hosts of ${name}, which keeps an adopted .env or saved state, needs a code from the owner: check approve --action register --target ${registerTarget}, on an interactive terminal, then --approval <code>.`
		);
	if (needAdopt && !approvals.adoptEnv)
		throw new Refusal(
			`Adopting the whole repo .env needs a code from the owner: check approve --action adopt-env --target ${name}, then --adopt-env-approval <code>.`
		);
	if (needPictures && !approvals.pictures)
		throw new Refusal(
			`Uploading pictures of a signed-in run needs a code from the owner: check approve --action pictures --target ${name}, then --pictures-approval <code>.`
		);
	if (needRegister && !peekApproval('register', registerTarget, approvals.register ?? ''))
		throw new Refusal('That approval code is wrong, used or expired. Nothing was changed.');
	if (needAdopt && !peekApproval('adopt-env', name, approvals.adoptEnv ?? ''))
		throw new Refusal(
			'The adopt-env approval code is wrong, used or expired. Nothing was changed.'
		);
	if (needPictures && !peekApproval('pictures', name, approvals.pictures ?? ''))
		throw new Refusal('The pictures approval code is wrong, used or expired. Nothing was changed.');
	// Used last. A code that fails here was used or expired in the instant after the look: the others are already spent, and the sentence says so
	const spent: string[] = [];
	const use = (action: string, target: string, code: string, label: string) => {
		if (!consumeApproval(action, target, code))
			throw new Refusal(
				`The ${label} approval code was used or expired just now.${spent.length ? ` The code(s) already used for ${spent.join(' and ')} are spent; ask the owner for new ones.` : ''} Nothing was changed.`
			);
		spent.push(label);
	};
	if (needRegister) use('register', registerTarget, approvals.register ?? '', 'register');
	if (needAdopt) use('adopt-env', name, approvals.adoptEnv ?? '', 'adopt-env');
	if (needPictures) use('pictures', name, approvals.pictures ?? '', 'pictures');

	ensureDir(join(registrationsDir(), org));
	saveRegistration(reg);
	appendAudit(existing ? 'registration updated' : 'registration added', {
		registration: `${org}/${name}`,
		boardProject,
		...(reg.repo
			? { folder: basename(reg.repo) }
			: { site: new URL(reg.url ?? 'http://x').hostname }),
		...(reg.appDir ? { appDir: reg.appDir } : {}),
		adoptEnv: reg.adoptEnv,
		pictures: reg.uploadSignedInPictures
	});
	return reg;
}

/** Lets go of what a registration kept (sign-ins, sealed secrets, kept builds). With `remove` the registration itself goes too. */
export function forgetRegistration(
	org: string,
	name: string,
	opts: { remove?: boolean } = {}
): { name: string; hadState: boolean; removed: boolean } {
	const reg = findRegistration(org, name);
	if (!reg) throw new Refusal(`There is no registration ${name} in ${org}.`);
	const hadState = hasState(org, reg.name);
	rmSync(stateDirFor(org, reg.name), { recursive: true, force: true });
	if (opts.remove === true) rmSync(fileOf(org, reg.name), { force: true });
	appendAudit(opts.remove ? 'registration removed' : 'registration state forgotten', {
		registration: `${org}/${reg.name}`,
		hadState
	});
	return { name: reg.name, hadState, removed: opts.remove === true };
}

/** Makes the state folder of a registration (for the modules that keep sealed data there). */
export function ensureStateDir(org: string, name: string): string {
	const dir = stateDirFor(org, name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}
