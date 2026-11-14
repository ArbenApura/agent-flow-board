// THE APP FOLDER OF A PROJECT. Some repos keep the app in a subfolder (the git root has no package.json, the app and its lockfile live in web/).
// A registration may name that folder with `appDir`; the private copy is still made from the git root, but install, build and start run in the
// app folder, and the files that decide what runs (package.json, lockfile, recipe) are read from there. Without appDir the app folder is the repo root.

// IMPORTED DEP-MODULES
import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
// IMPORTED MODULES
import { isInside } from './paths.js';

// -- TYPES -- //

export type AppDirWalk =
	{ problem: string; dir?: undefined } | { dir: string; problem?: undefined };

// -- CONSTANTS -- //

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,60}$/;
const BARRED = new Set(['.git', 'node_modules']);
/** Names Windows keeps for devices, with or without an extension. */
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// -- FUNCTIONS -- //

/** The cosmetic forms (web\, ./web, web/) become one value: web. Anything else is returned as it is, for appDirText to refuse. */
export function normalizeAppDir(raw: unknown): string {
	let s = String(raw ?? '')
		.trim()
		.replace(/\\/g, '/');
	while (s.startsWith('./')) s = s.slice(2);
	s = s.replace(/\/+$/, '');
	return s;
}

/** One plain sentence when `appDir` is not a plain relative folder name (or a few of them), else null. Looks at the text only. */
export function appDirText(appDir: unknown): string | null {
	if (typeof appDir !== 'string' || !appDir)
		return 'appDir must be a folder name inside the repo, for example web.';
	if (normalizeAppDir(appDir) !== appDir)
		return `appDir "${appDir}" must be written as plain folder names with forward slashes and no trailing slash, for example web.`;
	if (isAbsolute(appDir) || /^[A-Za-z]:/.test(appDir) || appDir.startsWith('/'))
		return 'appDir must be inside the repo, not an absolute path.';
	const segments = appDir.split('/');
	if (segments.length > 4) return 'appDir may name at most 4 nested folders.';
	for (const s of segments) {
		if (s === '.' || s === '..') return 'appDir may not contain . or .. .';
		if (!SEGMENT.test(s))
			return `appDir has a folder name (${s.slice(0, 40)}) with characters a plain folder name does not use.`;
		if (BARRED.has(s.toLowerCase())) return `appDir may not go through ${s}.`;
		// Windows drops a trailing dot, so web. would be read as web while a git path web./src matches nothing
		if (s.endsWith('.') || DEVICE.test(s))
			return `appDir has a folder name (${s.slice(0, 40)}) that ends with a dot or is a device name.`;
	}
	return null;
}

/**
 * Walks appDir folder by folder from `base`, without following a link: a link, a junction, a file in its place or a folder that leaves `base` is a
 * problem. Used on the live repo when a registration is made and again on the private copy of every run.
 */
export function walkAppDir(base: string, appDir: string, what = 'the repo'): AppDirWalk {
	const text = appDirText(appDir);
	if (text) return { problem: text };
	let cur = base;
	for (const seg of appDir.split('/')) {
		cur = join(cur, seg);
		let st;
		try {
			st = lstatSync(cur);
		} catch {
			return {
				problem: `The app folder ${appDir} is not in ${what}${what === 'the repo' ? '' : ' (is it committed?)'}.`
			};
		}
		if (st.isSymbolicLink())
			return {
				problem: `The app folder ${appDir} goes through a link (${seg}), which an app folder may not do.`
			};
		if (!st.isDirectory()) return { problem: `${appDir} is not a folder in ${what}.` };
	}
	if (!isInside(base, cur)) return { problem: `The app folder ${appDir} leaves ${what}.` };
	return { dir: cur };
}

/** The app folder of a config in the live repo: repo/appDir, or the repo itself. The text is not checked here. */
export function appRoot(cfg: { repo: string; appDir?: string }): string {
	return cfg.appDir ? join(cfg.repo, ...cfg.appDir.split('/')) : cfg.repo;
}

/** The app folder inside a run's private copy (`root` is the copy of the folder that holds the app folder), or an error that stops the run. */
export function sandboxAppRoot(root: string, appDir?: string): string {
	if (!appDir) return root;
	const r = walkAppDir(root, appDir, 'the private copy of the repo');
	if (r.problem !== undefined) throw new Error(r.problem);
	if (!existsSync(join(r.dir, 'package.json')))
		throw new Error(
			`The app folder ${appDir} has no package.json in the private copy of the repo (a submodule, or not committed?).`
		);
	return r.dir;
}

/** A problem with an app folder of a live repo: the text, the walk and the package.json. Null when it is fine. */
export function appDirProblem(repo: string, appDir: string): string | null {
	const r = walkAppDir(repo, appDir);
	if (r.problem !== undefined) return r.problem;
	if (!existsSync(join(r.dir, 'package.json')))
		return `The app folder ${appDir} has no package.json.`;
	return null;
}

/** The pathspecs of the app files relative to the git root: appPaths are relative to the app folder, so they are prefixed with it. */
export const gitAppPaths = (appPaths: string[], appDir?: string): string[] =>
	appDir ? appPaths.map((p) => (p === '.' ? appDir : `${appDir}/${p}`)) : appPaths;
