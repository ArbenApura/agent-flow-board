# Implementation Critique Review Lenses

The pool of 6 inspection checklists for code mode critics. 3 subagents are dispatched by default, whatever the diff size (or the number the user asks for), and the lenses are spread across them (merged when fewer are asked for); see `SKILL.md` section 4. When `project_rules` returns `lensPack.source === 'project'`, use the project's custom `code` lenses instead. Each subagent also gets the matching lanes from `checklists.md` (lens to lane table in `SKILL.md` section 4); the lanes carry the stack-specific rules and paths behind these items. An "Applies when ..." line: if false for this repo, mark the item "not applicable" with that reason instead of raising a finding. An (example) line is one stack's illustration; take real names from the repo rulebook (CLAUDE.md, AGENTS.md, README).

---

## Lens A - Completeness & Silent Omissions Auditor

Inspect for omitted logic and silent failure modes:

- [ ] **Omitted Requirements from the plan's steps and spec**: did the implementation skip any acceptance criteria, edge-case handlers or sub-tasks of the plan?
- [ ] **Swallowed Errors & Empty Catch Blocks**: any try/catch that swallows exceptions without logging, returning a typed error or telling the person? (example) returning an `OpError`.
- [ ] **Missing Guard Clauses & Null Checks**: optional properties or array lookups used without a null check and handling of the missing case? Where the language is strict, any untyped escape hatch, unchecked `null` or `undefined`, or suppression comment without a written reason is a finding. (example) TypeScript strict: `any`, `@ts-ignore` without a reason.
- [ ] **Missing Config Fails Loudly**: on an auth, token, tenant or secret path, does a missing env var, database URL, client secret, adapter or lookup result throw or deny? Flag any invented default that lets the call through (checklists Lane 1 "Fail loudly"). (example) `BACKUP_KEY`, `?? true`, `if (key && ...)`, `catch { return allow }`.
- [ ] **Silent Data Truncation**: queries or API responses bounded by hardcoded limits that drop records without pagination or a count? (example) `limit(20)`.
- [ ] **Unhandled Promise Rejections & Unawaited Calls**: missing `await` in transactional flows (a write, a queued job, an external call, an email)? Anything load-bearing fire-and-forget?
- [ ] **State Tear-Down & Memory Leaks**: do components, long-lived hubs, supervisors and helper processes clean up listeners, timers, intervals, subscriptions, child processes and temp files on unmount or stop? (example) `src/lib/server/realtime/hub.ts`.
- [ ] **Entry Points Kept in Step**: if a shared operation changed, did every entry point that calls it (web action, API route and its spec, agent tool, CLI) change too, or is the difference deliberate? Applies when one operation layer serves several entry points. (example) web action, `/api/v1` route, MCP tool and CLI.

---

## Lens B - Theme, Tokens & Visual Regression Inspector

Inspect UI and styling against the repo's design rules:

- [ ] **Colours Are Tokens Only**: every colour comes from the repo's design tokens; no literal colour values in a component; the repo's literal-colour lint rule passes. Applies when the repo has design tokens. (example) CSS variables from `src/lib/theme/`; no `#hex`, `rgb()`, `bg-white`, `bg-[#...]`; `afb/no-literal-colours` passes.
- [ ] **Theme Modes Work Without Variant Hacks**: right in every theme mode? Do portals and popovers carry the mode onto their own root? Is a status shown with the accent, or the accent used for a status? Does text on a tinted surface use the matching ink token? Applies when the repo has more than one theme mode. (example) `data-mode` on `<html>`, no `dark:` variant.
- [ ] **Styling Convention, No Style Blocks**: does the diff follow the repo's styling convention, without conflicting overrides? Applies when the rulebook sets one. (example) Tailwind on the element, zero `<style>` blocks, inline `style=""` only for a multi-stop gradient or runtime coordinates.
- [ ] **Reuse the Component Library**: a second kind of dialog, tab bar, card, select or toast where the repo's components exist? Applies when the repo has a component library. (example) `ConfirmDialog`, `Select` in `src/lib/ui/`.
- [ ] **Framework State Primitives Only**: does new local state use the primitives the framework and rulebook call for, with form-sync effects guarded against loops? Applies when the repo uses a reactive UI framework with a state rulebook. (example) Svelte 5 runes only; `$effect` form syncs use `untrack()` and a previous-value guard.
- [ ] **Modals, Lists and Clickables**: do modals, keyed lists and clickables follow the repo's conventions (open-state mounting, focus trap, scroll lock, data kept through the close transition, unique keys, cursor and disabled styling)? Applies when the rulebook sets component conventions. (example) modals mount with `open={boolean}` (not in `{#if}`) with `focusTrap` and `scrollLock`; every clickable has `cursor-pointer`.
- [ ] **Icons, Alt Text, Fonts**: icons from the repo's one icon set, alt text on every image, only the fonts the design rules name? Applies when the repo has such design rules. (example) icons from `phosphor-svelte/lib/*`; the fonts of `DESIGN.md`.
- [ ] **Touch Targets & Phone**: tap areas at least 44 by 44 px; nothing scrolls sideways at phone width; sideways rows (tabs, chips) follow the repo's scroll-row recipe if it has one. (example) the scroll-row recipe of the root `CLAUDE.md`.

---

## Lens C - Security, Permissions & Tenant Boundary Auditor

Inspect operations, endpoints, tools and data mutations:

- [ ] **One Operations Layer**: does every web action, route, agent tool and CLI command call the shared operation, with no copy of the rules and no direct table access (checklists Lane 1)? Applies when one operations layer serves several entry points. (example) a verb in `src/lib/server/ops/`.
- [ ] **Live Role Check Inside the Operation, Before the First Side Effect**: does the operation check the caller's CURRENT role (and token caps and project limits) inside its own transaction, before it reads private data, writes, queues a job, sends mail or calls an external service? Is any role trusted from a session, a request field or an earlier check? Applies when the repo has roles, permissions or token scopes.
- [ ] **Tenant Context and the Restricted Role**: does every tenant query run inside the tenant context, connected as the restricted runtime role, never the owner role from request code? Is an id validated before use and never put in SQL text? Is any new table registered with the tenant registry (checklists Lane 2)? Applies when the repo is multi-tenant or uses row-level security. (example) `withTenant`, the `app_runtime` role, `tenantTable`.
- [ ] **Schema Validation From the Data Model**: are request bodies, form actions, query params and tool inputs parsed with schemas before use, with bounded numbers and lengths, ideally generated from the data model? (example) Zod schemas generated in `src/lib/server/db/zod.ts`.
- [ ] **Secrets Never Returned or Logged**: could a password, token, key, device code, master key, sealed value or hash leave through a response, agent tool reply, page load, export or backup, log line, activity event or error message? Are project secrets sealed only through the repo's one vault? Applies when the repo stores secrets. (example) `src/lib/server/backup/archive.ts`.
- [ ] **Untrusted Guest Text Sanitised**: is all Markdown rendered via the repo's one sanitising renderer (no raw HTML, safe schemes, no images from guests)? Is guest text escaped for emails, external-service text, filenames and shell arguments? Any raw HTML insertion outside that renderer? Applies when the repo renders text written by guests or other untrusted people. (example) `src/lib/markdown.ts`, and `{@html}` only on its output.
- [ ] **Auth, Tokens, OAuth**: are sessions, lockout, rate limits, verification, device sign-in, redirect targets, token hashing and expiry, PKCE and `redirect_uri` checks intact? Are secrets compared in constant time? Applies when the diff touches authentication. (example) Better Auth.
- [ ] **Information Leakage in Error Responses**: typed errors with a plain message, not raw database errors, stack traces or internal paths? (example) `OpError`.
- [ ] **Runner, Bridge & CLI Trust Boundary**: does each helper process act only through the public API with its own token, run checks read-only against a local build, and clean up after itself? Does a thin forwarder stay thin, never print or store a token outside its store, and replay its queue through server rules (checklists Lane 1)? Applies when the repo ships a runner, bridge or CLI. (example) the runner on `/api/v1`, the bridge forwarding to `/mcp`.
- [ ] **Protected Surfaces Untouched**: does the diff edit an applied migration, hand-patch generated security SQL, rename a technical id, or change a published protocol without the user's instruction? Any hit is a `BLOCKER` (checklists Lane 5). Applies when the rulebook lists protected surfaces.

---

## Lens D - Data Layer, RLS & Runtime Inspector

Inspect the schema, migrations, jobs and database interactions:

- [ ] **Forced RLS From the Registry**: is every new tenant table defined through the registry that generates forced row-level security, grants and policies, with an org column (and a project column for project scoped data), and covered by the isolation test? Applies when the repo uses row-level security. (example) `tenantTable` so `db/security.ts` generates the policies; `tests/db/isolation.test.ts`.
- [ ] **Migration From the Generator**: generated from the schema change, committed with its snapshot and journal entry, numbered after the existing ones, free of hand edits, every already-applied migration unedited? Does every `UPDATE`/`DELETE`/backfill have a stated `WHERE` and row count (checklists Lane 3)? Applies when the repo has a schema with migrations. (example) a Drizzle repo: `yarn db:generate`.
- [ ] **Constraints & Inserts**: NOT NULL columns, foreign keys and delete rules explicit, and does every insert (operations, seed, importer, test support) supply every required column? (example) verbs, `db/seed.ts`, the importer, test support.
- [ ] **Background Jobs Carry Scope Ids**: does each job payload carry the scope ids it needs and set the tenant context before its first query? Is the job idempotent under retry (a queue and an in-memory test runner may differ) (checklists Lane 1 "Background jobs")? Applies when the repo runs background jobs. (example) org and project ids; pg-boss versus the memory runner.
- [ ] **Runtime & Adapters**: does the code keep to the runtime the repo targets, with runtime-only code in the server, scripts and tests? Is configuration for each adapter required loudly? Applies when the repo targets one fixed runtime. (example) the Node server: `adapters/`.
- [ ] **N+1 Query Hazards & Index Use**: no repeated single-record queries inside loops? Do new filters and sorts have an index? Atomic counter instead of `max()+1`? (example) the per-project counter in `db/numbering.ts`.
- [ ] **Connections & Slow Calls**: transactions short, with no slow external call (external service, email, storage upload) inside an open tenant transaction?
- [ ] **Backup & Restore**: do backup and restore still cover the new table and refuse a dump of another shape loudly? Applies when the repo has backup or restore code. (example) `src/lib/server/backup/`.

---

## Lens E - Quality, Testability & Edge State Verification

Inspect test coverage, error handling and component resilience:

- [ ] **Alignment with the validation section**: do the checks in the item's `validation` section verify the implemented behaviour? Are tests in the folder the repo's layout expects? (example) `tests/ops`, `tests/db`, `tests/auth`, `tests/mcp`, `tests/checks`, `packages/*/src`.
- [ ] **Refusals Prove No Side Effect**: do access and isolation tests cover each role and a limited token, and assert nothing was written, queued or sent behind a refusal? Applies when the repo has roles or token scopes.
- [ ] **Zero-Jump Loading UI**: do loading states render placeholders of the final shape so nothing jumps? Applies when the diff adds or changes a screen. (example) `RouteSkeleton`, `Skeleton`, `#afb-boot`.
- [ ] **Form State Transitions & Button Debouncing**: submit buttons disabled during in-flight submissions? Do writes carry a request id where agents or retries can repeat them? (example) `requestId`.
- [ ] **Empty, Error and Permission-Denied States**: empty lists, zero-result searches, server errors and a role without access rendered with clear guidance? Applies when the diff adds or changes a screen. (example) `EmptyState`, `ErrorState`, `PermissionDenied`.
- [ ] **Type Safety & Strictness**: explicit types, no untyped escape hatches, double casts or suppression comments without a reason? Applies when the repo uses a typed language in strict mode. (example) TypeScript: no `any`, no `as unknown as Type`, no `@ts-ignore` without a reason.

---

## Lens F - Design Fit Reviewer

Generated screens often come out bigger, busier or more confusing than the pages around them. Judge from the code and say plainly what you could not see. Read the repo's design rules if it has any (the rulebook's design list, a design document, a size scale, design notes for the coding assistant) and the code of the sibling pages the screen sits next to. Judge the screen the code builds, not only the diff. With no design rules, compare against the sibling pages only.
(example) the root `CLAUDE.md` "Design fit" list, `DESIGN.md`, `.claude/skills/coding-guidelines/design-fit.md`, `tests/ui-shots/scale.json`; the user checks screens on the local dev server at port 7173.

- [ ] **Say what could not be seen, or refuse `APPROVED` if mockup evidence is missing**: name the screens the diff changes and say plainly that no picture was looked at (a critic never drives a browser; the lead may have looked in the harness's integrated browser and says what it saw under `{KNOWN_UNVERIFIED}`).
- [ ] **Nothing larger than its neighbours**: for each changed screen, in the classes it sets for desktop and phone widths and both modes, is any title, section heading, button, field, card, row, picture or icon larger than the same level on the sibling pages? Compare the classes with the sibling's at the same level; a larger one is a `HIGH` with both values, unless it is a different kind of control or a state the sibling does not have (say why). A size that existed before the change is not introduced by it.
- [ ] **No new size or pattern where an existing one fits**: a value outside the repo's size scale, or a second kind of dialog, tab bar, card or button style where a component or sibling page has one, is a `HIGH`. Applies when the repo has a size scale or component library. (example) `tests/ui-shots/scale.json` and `src/lib/ui/`.
- [ ] **One primary action, and plain words**: one primary button per view, everything else a plain button or link; labels and headings understood without help; every form field states its own font size, shared by its labels and submit button; a money or limit answer shows a live worked example. A confusing label or a second primary action is a `HIGH`. (example) `button-primary`.
- [ ] **Pictures stay small**: an illustration larger than about 12% of the first screen on desktop, or one that pushes the first action down, is a `HIGH`.
- [ ] **First screen density**: more elements in the first screen than the sibling pages (counted from the classes and markup) is a `HIGH`; well above is `MEDIUM`.
- [ ] **Phone**: no sideways scrolling, readable text and controls, tap targets at least 44 px, nothing hidden that desktop shows without a way to reach it.
- [ ] **Both modes**: every theme mode looks right: colours from the tokens, nothing washed out, every text and surface pair readable (AA). The accent never carries a status. Applies when the repo has more than one theme mode.
- [ ] **Taste is advisory**: spacing or colour preferences with no measurement are `MEDIUM` at most and never block. Only a measured size larger than its sibling, a new pattern or a confusing label blocks.
