// WINDOWS CRLF AND GIT BASH ENVIRONMENT DIAGNOSTICS (STEP E.2, AFB-20261113-1008)
// Detects core.autocrlf=true without LF normalization and emits actionable Windows/Git Bash guidance for check doctor.

// IMPORTED DEP-MODULES
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
// IMPORTED TYPES
import type { Problem } from './doctor.js';

export type WindowsEnvDeps = {
	platform?: NodeJS.Platform;
	gitAutocrlf?: () => string | null;
	hasGitattributes?: (cwd: string) => boolean;
	hasGitDir?: (cwd: string) => boolean;
};

export type WindowsEnvReport = {
	problems: Problem[];
	notes: string[];
	autocrlf: string | null;
	gitattributesPresent: boolean;
};

// -- FUNCTIONS -- //

/** Returns true when text contains Windows CRLF line endings. */
export function hasCrlfLineEndings(text: string): boolean {
	return text.includes('\r\n');
}

function defaultGitAutocrlf(cwd: string): string | null {
	try {
		return execFileSync('git', ['config', '--get', 'core.autocrlf'], {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return null;
	}
}

function findAncestorFile(startDir: string, entryName: string): string | null {
	let cur = resolve(startDir);
	while (true) {
		const candidate = join(cur, entryName);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

function defaultHasLfGitattributes(cwd: string): boolean {
	const p = findAncestorFile(cwd, '.gitattributes');
	if (!p) return false;
	try {
		const raw = readFileSync(p, 'utf8');
		return /\beol=lf\b|\btext=auto\b/i.test(raw);
	} catch {
		return true;
	}
}

/**
 * Inspects Windows / Git Bash / CRLF configuration for the repository cwd.
 * Surfaces notes cleanly without failing non-Windows environments.
 */
export function checkWindowsEnvironment(cwd: string, deps: WindowsEnvDeps = {}): WindowsEnvReport {
	const platform = deps.platform ?? process.platform;
	const problems: Problem[] = [];
	const notes: string[] = [];
	const isGitRepo = deps.hasGitDir ? deps.hasGitDir(cwd) : findAncestorFile(cwd, '.git') !== null;
	const autocrlf = isGitRepo
		? deps.gitAutocrlf
			? deps.gitAutocrlf()
			: defaultGitAutocrlf(cwd)
		: null;
	const gitattributesPresent = deps.hasGitattributes
		? deps.hasGitattributes(cwd)
		: defaultHasLfGitattributes(cwd);

	if (platform === 'win32') {
		notes.push(
			'Windows/Git Bash tip - quote paths containing brackets (e.g. "[org]") and set MSYS_NO_PATHCONV=1 in Git Bash before passing URL routes such as /settings.'
		);
		if (autocrlf?.toLowerCase() === 'true' && !gitattributesPresent) {
			notes.push(
				'Git core.autocrlf is true with no .gitattributes LF rule: tests or parsers checking raw "\\n" line breaks instead of /\\r?\\n/ will fail on CRLF checkouts.'
			);
		}
	}

	return {
		problems,
		notes,
		autocrlf,
		gitattributesPresent
	};
}
