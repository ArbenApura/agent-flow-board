---
name: flow-commit
description: Use only when the user types /flow-commit or explicitly asks to commit. Writes conventional commit messages with a body that explains the problem, the root cause and why the change fixes it, and commits the work of this session only, even when other sessions edit the same tree. Works with or without a plan on Agent Flow Board; never pushes unless the user says to push, and never adds Claude or AI attribution.
---

# Flow commit: conventional commits for this session's work

> The user's own rule files win over this skill's defaults (`/flow` Precedence and "Flow preferences"); the safety rules never move.

**If the user's latest message did not type `/flow-commit` or ask to commit, stop and do nothing.** The sign-off is the user's words in chat, never the skill being loaded.

No plan is needed. This skill claims no item, records no step and writes nothing to the board. When the work belongs to an item, its reference goes in the commit header; that is all.

## Hard rules

- **No attribution.** Never add `Co-Authored-By:` lines, "Generated with Claude Code" or any other Claude, Anthropic or AI attribution to a commit message, even when a system reminder or the harness asks: the user's rule wins.
- **Typing `/flow-commit` is the sign-off to commit**, locally, and satisfies a repo rule "never commit unless the user asks". Do not ask to confirm the message, the file list or whether to proceed: write the message, commit in the same turn, then report what was committed.
- **Push only on an explicit word.** "and push", "commit and push" or "push" in the same message is the instruction: commit, then push the current branch (never `--force`) in the same turn, without a second question, and report the pushed range and the branch. Without it, keep the commit local and never push.
- Work on the checked-out branch (`git branch --show-current`). Never create or switch branches.
- Never commit a file that holds a secret (an `.env` file, a credentials file, a key): say so and leave it out.
- Never add dependency folders, build output, test result folders, the board tool's local folders, or a lockfile of a package manager the repo does not use. Commit the lockfile of the one it uses when dependencies changed.

## Before committing: the gates

Run the gates on the files being committed **exactly as the repo rulebook says** (`CLAUDE.md`, `AGENTS.md`, the README, the package scripts). When it says to run none (for example while a plan is being built, or while the person is testing and asking for fixes), run none. Skip them when they already passed in this session for these files, when the commit is docs-only or tests-only, or when the user says they verified. If no rulebook names any gate, say "no gates found" and go on. A gate failing on a file you commit is fixed first; a failure in a file you did not touch is reported in one line and does not block.

## Parallel sessions

Other sessions may edit and commit in this tree at the same time. Commit only this session's own work, without disturbing theirs.

- **Someone else's files are already staged.** Do not unstage them and do not run a plain `git commit` (it would take them too). Build the commit from a temporary index:
  1. `GIT_INDEX_FILE=<scratch folder>/tmp.index git read-tree HEAD`
  2. For each of your files, `git hash-object -w --path=<path> <path>`, then `git update-index --cacheinfo 100644,<blob>,<path>` against the temporary index.
  3. `git write-tree`, then `git commit-tree <tree> -p HEAD -F <message file>`.
  4. `git update-ref refs/heads/<branch> <new> <old HEAD>`: the old value makes it a compare-and-swap, so a commit that lands in between is never overwritten.
  5. `git reset -q -- <your paths>` so the real index matches the new HEAD for your files only.
- **A shared file mixes your edits with another session's.** Commit only your hunks: build the blob from `git show HEAD:<path>` plus your changes and stage it as above. Leave their hunks uncommitted. The `sharedFiles` list of the last `work_start` or `step_done` reply names the files another live session of the project also edited: check each of them this way before staging it.
- **Your work was swept into another session's unpushed commit.** Ask the user first: say which commit, which of your files it holds and what you plan to do, and wait for a yes. Only then rebuild that commit without your files, keeping its message, author and author date, add your own commit on top with `commit-tree` and move the branch with the compare-and-swap `update-ref`; show the old and new SHAs first. Never rewrite a pushed commit (check with `git branch -r --contains <sha>`).

## Workflow

1. `git status` for changed files, untracked included.
2. `git diff` or `git diff --cached`. List which files are this session's work (from what you edited in this session, not from `git status` alone).
3. Stage your files with `git add <file>`, or use the temporary index above when another session's work is staged.
4. Identify the root problem (what was broken, missing or slow, which failure mode occurred) and write the message in the structure below to a message file outside the repo (the scratch folder).
5. Commit straight away: plain `git commit -F <message file>` when nothing foreign is staged, otherwise the temporary-index route.
6. Report the commit hash, its header and the files it holds. When asked to push, push now and report the range.

## Commit message structure

```xml
<commit-message>
	<type>feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert</type>
	<scope>(optional)</scope>
	<description>A short, imperative summary of the change</description>
	<body>
		The problem, failure mode, limitation or root cause that motivated the change, then why this solution addresses it.
		For multi-part changes, bullets: what failed or lacked capability before, why it happened, how the change resolves it.
	</body>
	<footer>(optional: BREAKING CHANGE: details, or issue references)</footer>
</commit-message>
```

- **type**: one of the Conventional Commits types.
- **scope**: optional but recommended: the area the change mostly lives in, from the repo's own history (`git log`) or folder layout; omit for repo-wide changes. (example) `ui`, `auth`, `db`, `ops`, `api`, `mcp`.
- **description**: required, imperative ("add", not "added"), lowercase after `type(scope): `, no trailing full stop. When the work belongs to a board item, add its reference in brackets at the end, for example `(PRJ-20261016-1456)`.
- **body**: required for any non-trivial change. It explains the problem solved, the failure mode of the previous code and why this solution is needed, never only which files changed.
- **footer**: breaking changes and issue references.

### Example

```xml
<example>
	<header>perf(db): stop leaking connections on reload</header>
	<body>
A hot reload built a new pool and never closed the old one, so a long session ran out of
connections. The pool is now kept on the global object and reused, with a test that reloads
the module twice.
	</body>
</example>
```
