// `check import-legacy --from <afb-checks folder> --org <slug> [--dry-run] [--json]`: MOVES THE SETUP OF THE STANDALONE afb-checks TOOL INTO THE BRIDGE, READ ONLY ON THE OLD FOLDER.
// It reads ONLY <from>/data/projects/<org>/*.json (the project definitions: repo, appDir, boardProject, recipe, url, extraHosts) and the check scripts
// <from>/checks/<org>/<item>/<key>.mjs. It never lists or reads anything else under the old folder: no profiles, no secrets, no keys, no sign-ins.
// Each project is registered again through registry.ts with adoption OFF and no pin; a repo registration is made only when its folder is inside an owner-approved
// root (otherwise it is listed with the exact command the owner needs). Each script is checked with lintCheck and copied unchanged (headers kept) into the scripts
// folder; a script that fails the lint is not copied, and one that differs from an existing script is a conflict and is left as it is.

// -- DEP-MODULES -- //
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
// -- MODULES -- //
import { Refusal, UsageError } from './approve.js';
import { appendAudit } from './audit.js';
import { checkRepoFolder } from './guardrails.js';
import { lintCheck } from './guard.js';
import { NAME, ORG_SLUG, scriptPath } from './paths.js';
import { PROJECT_KEY, REGISTRATION_NAME, findRegistration, registerProject } from './registry.js';
import { rootHolding } from './roots.js';

// -- TYPES -- //

export type ImportContext = {
	log(line: string): void;
	out(line: string): void;
	json?: boolean;
};
export type SkippedProject = { name: string; reason: string; next?: string };
export type RejectedScript = { item: string; key: string; reasons: string[] };
export type ImportSummary = {
	ok: boolean;
	dryRun: boolean;
	org: string;
	projects: {
		found: number;
		registered: string[];
		unchanged: string[];
		skipped: SkippedProject[];
	};
	scripts: {
		found: number;
		copied: number;
		same: number;
		conflicts: string[];
		rejected: RejectedScript[];
	};
	notes: string[];
	todo: string[];
};
type OldProject = {
	repo?: string;
	appDir?: string;
	boardProject?: string;
	recipe?: boolean;
	database?: unknown;
	url?: string;
	extraHosts?: string[];
	build?: string;
	start?: string;
	ready?: string;
};

// -- CONSTANTS -- //

/** A script larger than this is not a check. */
const MAX_SCRIPT_BYTES = 1_000_000;
const MAX_PROJECT_BYTES = 200_000;

// -- FUNCTIONS: SMALL HELPERS -- //

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A plain file (not a link) as bytes, or null. Refuses anything larger than `max`. */
function readPlain(file: string, max: number): Buffer | null {
	try {
		const st = lstatSync(file);
		if (!st.isFile() || st.size > max) return null;
		return readFileSync(file);
	} catch {
		return null;
	}
}

/** The names in a folder that pass `ok`, sorted. A folder that is a link is not entered. */
function listNames(dir: string, ok: (n: string) => boolean): string[] {
	try {
		if (lstatSync(dir).isSymbolicLink()) return [];
		return readdirSync(dir).filter(ok).sort();
	} catch {
		return [];
	}
}

function parseProject(raw: Buffer | null): OldProject | null {
	if (!raw) return null;
	try {
		const v: unknown = JSON.parse(raw.toString('utf8'));
		if (!isRecord(v)) return null;
		return {
			repo: text(v.repo),
			appDir: text(v.appDir),
			boardProject: text(v.boardProject),
			recipe: v.recipe === true,
			database: v.database,
			url: text(v.url),
			extraHosts: Array.isArray(v.extraHosts)
				? v.extraHosts.filter((h): h is string => typeof h === 'string')
				: undefined,
			build: text(v.build),
			start: text(v.start),
			ready: text(v.ready)
		};
	} catch {
		return null;
	}
}

// -- FUNCTIONS: PROJECTS -- //

function importProject(
	org: string,
	name: string,
	old: OldProject,
	dryRun: boolean
): { kind: 'registered' | 'unchanged' } | { kind: 'skipped'; skip: SkippedProject } {
	const skip = (reason: string, next?: string) => ({
		kind: 'skipped' as const,
		skip: { name, reason, ...(next ? { next } : {}) }
	});
	const boardProject = old.boardProject ?? name;
	if (!PROJECT_KEY.test(boardProject))
		return skip(`its board project "${boardProject.slice(0, 20)}" is not a project key`);

	const existing = findRegistration(org, name);
	if (existing) return { kind: 'unchanged' };

	// A live site needs the owner's code; it is never made here
	if (old.url) {
		const hosts = old.extraHosts?.length ? ` --extra-hosts ${old.extraHosts.join(',')}` : '';
		return skip(
			'a live site is registered only with a code from the owner',
			`check approve --action register --target ${name}, then check project ${name} --org ${org} --board-project ${boardProject} --url ${old.url}${hosts} --approval <code>`
		);
	}
	if (!old.repo) return skip('the project file names neither a repo folder nor a live site');
	const folder = resolve(old.repo);
	if (!existsSync(folder)) return skip('its repo folder is not on this machine');
	const root = rootHolding(folder);
	if (!root) {
		const parent = dirname(folder);
		return skip(
			'its repo folder is not inside a folder the owner approved',
			`check approve --action roots --target "${parent}", then check roots add "${parent}" --approval <code>, then import again`
		);
	}
	const input = {
		org,
		name,
		boardProject,
		repo: folder,
		...(old.appDir ? { appDir: old.appDir } : {}),
		recipe: old.recipe === true,
		adoptEnv: false,
		uploadSignedInPictures: false
	};
	if (dryRun) {
		const problem = checkRepoFolder(old.appDir ? join(folder, old.appDir) : folder);
		return problem ? skip(problem) : { kind: 'registered' };
	}
	try {
		registerProject(input);
		return { kind: 'registered' };
	} catch (e) {
		if (e instanceof Refusal) return skip(e.message);
		throw e;
	}
}

// -- FUNCTIONS: SCRIPTS -- //

function importScripts(from: string, org: string, dryRun: boolean): ImportSummary['scripts'] {
	const out: ImportSummary['scripts'] = {
		found: 0,
		copied: 0,
		same: 0,
		conflicts: [],
		rejected: []
	};
	const base = join(from, 'checks', org);
	for (const item of listNames(base, (n) => NAME.test(n))) {
		const itemDir = join(base, item);
		for (const file of listNames(itemDir, (n) => n.endsWith('.mjs'))) {
			const key = file.slice(0, -'.mjs'.length);
			if (!NAME.test(key)) continue;
			const bytes = readPlain(join(itemDir, file), MAX_SCRIPT_BYTES);
			if (!bytes) continue;
			out.found++;
			const reasons = lintCheck(bytes.toString('utf8'));
			if (reasons.length) {
				out.rejected.push({ item, key, reasons });
				continue;
			}
			const target = scriptPath(org, item, key);
			if (existsSync(target)) {
				const have = readPlain(target, MAX_SCRIPT_BYTES);
				if (have && have.equals(bytes)) out.same++;
				else out.conflicts.push(`${item}/${key}`);
				continue;
			}
			if (!dryRun) {
				mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
				// 'wx': never replaces a script that appeared in the meantime
				try {
					writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
						out.conflicts.push(`${item}/${key}`);
						continue;
					}
					throw e;
				}
			}
			out.copied++;
		}
	}
	return out;
}

// -- FUNCTIONS: THE IMPORT -- //

/** Reads the old folder (project files and scripts only) and brings both into the bridge. Throws a Refusal or UsageError for input it cannot use. */
export function importLegacy(opts: { from: string; org: string; dryRun?: boolean }): ImportSummary {
	const dryRun = opts.dryRun === true;
	const org = opts.org;
	if (!ORG_SLUG.test(org)) throw new UsageError('--org takes an organisation slug.');
	const from = resolve(opts.from);
	try {
		if (!lstatSync(from).isDirectory()) throw new Error('not a folder');
	} catch {
		throw new Refusal(`${basename(from)} is not a folder that exists.`);
	}
	const projectsDir = join(from, 'data', 'projects', org);
	const names = listNames(projectsDir, (n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
	const projects: ImportSummary['projects'] = {
		found: 0,
		registered: [],
		unchanged: [],
		skipped: []
	};
	const notes: string[] = [];
	for (const name of names) {
		projects.found++;
		if (!REGISTRATION_NAME.test(name)) {
			projects.skipped.push({
				name: name.slice(0, 40),
				reason: 'its name is not a registration name'
			});
			continue;
		}
		const old = parseProject(readPlain(join(projectsDir, `${name}.json`), MAX_PROJECT_BYTES));
		if (!old) {
			projects.skipped.push({ name, reason: 'its project file cannot be read' });
			continue;
		}
		if (!old.recipe && (old.build || old.start))
			notes.push(
				`${name}: the old build and start commands are not copied; the bridge reads the package scripts or a recipe (.afb-checks.json).`
			);
		const r = importProject(org, name, old, dryRun);
		if (r.kind === 'skipped') projects.skipped.push(r.skip);
		else if (r.kind === 'registered') projects.registered.push(name);
		else projects.unchanged.push(name);
	}
	const scripts = importScripts(from, org, dryRun);

	const todo: string[] = [];
	for (const s of projects.skipped) if (s.next) todo.push(`${s.name}: ${s.next}`);
	if (projects.registered.length || projects.unchanged.length) {
		todo.push(
			`Secrets are not moved (they are sealed with the old key). Import them again with an approval code: ${[...projects.registered, ...projects.unchanged].map((n) => `check approve --action secrets --target ${n}`).join('; ')}, then check secrets import ... --approval <code>.`
		);
		todo.push(
			`Make the sign-ins again: ${[...projects.registered, ...projects.unchanged].map((n) => `check login ${n} --org ${org}`).join('; ')}.`
		);
	}
	if (scripts.conflicts.length)
		todo.push(
			'Compare the conflicting scripts with the ones in the bridge scripts folder and keep the right one by hand; nothing was overwritten.'
		);
	todo.push(
		'When the bridge has taken over, stop the old worker and its service (the owner does this).'
	);

	const summary: ImportSummary = {
		ok: !projects.skipped.length && !scripts.conflicts.length && !scripts.rejected.length,
		dryRun,
		org,
		projects,
		scripts,
		notes,
		todo
	};
	if (!dryRun)
		appendAudit('import-legacy', {
			org,
			projects: projects.found,
			registered: projects.registered.length,
			skipped: projects.skipped.length,
			scripts: scripts.found,
			copied: scripts.copied,
			conflicts: scripts.conflicts.length,
			rejected: scripts.rejected.length
		});
	return summary;
}

/** `check import-legacy --from <folder> --org <slug> [--dry-run] [--json]`. Exit 0 all imported, 1 something was skipped or needs the owner, 2 could not run. */
export async function importLegacyCommand(args: string[], ctx: ImportContext): Promise<number> {
	const json = ctx.json ?? args.includes('--json');
	const list = args[0] === 'import-legacy' ? args.slice(1) : args;
	const flag = (name: string): string | undefined => {
		const i = list.indexOf(name);
		const v = i >= 0 ? list[i + 1] : undefined;
		return v === undefined || v.startsWith('--') ? undefined : v;
	};
	try {
		const from = flag('--from');
		const org = flag('--org');
		if (!from || !org)
			throw new UsageError(
				'Usage: agent-flow-board check import-legacy --from <afb-checks folder> --org <slug> [--dry-run] [--json]'
			);
		const s = importLegacy({ from, org, dryRun: list.includes('--dry-run') });
		if (json) ctx.out(JSON.stringify(s));
		else {
			ctx.log(
				`${s.dryRun ? 'Would import' : 'Imported'} for ${s.org}: ${s.projects.registered.length} of ${s.projects.found} project(s) registered (${s.projects.unchanged.length} already there), ${s.scripts.copied} of ${s.scripts.found} script(s) copied (${s.scripts.same} already the same).`
			);
			for (const p of s.projects.skipped)
				ctx.log(`Skipped ${p.name}: ${p.reason}.${p.next ? ` Needs: ${p.next}` : ''}`);
			for (const c of s.scripts.conflicts) ctx.log(`Conflict (left as it is): ${c}`);
			for (const r of s.scripts.rejected)
				ctx.log(`Not copied ${r.item}/${r.key}: ${r.reasons.join(', ')}`);
			for (const n of s.notes) ctx.log(`Note: ${n}`);
			for (const t of s.todo) ctx.log(`To do (owner): ${t}`);
		}
		return s.ok ? 0 : 1;
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (json) ctx.out(JSON.stringify({ ok: false, event: 'error', error: message }));
		else ctx.log(message);
		return e instanceof Refusal ? 1 : 2;
	}
}
