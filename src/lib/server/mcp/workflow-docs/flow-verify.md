# Verify

Run the right checks for what changed, and nothing more. A CSS tweak needs prettier, not the test suite. A server change needs its related tests, not every test file. This is the one place that decides which gates apply, so `/flow`, `/conventional-commit` (autonomous) and the pre-commit step can all lean on it.

**Source of truth:** the "The gates" section of the repo `CLAUDE.md` (`C:\Users\Admin\Desktop\agent-flow-board\CLAUDE.md`). If this skill and that section ever disagree, `CLAUDE.md` wins; fix this file.

## When it runs

- **The user calls it** (`/flow-verify`, "check it", "run the tests", "lint that"): run it now, whatever the mode.
- **Before a commit**: always run it right before `git commit`, including the commit made by `/conventional-commit` when it is part of autonomous execution. (Docs-only and test-only commits do not need it.)
- **Autonomous execution**: run it after each finished change; run the full `yarn test` at the end of a phase.
- **Active engagement without a request**: do not run it. The user sees failures themselves while testing.

## Arguments

All optional, combinable, in any order.

| Argument | Meaning |
|---|---|
| (none) | Scope from step 1, gates chosen from the files |
| file or folder paths | Only these files |
| `staged` | Files in the index (`git diff --cached --name-only`) |
| `HEAD~N` or `<sha>..<sha>` | Files in those commits |
| `format`, `lint`, `types`, `test`, `packages` | Run only these gates |
| `fast` | Skip tests, `yarn check` and `check:packages`; prettier and eslint only |
| `full` | Run the whole `yarn test` instead of related tests only |
| `fix` | Apply fixes on the in-scope files (`yarn prettier --write`, `yarn eslint --fix`) before checking |

## 1. Work out the scope

Other sessions and agents may edit this tree at the same time, so never default to "everything in `git status`".

1. Paths or a git range in the arguments win.
2. Otherwise, the files **this session** created or changed.
3. Otherwise (a fresh session with no edits), list `git status --porcelain` and tell the user which files you took, noting that some may belong to another session. Skip deleted files.

State the scope in one line before running anything, e.g. `Scope: 4 files (3 src, 1 test)`.

## 2. Pick the gates

All commands run from the repo root with Yarn 4 (never `npm` or `pnpm`). Map each in-scope file to its gates, then run each gate once over all of its files. Skip a gate that has no files.

| Files | Gates |
|---|---|
| `src/**/*.svelte`, `*.ts`, `*.js` | `yarn check`, eslint, prettier, related tests |
| `**/*.test.ts` | `yarn check`, eslint, prettier, that test file |
| `*.css`, `*.json`, `*.md`, `*.html` | prettier |
| `src/lib/server/db/schema/**` or `migrations/**` | `yarn check`, eslint, prettier, `yarn vitest run tests/db` (and any `tests/ops` or `tests/auth` test that touches the changed tables) |
| `packages/**`, `importer/**`, `scripts/**` | the file gates above, plus `yarn check:packages` |
| `package.json`, `vite.config.ts`, `svelte.config.js`, `tsconfig.json`, `eslint.config.js`, `eslint-rules/**` | prettier, `yarn check`, **full** `yarn test` (config changes affect everything) |
| `tests/checks/**`, `tests/ui-shots/**`, `DESIGN.md` | prettier (and eslint for `.ts`); the browser suites run only on request (step 3) |
| Anything else (`.claude/`, images, root config not listed) | nothing; say so |

The `format`, `lint`, `types`, `test`, `packages` and `fast` arguments filter this list afterwards. AFB has no SQL test files, no `py_compile` and no `deno check` gates, so none of those run.

## 3. Run them

Run independent gates in parallel.

- **Types**: `yarn check` (svelte-kit sync plus svelte-check). It always checks the whole project, so filter its output to the in-scope files. Errors and warnings in files you touched must be fixed. Errors in other files are pre-existing or another session's: count them in one line, do not fix them.
- **ESLint**: `yarn eslint <files>` (`.svelte`, `.ts`, `.js` only). With `fix`, add `--fix`. This includes `afb/no-literal-colours`.
- **Prettier**: `yarn prettier --check <files>`. With `fix`, `yarn prettier --write <files>` first. Only the in-scope files, never `.`, and never `yarn format` or `yarn lint` (both run repo-wide).
- **Related tests**: `yarn vitest run <path>` for the test files that cover the changed code (a test next to the module, or the matching folder under `tests/`). Vitest picks up `src/**`, `packages/**`, `importer/**` and `tests/{unit,db,auth,ops,mcp}` (see `vite.config.ts`). To find tests that import a changed file, use `yarn vitest related --run <files>`. "No test files found" means no test covers those files: report it as "no related tests", not as a pass. With `full`, a config change, or at the end of a phase, run `yarn test`.
- **Database tests**: they need no installed or remote Postgres. `tests/support/globalSetup.ts` starts one embedded real PostgreSQL server for the run (package `embedded-postgres`, random free port, temp data dir, non-superuser owner plus a separate `app_runtime` login, migrations applied once by `src/lib/server/db/migrate.ts` into a template database), and `makePostgres` in `tests/support/db.ts` gives each test file a fresh clone of it. Just run `yarn vitest run tests/db` (or the ops, auth or mcp folder). The first embedded server start can be slow (`hookTimeout` is 180 s). Never point a test at a real or production database.
- **Packages**: `yarn check:packages` (tsc on `packages/runner`, `importer`, `scripts`) when any file there changed.
- **Browser suites** (only when the user asks, or a phase end requires them): they run against `yarn build && yarn preview`, never the dev server (ADR-017). `yarn test:checks` runs `tests/checks/` (Playwright). `yarn ui-shots` runs the UI shots for the plan's "UI changes" table. A change that touches a screen also needs the design-fit look in both modes at 1440 and 390 wide (CLAUDE.md "Design fit", item 9); a type check does not cover that.

### Never

- Never run `git push`, a deploy (Docker, a server), or anything that reaches a live site. Never run a check against the live site.
- Never run `yarn format`, `yarn lint` or `prettier --write .`, and never format, lint-fix or restore a file outside the scope.
- Never delete `node_modules` or `.git` to "fix" a failure.
- Never run, suggest or plan `yarn db:local:reset`, `docker compose down -v` or anything else that empties the local Docker PostgreSQL on 5433: it holds the real flow plans.
- Never use `npm` or `pnpm`, and never commit `package-lock.json` or `pnpm-lock.yaml`.

## 4. Fix or report

- **Called by the user during active engagement**: report first. Fix mechanical failures in in-scope files (formatting, lint autofix, an obvious type error in a line you wrote) and re-run only the gate that failed. For a failing test or a non-obvious type error, give the cause and the proposed fix, and debug the root cause before changing code.
- **Autonomous execution or pre-commit**: fix every failure in in-scope files and re-run the failed gate until it passes, as `CLAUDE.md` requires. Leave failures in other files alone and list them.

## 5. Report

One short table, then the details of any failure. Keep it plain.

```
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
