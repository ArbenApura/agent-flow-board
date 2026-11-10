# Implementation Critique Review Lenses

This document contains the pool of 6 specialized inspection checklists used by flow-critic subagents in code mode during post-implementation review. 3 subagents are dispatched by default, whatever the size of the diff (the number the user asks for otherwise), and the relevant lenses are distributed across them (merging lenses when fewer are asked for); see `SKILL.md` section 4 (Code mode). Each subagent also gets the matching lanes from `checklists.md` (the lens to lane table in `SKILL.md` section 4); the lanes carry the stack-specific rules and file paths behind these items. Some items only apply to certain stacks. Each of those carries an "Applies when ..." line: if the trigger is false for this repo, mark the item "not applicable" with that reason instead of raising a finding. A line marked (example) shows what the item looks like in one stack; read it as an illustration, and use the repo rulebook (CLAUDE.md, AGENTS.md, README) for the real names.

---

## Lens A - Completeness & Silent Omissions Auditor

Inspect the codebase for omitted logic and silent failure modes:

- [ ] **Omitted Requirements from the plan's steps and spec**
  Did the implementation skip any acceptance criteria, edge-case handlers, or sub-tasks outlined in the plan?
- [ ] **Swallowed Errors & Empty Catch Blocks**
  Are there try/catch blocks that silently swallow exceptions without logging, returning a typed error, or telling the person?
  (example) returning an `OpError`.
- [ ] **Missing Guard Clauses & Null Checks**
  Are optional properties or array lookups accessed without a null check and handling of the missing case? Where the language is strict, any untyped escape hatch, unchecked `null` or `undefined`, or suppression comment without a written reason is a finding.
  (example) TypeScript strict: `any`, `@ts-ignore` without a reason.
- [ ] **Missing Config Fails Loudly**
  On an auth, token, tenant or secret path, does a missing env var, database URL, client secret, adapter or lookup result throw or deny? Flag any invented default that lets the call through. (checklists Lane 1 "Fail loudly")
  (example) `AFB_MASTER_KEY`, `?? true`, `if (key && ...)`, `catch { return allow }`.
- [ ] **Silent Data Truncation**
  Are queries or API responses bounded by hardcoded limits that silently drop records without pagination or a count?
  (example) `limit(20)`.
- [ ] **Unhandled Promise Rejections & Unawaited Calls**
  Are asynchronous operations missing `await` in transactional flows (a write, a queued job, an external call, an email)? Does anything load-bearing run fire-and-forget?
- [ ] **State Tear-Down & Memory Leaks**
  Do components, long-lived hubs, supervisors and helper processes clean up listeners, timers, intervals, subscriptions, child processes and temp files on unmount or stop?
  (example) the realtime hub in `src/lib/server/realtime/hub.ts`, the runner supervisor and the bridge.
- [ ] **Entry Points Kept in Step**
  If a shared operation changed, did every entry point that calls it (web action, API route and its spec, agent tool, CLI) change too, or is the difference deliberate?
  Applies when the repo has one operation layer behind several entry points.
  (example) the verb's web action, `/api/v1` route, OpenAPI entry, MCP tool and CLI.

---

## Lens B - Theme, Tokens & Visual Regression Inspector

Inspect UI and styling for strict adherence to the repo's design rules:

- [ ] **Colours Are Tokens Only**
  Every colour comes from the repo's design tokens. No literal colour values in a component, and the repo's lint rule for literal colours passes.
  Applies when the repo has design tokens.
  (example) CSS variables from `src/lib/theme/` (`--bg --surface --raised --ink --muted --line --accent --accent-ink --accent-soft --accent-text`, fixed `--danger --warning --success --info`); no `#hex`, `rgb()`, `hsl()`, `bg-white`, `text-black` or `bg-[#...]`; `afb/no-literal-colours` passes.
- [ ] **Theme Modes Work Without Variant Hacks**
  Does the screen look right in every theme mode the repo has? Do portals and popovers carry the mode onto their own root? Is a status ever shown with the accent, or the accent used for a status? Does text on a tinted surface use the matching ink token?
  Applies when the repo has more than one theme mode.
  (example) the mode is `data-mode` on `<html>`, a token changes with it, and there is no `dark:` variant.
- [ ] **Styling Convention, No Style Blocks**
  Does the diff follow the repo's styling convention, without conflicting overrides?
  Applies when the repo rulebook sets a styling convention.
  (example) Tailwind on the element, zero `<style>` blocks, no component-level CSS variables, inline `style=""` only for a multi-stop gradient or runtime coordinates, with an UPPERCASE comment.
- [ ] **Reuse the Component Library**
  Does the diff build a second kind of dialog, tab bar, card, select or toast where the repo's components already exist?
  Applies when the repo has a component library.
  (example) `ResponsiveModal`, `ConfirmDialog`, `SegmentedControl`, `Card`, `Select` in `src/lib/ui/`.
- [ ] **Framework State Primitives Only**
  Does new local state use the primitives the repo's framework and rulebook call for, with effects that sync form state guarded against loops?
  Applies when the repo uses a reactive UI framework with a rulebook on state.
  (example) Svelte 5 runes only: no `export let`, no `$:`, no stores for new local state; `$effect` form syncs use `untrack()` and a previous-value guard.
- [ ] **Modals, Lists and Clickables**
  Do modals, keyed lists and clickable elements follow the repo's conventions (open-state mounting, focus trap, scroll lock, data kept through the close transition, unique keys, cursor and disabled styling)?
  Applies when the repo rulebook sets component conventions.
  (example) modals mount with `open={boolean}` (not in `{#if}`), snippets for header and footer, `focusTrap` and `scrollLock`; keyed `{#each}` uses ids; every clickable has `cursor-pointer` (and `disabled:cursor-not-allowed`).
- [ ] **Icons, Alt Text, Fonts**
  Do icons come from the repo's one icon set, does every image have alt text, and does type use only the fonts the repo's design rules name?
  Applies when the repo has design rules for icons or fonts.
  (example) icons from `phosphor-svelte/lib/*`; fonts of `DESIGN.md` (Poppins, Bricolage Grotesque, Geist Mono for ids and code) through the tokens and `src/app.css`.
- [ ] **Touch Targets & Phone**
  Tap areas at least 44 by 44 px; nothing scrolls sideways at phone width; sideways rows (tabs, chips) follow the repo's scroll-row recipe if it has one.
  (example) the scroll-row recipe of the root `CLAUDE.md`.

---

## Lens C - Security, Permissions & Tenant Boundary Auditor

Inspect operations, endpoints, tools and data mutations for security:

- [ ] **One Operations Layer**
  Does every web action, route, agent tool and CLI command call the shared operation, with no copy of the rules and no direct table access of its own? (checklists Lane 1)
  Applies when the repo has a single operations layer behind several entry points.
  (example) a verb in `src/lib/server/ops/` called from `+server.ts`, `/api/v1`, MCP tools and the CLI.
- [ ] **Live Role Check Inside the Operation, Before the First Side Effect**
  Does the operation check the caller's CURRENT role (and token caps and project limits) inside its own transaction, before it reads private data, writes, queues a job, sends mail or calls an external service? Is any role trusted from a session, a request field or an earlier check?
  Applies when the repo has roles, permissions or token scopes.
- [ ] **Tenant Context and the Restricted Role**
  Does every tenant query run inside the tenant context, connected as the restricted runtime role, never the owner role from request code? Is an id validated before use and never put in SQL text? Is any new table registered with the tenant registry? (checklists Lane 2)
  Applies when the repo is multi-tenant or uses row-level security.
  (example) `withTenant` (transaction-local `set_config(..., true)`), the `app_runtime` role, ids validated as UUIDs, `tenantTable`.
- [ ] **Schema Validation From the Data Model**
  Are request bodies, form actions, query params and tool inputs parsed with schemas before use, with bounded numbers and lengths, ideally generated from the data model?
  (example) Zod schemas generated in `src/lib/server/db/zod.ts`.
- [ ] **Secrets Never Returned or Logged**
  Could a password, token, key, device code, master key, sealed value or hash leave through a response, an agent tool reply, a page load, an export or backup, a log line, an activity event or an error message? Are project secrets sealed only through the repo's one vault?
  Applies when the repo stores secrets.
  (example) `src/lib/server/secrets/vault.ts`.
- [ ] **Untrusted Guest Text Sanitised**
  Is all Markdown rendered via the repo's one sanitising renderer (no raw HTML, safe schemes, no images from guests)? Is guest text escaped for emails, external-service text, filenames and shell arguments? Any raw HTML insertion outside that renderer?
  Applies when the repo renders text written by guests or other untrusted people.
  (example) `src/lib/markdown.ts`, and `{@html}` only on its output.
- [ ] **Auth, Tokens, OAuth**
  Are sessions, lockout, rate limits, verification, device sign-in, redirect targets, token hashing and expiry, PKCE and `redirect_uri` checks kept intact? Are secrets compared in constant time?
  Applies when the diff touches authentication.
  (example) Better Auth.
- [ ] **Information Leakage in Error Responses**
  Do errors return a typed error with a plain message rather than raw database errors, stack traces or internal paths?
  (example) `OpError`.
- [ ] **Runner, Bridge & CLI Trust Boundary**
  Does each helper process act only through the public API with its own token, run checks read-only against a local build, and clean up after itself? Does a thin forwarder stay thin, never print or store a token outside its store, and replay its queue through server rules? (checklists Lane 1)
  Applies when the repo ships a runner, bridge or CLI.
  (example) the runner on `/api/v1`, the bridge forwarding to `/mcp`.
- [ ] **Protected Surfaces Untouched**
  Does the diff edit an applied migration, hand-patch generated security SQL, rename a technical id, or change a published protocol without the user's instruction? Any hit is a `BLOCKER`. (checklists Lane 5)
  Applies when the repo rulebook lists protected surfaces.

---

## Lens D - Data Layer, RLS & Runtime Inspector

Inspect the schema, migrations, jobs and database interactions:

- [ ] **Forced RLS From the Registry**
  Is every new tenant table defined through the registry that generates forced row-level security, grants and policies, with an org column (and a project column for project scoped data), and covered by the isolation test?
  Applies when the repo uses row-level security.
  (example) `tenantTable` so `db/security.ts` generates the policies; `tests/db/isolation.test.ts`.
- [ ] **Migration From the Generator**
  Is the migration generated from the schema change, committed with its snapshot and journal entry, numbered after the existing ones, free of hand edits, and is every already-applied migration left unedited? Does every `UPDATE`/`DELETE`/backfill have a stated `WHERE` and row count? (checklists Lane 3)
  Applies when the repo has a database schema with migrations.
  (example) a Drizzle repo: `yarn db:generate`.
- [ ] **Constraints & Inserts**
  Are NOT NULL columns, foreign keys and delete rules explicit, and does every insert (operations, seed, importer, test support) supply every required column?
  (example) verbs, `db/seed.ts`, the importer, test support.
- [ ] **Background Jobs Carry Scope Ids**
  Does each job payload carry the scope ids it needs and set the tenant context before its first query? Is the job idempotent under retry (a queue and an in-memory test runner may behave differently)? (checklists Lane 1 "Background jobs")
  Applies when the repo runs background jobs.
  (example) org and project ids; pg-boss versus the memory runner used in tests.
- [ ] **Runtime & Adapters**
  Does the code keep to the runtime the repo targets, with runtime-only code kept in the server, scripts and tests? Is configuration for each adapter required loudly?
  Applies when the repo targets one fixed runtime.
  (example) the Node server: code in `adapters/` and `src/lib/server/`.
- [ ] **N+1 Query Hazards & Index Use**
  Are queries structured to avoid repeated single-record queries inside loops? Do new filters and sorts have an index? Is an atomic counter used instead of `max()+1`?
  (example) the per-project counter in `db/numbering.ts`.
- [ ] **Connections & Slow Calls**
  Are transactions kept short, with no slow external call (an external service, email, storage upload) held inside an open tenant transaction?
- [ ] **Backup & Restore**
  Do backup and restore still cover the new table and refuse a dump of another shape loudly?
  Applies when the repo has backup or restore code.
  (example) `src/lib/server/backup/`.

---

## Lens E - Quality, Testability & Edge State Verification

Inspect test coverage, error handling, and component resilience:

- [ ] **Alignment with the validation section**
  Do the automated or manual checks in the item's `validation` section accurately verify the actual implemented behaviour? Are tests in the folder the repo's layout expects?
  (example) `tests/ops`, `tests/db`, `tests/auth`, `tests/mcp`, `tests/checks`, `packages/*/src`.
- [ ] **Refusals Prove No Side Effect**
  Do access and isolation tests cover each role and a limited token, and assert that nothing was written, queued or sent behind a refusal?
  Applies when the repo has roles or token scopes.
- [ ] **Zero-Jump Loading UI**
  Do loading states render placeholders of the final shape so nothing jumps?
  Applies when the diff adds or changes a screen.
  (example) `RouteSkeleton`, `Skeleton`, `#afb-boot`.
- [ ] **Form State Transitions & Button Debouncing**
  Are submit buttons disabled during in-flight submissions to prevent duplicate requests? Do writes carry a request id where agents or retries can repeat them?
  (example) `requestId`.
- [ ] **Empty, Error and Permission-Denied States**
  Are empty lists, zero-result searches, server errors and a role without access rendered with clear guidance?
  Applies when the diff adds or changes a screen.
  (example) `EmptyState`, `ErrorState`, `PermissionDenied`.
- [ ] **Type Safety & Strictness**
  Are types explicit, with no untyped escape hatches, double casts or suppression comments without a reason?
  Applies when the repo uses a typed language in strict mode.
  (example) TypeScript: no `any`, no `as unknown as Type`, no `@ts-ignore` without a reason.

---

## Lens F - Design Fit Reviewer

The user is often disappointed because a generated screen comes out bigger, busier or more confusing than the pages around it. If the repo rulebook says the user looks at every screen themselves and runs no UI shots, judge from the code and say plainly what you could not see. Read the repo's design rules if it has any (the rulebook's design list, a design document, a size scale, any design notes for the coding assistant) and the code of the sibling pages the new screen sits next to. Judge the screen the code builds, not only the diff. If the repo has no design rules, compare against the sibling pages only.
(example) the root `CLAUDE.md` "Design fit" list, `DESIGN.md`, `.claude/skills/coding-guidelines/design-fit.md`, `tests/ui-shots/scale.json`; the user checks screens on the local dev server at port 5180.

- [ ] **Say what could not be seen**
  Name the screens the diff changes and say plainly that no picture was looked at; the user checks them. A missing picture is not a finding.
  Applies when the repo rulebook says the user checks screens themselves.
- [ ] **Nothing larger than its neighbours**
  For each screen the diff changes, in the classes it sets for desktop and phone widths and for both modes: is any title, section heading, button, field, card, row, picture or icon larger than the same level on the sibling pages? Compare the style classes with the sibling page's at the same level; a larger one is a `HIGH` finding with both values, unless it is a different kind of control or a state the sibling does not have (say why). A size that existed before the change is not introduced by it.
- [ ] **No new size or pattern where an existing one fits**
  Compare the classes with the repo's size scale and component library. A value outside the scale, or a second kind of dialog, tab bar, card or button style where a component or sibling page already has one, is a `HIGH`.
  Applies when the repo has a size scale or component library.
  (example) `tests/ui-shots/scale.json` and `src/lib/ui/`.
- [ ] **One primary action, and plain words**
  One primary button per view; everything else a plain button or link. Labels and headings a person understands without help; every form field states its own font size, shared by its labels and submit button; a money or limit answer shows a live worked example. A confusing label or a second primary action is a `HIGH`.
  (example) `button-primary`.
- [ ] **Pictures stay small**
  An illustration larger than about 12% of the first screen on desktop, or one that pushes the first action down, is a `HIGH`.
- [ ] **First screen density**
  More elements in the first screen than the sibling pages (applies when UI shots are run: the run reports it) is a `HIGH`; well above is `MEDIUM`.
- [ ] **Phone**
  No sideways scrolling, text and controls readable, tap targets at least 44 px, nothing hidden that desktop shows without a way to reach it.
- [ ] **Both modes**
  Every theme mode the repo has looks right too: colours from the tokens, nothing washed out, every text and surface pair readable (AA). The accent never carries a status.
  Applies when the repo has more than one theme mode.
- [ ] **Taste is advisory**
  Spacing or colour preferences with no measurement behind them are `MEDIUM` at most and never block. Only a measured size larger than its sibling, a missing run (when UI shots are required), a new pattern or a confusing label blocks.
