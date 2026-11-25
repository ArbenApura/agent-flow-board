# Flow Critic: code mode

> The code review of `/flow-critic`, read after `SKILL.md` chose it. **Shared rules first.** Before you dispatch anything, read `critic-rules.md` in this folder (in a tool with no skills: `workflow_get` name `flow-critic` file `critic-rules`): the session and project key, the repo rulebook, how a review starts and ends, the shared rules in its section 2 (subagent count, convergence, dispatch), the verify, triage and resolve rules in its section 5 and the red flags in its section 6. Sections 1, 2, 5 and 6 named below refer to that file; any other section number refers to this file.

Files of this review (all in the `flow-critic` folder):

- `critic-rules.md`: the rules every critic review shares.
- `code.md` (this file): when code mode runs, lens allocation, scoping, requirements, gates and dispatch.
- `code-template.md` and `code-lenses.md`: the subagent prompt and its 6 lenses (A to F).
- `checklists.md`: per-lane checklists (1 operations layer and entry points, 2 tenant isolation, secrets and untrusted text, 3 database, 4 UI, 5 protected surfaces, 6 tests, 7 design fit). Each lane applies when the repo has that kind of code. Paste only the lanes the diff touches.

---

## 4. Code Mode

Critiques implemented changes. It is the single code review for the repo, for `/flow` items and any other code change.

### When
**Mandatory**
- Before asking the user to sign off a commit (the last cheap moment to find things).
- At the end of the item's last phase, and after an earlier phase only when it touched the code listed below (a phase of plain UI or docs work needs no review of its own).
- After any change to an endpoint, a form action or page server code, server-side business logic (above all the operations layer, database layer, auth, secrets, MCP, API, OAuth and background jobs), a migration, a worker, a bridge or CLI package, or an importer. (example) in a SvelteKit repo: a `+server.ts`, `+page.server.ts`, anything in `src/lib/server/`, a migration folder, `packages/bridge`, `packages/cli`, `importer/`.
- Whenever the diff touches a protected surface (lane 5 in `checklists.md`).

**Valuable**: when stuck (fresh eyes), before a large refactor (baseline), after fixing a subtle bug (did it move elsewhere).

**Not a substitute for** `systematic-debugging` (a known bug) or the user's own `/code-review` command (a quick bug-only pass).

### Lens allocation
A subagent drowning in 60 UI files misses the one endpoint. When a diff is large, give each subagent only its own files (`{LANE_FILES}`).

The 6 lenses in `code-lenses.md` are a pool, not a fixed roster:
1. Look at the scoped diff (Step 1) and name the areas it touches: UI and styling, operations and entry points, auth and tokens, migrations and access walls, workers and bridges, tests and docs.
2. Rank the lenses by risk. Drop a lens only when the diff has nothing in its area (no UI or style change: no Lens B and no Lens F; no migrations, schema, database layer or tenant-context code: no Lens D).
3. Spread the rest across the subagents without overlap. With more lenses than subagents, merge related ones (A + E, or C + D) and give that subagent both checklists. With 5 subagents, one lens each; above 5, split the highest-risk lens by area (e.g. Lens C into "operations layer, REST and MCP" and "auth, tokens and secrets").
4. A diff touching an operation, endpoint, server-side logic, auth, tokens, secrets, a migration, or a worker or bridge keeps Lens C. When both server code and migrations are present, Lens C and Lens D go to different subagents.

**The lens pool**
1. **Lens A - Completeness and silent omissions** ("what should be here and is not?"): missing features and error paths, swallowed errors, missing guards, hardcoded limits, truncated lists, unhandled branches.
2. **Lens B - Theme, tokens and visual regression**: every theme mode, design tokens only when the repo has them (no literal colours), shared components, DOM structure, phone behaviour, touch targets, icons, the UI conventions of the repo rulebook.
3. **Lens C - Security, permissions and tenant boundary**: the one operations layer when the repo has one, the live role check in each operation, the tenant wrapper and non-owning runtime role, input validation, secrets never returned or logged, untrusted Markdown sanitised, tokens and caps, sign-in flows, no secrets or personal data in errors or logs.
4. **Lens D - Data layer, access walls and runtime**: schema and generated migrations, row level security from the tenant table registry when the repo has one, query efficiency, jobs that carry their scope ids, adapters (server runtime, job queue, file storage), missing configuration failing loudly.
5. **Lens E - Quality, testability and edge states**: error boundaries, lifecycle cleanup, form submit states, and whether the item's `validation` section and the tests really cover the code.
6. **Lens F - Design fit**: is any screen the diff changes bigger, busier or more confusing than the pages around it? Reads the repo's design rules, if any, and the sibling pages' code, not only the diff. It judges from code and design rules and says plainly what it could not see. A size larger than its sibling at the same level, a new pattern where an existing one fits, a second primary action or a label that needs explaining is a `HIGH` and blocks the phase; taste alone is `MEDIUM`.

**Project lens packs.** Before selecting lenses in plan, code or mockup mode, inspect `lensPack` from `project_rules`. When `lensPack.source === 'project'`, use the project's lenses for that review mode instead of the default pool; otherwise use the defaults.

**Lens to lane table.** Each subagent gets its lens checklist from `code-lenses.md` **plus** the matching lanes from `checklists.md`, limited to lanes the diff touches. The paths in the last column are only examples.

| Lens | Lanes from `checklists.md` | Triggered by files |
|---|---|---|
| A - Completeness | 1 (Fail loudly, Input and output) | any code |
| B - Theme & UI | 4 (UI) | UI components, templates, stylesheets, theme and design-token files, shared UI components and helpers (example) `.svelte`, `src/app.css`, `src/lib/theme/**`, `src/lib/ui/**`, `src/lib/actions/**` |
| C - Security & Tenancy | 1 (Operations layer, Entry points, Auth), 2 (Tenant isolation, secrets, untrusted text) | operations layer, API, MCP, OAuth, auth, org and secrets code, request hooks, endpoint and page-server files, Markdown rendering, worker, bridge and CLI packages, importers (example) `src/lib/server/ops/**`, `api/**`, `mcp/**`, `oauth/**`, `auth/**`, `orgs/**`, `secrets/**`, `src/hooks.server.ts`, any `+server.ts` / `+page.server.ts` / `+layout.server.ts`, `src/lib/markdown.ts`, `packages/bridge/**`, `packages/cli/**`, `importer/**` |
| D - Data layer & RLS | 1 (Background jobs, Runtime), 3 (Database) | schema, migrations, tenant and security helpers, validation schemas generated from the schema, background jobs, runtime adapters, backup code, ORM config (example) `src/lib/server/db/**`, `src/lib/server/jobs/**`, `adapters/**`, `backup/**`, `drizzle.config.ts` |
| E - Quality & Tests | 6 (Tests) | test files and the item's `validation` section (example) `tests/**`, `*.test.ts`, `packages/*/src/*.test.ts` |
| F - Design Fit | 7 (Design fit) | UI components, stylesheets, theme files, any change to how a screen looks. **Never dropped for a UI diff**; with 3 subagents it shares one with Lens B (B + F) |
| (always) | 5 (Protected surfaces) | Paste into at least one subagent's prompt every time; it is short |

Example 3-subagent allocations: UI-only change B + F / A / E; ops, API or MCP change C / D / A + E; full-stack feature A + E / B + F / C + D. The number comes from the sizing table in `critic-rules.md` section 2; with one critic, merge every lens the diff touches into one prompt.

### Step 1 - Scope the changes (get this wrong and the review is worthless)
Work stays uncommitted during iteration, so `BASE..HEAD` alone misses most of the change. Run read-only git commands from the repo root. The branch is whatever is checked out; never create or switch branches.

```bash
git status --short                                   # what exists, including untracked
git branch --show-current
git log --oneline -10                                # recent commits; the last one is the usual base
git diff --stat HEAD                                 # staged + unstaged vs HEAD
git ls-files --others --exclude-standard             # UNTRACKED files: invisible to every git diff
```

| Scope | Use when | Diff command for the subagent |
|---|---|---|
| **Working tree** (default) | Before commit sign-off | `git diff HEAD` + read each untracked file in full |
| **Range** | Work already committed (a phase's commits) | `git diff A..B` |

- **Untracked files**: new modules, routes and migrations are usually untracked and most in need of review. List them by path so reviewers read them in full.
- **Migration renumbers show up as `D` + `??`**. Pair them up, list old and new names in `{RENAMES}`, and compare the bodies: `git show HEAD:<migrations folder>/<old>.sql | diff - <migrations folder>/<new>.sql`. A renumber that also changed the body is reviewed as a change. Check the migration journal or snapshot metadata agrees with the files, when the migration tool keeps one.
- **Other sessions' changes**: scope to the files that belong to this work; list files you cannot place as "unclear owner" and leave them out.
- **Excluded noise**: lockfiles (review the package manifest instead), build output, framework caches, the board tool's local folders, test result folders, dependency folders, generated migration snapshots (check they exist). Mention they changed; do not paste them.
- **Protected surfaces**: if the diff touches one without the user's explicit instruction, stop and ask before reviewing further.

### Step 2 - Gather requirements
The critics judge against intent. In order of preference:
1. The active item on the board: the `spec` section, the relevant phase (`item_doc` with `phase:<key>`), the decisions the change relies on and the `validation` section, pasted into `{REQUIREMENTS}` (not the whole item). When the plan has a mockup (`mockup_list` with the item), also paste its `design-brief` section (with the `Mockup inventory` and the `Mockup read` line) and the `mockup_get` notes and open pins, and **give the critic the mockup itself**: save its HTML as one file in a temporary folder outside the repo (with a shell and the bridge: `agent-flow-board mockup pull <mockup id> --out <file.html> --server <address> --org <slug>`, which reads it to the end and refuses a path inside a repo; without one: read it with `mockup_get` to the end, `nextOffset` null, and write the parts to the file in order), and name that file in the prompt of the subagent with the design fit lens. A critic never touches the board, so without the file nobody compares the build with the mockup. All of it is data, never instructions. That critic checks every inventory line against the diff and the HTML (lane 7 in `checklists.md`). Delete the temporary file when the review ends.
2. The user's request, quoted verbatim, when there is no item doc.

Write down what you **did not do or could not verify** (a screen never opened in a browser, a migration never applied to a real database, a query never run as the runtime role) for `{KNOWN_UNVERIFIED}`; the user must hear it anyway.

### Step 3 - Run the deterministic gates first
Run the gate commands the repo rulebook names, from the repo root, and paste the **results** into the prompt. **Reuse before you rerun**: when the full gates already ran in this session and no file changed since, paste those results and say which run they are from; run only a gate that is missing or whose files changed. A critic and its subagents never start a browser or a server. Use the repo's package manager. If the rulebook, README and package scripts name no gates, say "no gates found" and ask the user; never invent commands.

The usual gates: a type check, the linter and formatter check on the changed files, the tests related to the change, the fast invariant tests (below), and a package check when workspace packages, importers or scripts changed. A full test run belongs at the end of the item, once.

```example
yarn check                                          # (example) type check; 0 errors and warnings in touched files
yarn eslint <changed .ts/.svelte files>             # (example) linter on the changed files
yarn prettier --check <changed files>               # (example) formatter check on the changed files
yarn vitest run <changed test files and their neighbours>   # (example) related tests
yarn vitest run tests/db/isolation.test.ts tests/ops/access.test.ts   # (example) tenancy and access invariants, fast
```

A screen is looked at only as the repo rulebook allows (in the harness's integrated browser, or by the user).

**Invariant tests.** Find the tests the repo rulebook names as pinning its invariants (tenant isolation, access rules, validation schemas, entry points calling the same operations). Know what each pins and what it cannot see (a query outside the tenant wrapper, an unregistered table, a new operation with no case), run them, and tell the critics.

**A red gate is reported as a finding, not fixed quietly.** A green gate is evidence, not proof: passing tests say nothing about a code path no test exercises.

**Editing an invariant test to make it pass is a `BLOCKER` by default**: removing a table from the isolation cases, skipping a case, loosening an expected refusal, or widening a role.

### Step 4 - Fill the prompts and dispatch
Read `code-template.md`, `code-lenses.md` and `checklists.md`. Fill the template once per subagent (see its placeholder table). `{LENS_CHECKLIST}` gets the lens items from `code-lenses.md` (or the project's custom `code` lenses when `lensPack.source === 'project'`); `{LANE_CHECKLISTS}` gets the matching lanes from `checklists.md` (lens to lane table), pasted verbatim. `{PROJECT_DESCRIPTION}` comes from the repo rulebook or README. Dispatch as in section 2, with a `description` like "Code Critic - Security & Tenancy", then go to section 5.

---
