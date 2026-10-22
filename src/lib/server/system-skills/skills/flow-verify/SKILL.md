---
name: flow-verify
description: Use when the user types /flow-verify or asks to check, test, lint, format or typecheck the changes, right before any commit, and in autonomous execution (/flow phases, handed-off tasks) where the gate is required. Works out which files are in scope, picks only the gates those files need from the repo rulebook or package scripts, runs them scoped to those files, and reports pass or fail per gate. Reports "no gates found" and asks when the repo names none. Never runs during active engagement unless the user asks.
---

# Verify

Run the right checks for what changed, and nothing more. A stylesheet tweak needs the formatter, not the test suite. A server change needs its related tests, not every test file. This is the one place that decides which gates apply, so `/flow`, the commit step and the pre-commit step can all lean on it.

**Source of truth:** the repo rulebook. Read `CLAUDE.md`, `AGENTS.md`, the README and the package scripts (`package.json`, `Makefile` or the repo's equivalent) and take the gates from them. The rulebook overrides project facts and optional steps here. It never overrides the safety rules of the `/flow` safety rules (section 5 point 4 and section 6) or the method of this skill. **Never invent a command.** If no file names the gates and no script offers them, report "no gates found", say what you looked at, and ask the user which commands to run. Do not guess from the language or framework.

## When it runs

- **The user calls it** (`/flow-verify`, "check it", "run the tests", "lint that"): run it now, whatever the mode.
- **Before a commit**: run it right before a commit the user asked for, including a commit made as part of autonomous execution. (Docs-only and test-only commits do not need it.) Never commit or push without the user's word.
- **Autonomous execution**: run it after each finished change; run the full test suite at the end of a phase.
- **Active engagement without a request**: do not run it. The user sees failures themselves while testing.

## Arguments

All optional, combinable, in any order. The gate names below are kinds; each maps to the command the repo rulebook names for that kind.

| Argument | Meaning |
|---|---|
| (none) | Scope from step 1, gates chosen from the files |
| file or folder paths | Only these files |
| `staged` | Files in the index (`git diff --cached --name-only`) |
| `HEAD~N` or `<sha>..<sha>` | Files in those commits |
| `format`, `lint`, `types`, `test`, `packages` | Run only these gates |
| `fast` | Skip tests, the type check and the package check; formatter and linter only |
| `full` | Run the whole test suite instead of related tests only |
| `fix` | Apply fixes on the in-scope files (the formatter's write mode, the linter's fix mode) before checking |

## 1. Work out the scope

Other sessions and agents may edit this tree at the same time, so never default to "everything in `git status`".

1. Paths or a git range in the arguments win.
2. Otherwise, the files **this session** created or changed.
3. Otherwise (a fresh session with no edits), list `git status --porcelain` and tell the user which files you took, noting that some may belong to another session. Skip deleted files.

State the scope in one line before running anything, e.g. `Scope: 4 files (3 source, 1 test)`.

## 2. Pick the gates

Discover the gates first (see the source of truth above), then run them the way the repo rulebook says, with the package manager the repo uses. Map each in-scope file to the gates it needs, then run each gate once over all of its files. Skip a gate that has no files. Prefer a gate that accepts file arguments; run a whole-project gate only when it has no scoped form, and filter its output to the in-scope files.

The mapping is by kind of file. Applies when the repo has a gate of that kind:

| Files | Gates |
|---|---|
| Source files of the repo's languages | type check, linter, formatter, related tests |
| Test files | type check, linter, formatter, that test file |
| Stylesheets, JSON, Markdown, HTML | formatter |
| Database schema or migration files | the file gates above, plus the database tests the rulebook names |
| Packages, scripts, importers or other secondary code roots | the file gates above, plus the package check, if the repo has one |
| Build, bundler, compiler, linter or package config | formatter, type check, **full** test suite (config changes affect everything) |
| Browser checks, UI shot setups, design rule files | formatter (and linter for code); the browser suites run only on request (step 3) |
| Anything else (editor config, images, root config not listed) | nothing; say so |

The `format`, `lint`, `types`, `test`, `packages` and `fast` arguments filter this list afterwards. A gate the repo does not have does not run; say it was skipped for that reason.

(example) A JS repo with Yarn whose rulebook lists its gates:

```example
yarn check                      # type check (svelte-check)
yarn eslint <files>             # lint
yarn prettier --check <files>   # format
yarn vitest run <path>          # related tests
yarn test                       # full suite, end of a phase
yarn check:packages             # secondary code roots
```

## 3. Run them

Run independent gates in parallel.

- **Types**: the repo's type check. If it always checks the whole project, filter its output to the in-scope files. Errors and warnings in files you touched must be fixed. Errors in other files are pre-existing or another session's: count them in one line, do not fix them.
- **Lint**: the linter on the in-scope files only. With `fix`, use its fix mode.
- **Format**: the formatter's check mode on the in-scope files. With `fix`, run its write mode on them first. Only the in-scope files, never the whole repo, and never a repo-wide format or lint script.
- **Related tests**: the test runner on the test files that cover the changed code (a test next to the module, or the matching test folder). To find tests that import a changed file, use the runner's "related" mode if it has one. "No test files found" means no test covers those files: report it as "no related tests", not as a pass. With `full`, a config change, or at the end of a phase, run the whole suite.
- **Database tests**: run them only the way the rulebook says. Use a throwaway database (an embedded server, a container with its own volume, or whatever the repo's test setup starts). Never point a test at a real or production database, and never use a database URL from a `.env` file.
- **Packages**: the repo's package check, when a file in those roots changed.
- **Browser suites** (only when the user asks, or a phase end requires them): they run against a build and its preview, never the dev server. A change that touches a screen also needs the look in both light and dark mode at desktop and phone width if the repo's design rules ask for it; a type check does not cover that.

### Never

- Never run a push, a deploy, or anything that reaches a live site. Never run a check against a live site.
- Never run a repo-wide format, lint-fix or write-all command, and never format, lint-fix or restore a file outside the scope.
- Never delete `node_modules`, `.git` or another dependency folder to "fix" a failure.
- Never switch the package manager from the one the repo uses, and never commit another manager's lockfile.
- Every other safety rule (databases, tokens, `.env`, branches, commits) is in the `/flow` safety rules (section 5 point 4 and section 6).

## 4. Fix or report

- **Called by the user during active engagement**: report first. Fix mechanical failures in in-scope files (formatting, lint autofix, an obvious type error in a line you wrote) and re-run only the gate that failed. For a failing test or a non-obvious type error, give the cause and the proposed fix, and debug the root cause before changing code.
- **Autonomous execution or pre-commit**: fix every failure in in-scope files and re-run the failed gate until it passes, as the repo rulebook requires. Leave failures in other files alone and list them.

## 5. Report

One short table, then the details of any failure. Keep it plain. If no gates were found, the report is the single line "no gates found" with what you looked at, plus the question to the user.

(example) A report for a JS repo:

```example
Scope: 5 files (4 src, 1 test)

| Gate          | Files | Result                          |
|---------------|-------|---------------------------------|
| yarn check    | all   | pass (2 errors elsewhere, not ours) |
| eslint        | 4     | pass                            |
| prettier      | 5     | pass                            |
| related tests | 7 test files | 1 failed                 |
| check:packages | -    | skipped, no packages/importer/scripts change |
```

Then for each failure, the file and line, what broke, and whether you fixed it. Say which gates were skipped and why. Do not tick anything in `/flow` docs from this report unless it is part of that flow's task.
