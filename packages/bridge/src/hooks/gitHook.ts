// THE LOCAL GIT HOOK: A POST-COMMIT WARNING WHEN A COMMIT NAMES NO BOARD ITEM. WARN ONLY, IT NEVER BLOCKS A COMMIT (ADR-014)
// The hook is a short block between markers, so it can sit beside a hook the person already has and be removed cleanly.

// -- DEP-MODULES -- //
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// -- CONSTANTS -- //

const START = '# >>> agent-flow-board (warn only) >>>';
const END = '# <<< agent-flow-board <<<';
const BLOCK = `${START}
# Warns when a commit names no board item. It never blocks, and it does nothing when the tool is not installed.
if command -v agent-flow-board >/dev/null 2>&1; then agent-flow-board git-hook check || true; fi
${END}`;
const TRAILER = /^(?:board-item|items?|refs?|closes|fixes)\s*:\s*\S/im;
const SUBJECT_REF = /\([A-Za-z][A-Za-z0-9]{1,9}-[A-Za-z0-9][A-Za-z0-9-]{0,30}\)\s*$/;

// -- FUNCTIONS -- //

function hookPath(repo: string): string {
	const rel = execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', 'hooks/post-commit'], {
		encoding: 'utf8'
	}).trim();
	return resolve(repo, rel);
}

/** Adds the warning to the repository's post-commit hook, next to anything already there. Returns the file. */
export function installGitHook(repo: string): { path: string; created: boolean } {
	const path = hookPath(repo);
	const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
	if (existing?.includes(START)) return { path, created: false };
	mkdirSync(dirname(path), { recursive: true });
	const head = existing ?? '#!/bin/sh\n';
	writeFileSync(path, `${head.replace(/\n*$/, '\n')}\n${BLOCK}\n`);
	chmodSync(path, 0o755);
	return { path, created: existing === null };
}

/** Removes only the block this tool wrote. A hook that held nothing else is left empty of it. */
export function uninstallGitHook(repo: string): boolean {
	const path = hookPath(repo);
	if (!existsSync(path)) return false;
	const text = readFileSync(path, 'utf8');
	if (!text.includes(START)) return false;
	const start = text.indexOf(START);
	const end = text.indexOf(END, start);
	writeFileSync(
		path,
		(text.slice(0, start) + text.slice(end + END.length)).replace(/\n{3,}/g, '\n\n')
	);
	return true;
}

/** The warning for a commit message, or null when it names an item. */
export function checkCommit(message: string): string | null {
	if (TRAILER.test(message) || SUBJECT_REF.test((message.split('\n')[0] ?? '').trim())) return null;
	return 'This commit names no board item. Add a line such as "Item: CKT-12" to the message, or ignore this when the work belongs to no item. The board only warns.';
}

export function lastCommitMessage(repo: string): string {
	return execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B'], { encoding: 'utf8' });
}
