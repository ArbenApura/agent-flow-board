// WHAT CODE IS BEING TESTED: THE COMMIT, A HASH OF THE UNCOMMITTED CHANGES, AND WHICH FILES CHANGED (SPEC 10, L26)
// A build or a run is tied to the commit plus a hash of the working tree, so a change nobody committed is never mistaken for
// the committed code. Only git commands that read are run.

// IMPORTED DEP-MODULES
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// -- FUNCTIONS -- //

const git = (repo: string, ...args: string[]) =>
	spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });

/** The commit the working tree is on, or null when the folder is not a repo or has no commit. */
export function headCommit(repo: string): string | null {
	const r = git(repo, 'rev-parse', 'HEAD');
	return r.status === 0 ? r.stdout.trim() : null;
}

/** The paths git reports as changed or new, relative to the repo. */
export function changedPaths(repo: string): string[] {
	const r = git(repo, 'status', '--porcelain', '--untracked-files=all');
	if (r.status !== 0) return [];
	return r.stdout
		.split('\n')
		.filter(Boolean)
		.map((l) =>
			l
				.slice(3)
				.replace(/^"|"$/g, '')
				.replace(/.* -> /, '')
		)
		.sort();
}

/** A hash of HEAD plus the content of every uncommitted change under the given paths. */
export function appHash(repo: string, paths: string[]): string {
	const h = createHash('sha1');
	h.update(headCommit(repo) ?? 'no-commit');
	h.update(git(repo, 'diff', 'HEAD', '--no-color', '--', ...paths).stdout ?? '');
	const untracked = git(repo, 'ls-files', '--others', '--exclude-standard', '--', ...paths)
		.stdout.split('\n')
		.filter(Boolean)
		.sort();
	for (const f of untracked) {
		h.update(f);
		try {
			h.update(readFileSync(join(repo, f)));
		} catch {
			h.update('unreadable');
		}
	}
	return h.digest('hex');
}
