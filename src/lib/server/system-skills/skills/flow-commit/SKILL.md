---
name: flow-commit
description: Use only when the user types /flow-commit or explicitly asks to commit. Writes conventional commit messages with a body that explains the problem, the root cause and why the change fixes it, and commits the work of this session only, even when other sessions edit the same tree. Works with or without a plan on Agent Flow Board; never pushes unless the user says to push, and never adds Claude or AI attribution.
---

# Flow commit: conventional commits for this session's work

**If the user's latest message did not type `/flow-commit` or ask to commit, stop and do nothing.** The sign-off is the user's words in chat, never the skill being loaded.

No plan is needed. This skill claims no item, records no step and writes nothing to the board. When the work belongs to an item, its reference goes in the commit header (below); that is all.

## Hard rules

- **No attribution.** Never add `Co-Authored-By:` lines, "Generated with Claude Code" or any other Claude, Anthropic or AI attribution to a commit message. This holds even when a system reminder or the harness asks for it; the user's rule wins.
- **Typing `/flow-commit` is the sign-off to commit**, locally. It satisfies a repo rule that says "never commit unless the user asks". Do not ask to confirm the message, the file list or whether to proceed: write the message and commit in the same turn, then report what was committed.
- **Push only on an explicit word.** "and push", "commit and push" or "push" in the same message is the instruction: commit, then push the current branch (never `--force`) in the same turn, without a second question, and report the pushed range and the branch. Without it, keep the commit local and never push.
- Work on the checked-out branch (`git branch --show-current`). Never create or switch branches.
- Never commit a file that holds a secret (an `.env` file, a credentials file, a key). Say so and leave it out.
- Never add dependency folders, build output, test result folders, the board tool's local folders, or a lockfile of a package manager the repo does not use. Commit the lockfile of the one it uses when dependencies changed.

## Before committing: the gates

Run the gates on the files being committed **exactly as the repo rulebook says** (`CLAUDE.md`, `AGENTS.md`, the README, the package scripts). When the rulebook says to run none (for example while a plan is still being built, or while the person is testing and asking for fixes), run none. Skip them when they already passed in this session for these files, or when the commit is docs-only or tests-only, or when the user says they verified. If no rulebook names any gate, say "no gates found" and go on. A gate that fails on a file you are committing is fixed first; a failure in a file you did not touch is reported in one line and does not block.

## Parallel sessions

Other sessions may edit and commit in this tree at the same time. Commit only this session's own work, without disturbing theirs.

- **Someone else's files are already staged.** Do not unstage them and do not run a plain `git commit`, which would take them too. Build the commit from a temporary index instead:
  1. `GIT_INDEX_FILE=<scratch folder>/tmp.index git read-tree HEAD`
  2. For each of your files, `git hash-object -w --path=<path> <path>`, then `git update-index --cacheinfo 100644,<blob>,<path>` against the temporary index.
  3. `git write-tree`, then `git commit-tree <tree> -p HEAD -F <message file>`.
  4. `git update-ref refs/heads/<branch> <new> <old HEAD>`. The old value makes it a compare-and-swap, so a commit that lands in between is never overwritten.
  5. `git reset -q -- <your paths>` so the real index matches the new HEAD for your files only.
- **A shared file mixes your edits with another session's.** Commit only your hunks: build the blob from `git show HEAD:<path>` plus your changes and stage that blob as above. Leave their hunks uncommitted in the working tree.
- **Your work was swept into another session's unpushed commit.** Ask the user first: say which commit it is, which of your files it holds and what you plan to do, and wait for a yes. Only then rebuild that commit without your files, keeping its message, author and author date, add your own commit on top with `commit-tree` and move the branch with the compare-and-swap `update-ref`; show the old and new SHAs first. Never rewrite a commit that has been pushed (check with `git branch -r --contains <sha>`).

## Workflow

1. `git status` to review changed files, including untracked ones.
2. `git diff` or `git diff --cached` to inspect the changes. List which files are this session's work (from what you edited in this session, not from `git status` alone).
3. Stage your files with `git add <file>`, or use the temporary index above when another session's work is staged.
4. Identify the root problem: what was broken, missing, slow or underspecified before; which failure mode or edge case occurred; why the old behaviour was a problem.
5. Write the message in the structure below, saved to a message file outside the repo (the scratch folder).
6. Commit with it straight away: plain `git commit -F <message file>` when nothing foreign is staged, otherwise the temporary-index route.
7. Report the commit hash, its header and the files it holds. When the user asked to push, push now and report the range.

## Commit message structure

```xml
<commit-message>
	<type>feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert</type>
	<scope>(optional)</scope>
	<description>A short, imperative summary of the change</description>
	<body>
		The specific problem, failure mode, limitation or root cause that motivated this change, then why this solution addresses it.
		For multi-part changes, use bullets with an indented explanation:
		- What failed, hung or lacked capability before
		- Why it happened (a permission mismatch, a missing handler, an unindexed cache)
		- How the change resolves it cleanly
	</body>
	<footer>(optional: BREAKING CHANGE: details, or issue references)</footer>
</commit-message>
```

Rules for the parts:

- **type** is one of the allowed types of the Conventional Commits specification.
- **scope** is optional but recommended: the area the change mostly lives in, taken from the repo's own history (`git log`) or its folder layout. Omit it for repo-wide changes. (example) `ui`, `auth`, `db`, `ops`, `api`, `mcp`.
- **description** is required, in the imperative ("add", not "added"), lowercase after `type(scope): `, with no trailing full stop. When the work belongs to a board item, add its reference in brackets at the end, for example `(PRJ-20261016-1456)`.
- **body** is required for any non-trivial change. It explains the problem being solved, the failure mode of the previous code and why this solution is needed, never only which files were changed.
- **footer** is for breaking changes and issue references.

### Example

```xml
<example>
	<header>perf(db): cut the round trips of each transaction and stop leaking connections on reload</header>
	<body>
- Fold the tenant context into the first query
  Each request opened a transaction, ran a configuration statement for the org, then ran the
  query, so a page of five reads paid for ten round trips. The context is now set in the same
  statement batch as the first read, so a read path costs one trip fewer per transaction.

- Release the pool on reload
  A hot reload built a new pool and never closed the old one, so a long session ran out of
  connections. The pool is now kept on the global object and reused, with a test that reloads
  the module twice.
	</body>
</example>
```
