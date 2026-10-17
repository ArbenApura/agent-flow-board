# Implementation Critique Review Lenses (agent-flow-board)

This document contains the pool of 6 specialized inspection checklists used by flow-critic subagents in code mode during post-implementation review. By default 3 subagents are dispatched and the relevant lenses are distributed across them (merging lenses where needed); see `SKILL.md` section 4 (Code mode). Each subagent also gets the matching lanes from `checklists.md` (the lens to lane table in `SKILL.md` section 4); the lanes carry the AFB-specific rules and file paths behind these items.

---

## Lens A - Completeness & Silent Omissions Auditor

Inspect the codebase for omitted logic and silent failure modes:

- [ ] **Omitted Requirements from the plan's steps and spec**
  Did the implementation skip any acceptance criteria, edge-case handlers, or sub-tasks outlined in the plan?
- [ ] **Swallowed Errors & Empty Catch Blocks**
  Are there try/catch blocks that silently swallow exceptions without logging, returning an `OpError`, or telling the person?
- [ ] **Missing Guard Clauses & Null Checks**
  Are optional properties or array lookups accessed without a null check (`?.` plus handling of the missing case)? TypeScript is strict here: any `any`, unchecked `null` or `undefined`, or `@ts-ignore` without a written reason is a finding.
- [ ] **Missing Config Fails Loudly**
  On an auth, token, tenant or secret path, does a missing env var (`AFB_MASTER_KEY`, database URL, client secret), adapter or lookup result throw or deny? Flag any invented default (`?? true`, `if (key && ...)`, `catch { return allow }`). (checklists Lane 1 "Fail loudly")
- [ ] **Silent Data Truncation**
  Are queries or API responses bounded by hardcoded limits (e.g. `limit(20)`) that silently drop records without pagination or a count?
- [ ] **Unhandled Promise Rejections & Unawaited Calls**
  Are asynchronous operations missing `await` in transactional flows (a write, a queued job, a GitHub call, an email)? Does anything load-bearing run fire-and-forget?
- [ ] **State Tear-Down & Memory Leaks**
  Do components, the realtime hub (`src/lib/server/realtime/hub.ts`), the runner supervisor and the bridge clean up listeners, timers, intervals, subscriptions, child processes and temp files on unmount or stop?
- [ ] **Entry Points Kept in Step**
  If a verb changed, did the web action, `/api/v1` route, OpenAPI entry, MCP tool and CLI that call it change too (or is the difference deliberate)?

---

## Lens B - Theme, Tokens & Visual Regression Inspector

Inspect UI and styling for strict adherence to the AFB rules:

- [ ] **Colours Are Tokens Only**
  Every colour is a CSS variable from `src/lib/theme/` (`--bg --surface --raised --ink --muted --line --accent --accent-ink --accent-soft --accent-text`, fixed `--danger --warning --success --info`). No literal `#hex`, `rgb()`, `hsl()`, `bg-white`, `text-black` or `bg-[#...]` in a component; `afb/no-literal-colours` passes.
- [ ] **No `dark:` Variant, Both Modes Work**
  The mode is `data-mode` on `<html>` and a token changes with it. Does the screen look right in light and in dark? Do portals and popovers copy `data-mode` onto their own root? Is a status ever shown with the accent, or the accent used for a status? Does text on a tinted surface use the matching ink token?
- [ ] **Tailwind on the Element, No Style Blocks**
  Zero `<style>` blocks and no component-level CSS variables. Inline `style=""` only for a multi-stop gradient or runtime coordinates, with an UPPERCASE comment. Class names free of conflicting overrides.
- [ ] **Reuse `src/lib/ui/`**
  Does the diff build a second kind of dialog, tab bar, card, select or toast where `ResponsiveModal`, `ConfirmDialog`, `SegmentedControl`, `Card`, `Select` and the others already exist?
- [ ] **Svelte 5 Runes Only**
  No `export let`, no `$:`, no stores for new local state; `$effect` form syncs use `untrack()` and a previous-value guard.
- [ ] **Modals, Lists and Clickables**
  Modals mount with `open={boolean}` (not in `{#if}`), snippets for header and footer, `focusTrap` and `scrollLock`, data kept through the close transition. Keyed `{#each}` uses ids. Every clickable has `cursor-pointer` (and `disabled:cursor-not-allowed`).
- [ ] **Phosphor Icons, Alt Text, Fonts**
  Icons come from `phosphor-svelte/lib/*`; every `<img>` has `alt`; type uses the fonts of `DESIGN.md` (Poppins, Bricolage Grotesque, Geist Mono for ids and code) through the tokens and `src/app.css`.
- [ ] **Touch Targets & Phone**
  Tap areas at least 44 by 44 px; nothing scrolls sideways at 390 wide; sideways rows (tabs, chips) follow the scroll-row recipe of the root `CLAUDE.md`.

---

## Lens C - Security, Permissions & Tenant Boundary Auditor

Inspect verbs, endpoints, tools and data mutations for security:

- [ ] **One Operations Layer**
  Does every web action, `+server.ts`, `/api/v1` route, MCP tool and CLI command call a verb in `src/lib/server/ops/`, with no copy of the rules and no direct table access of its own? (checklists Lane 1)
- [ ] **Live Role Check Inside the Verb, Before the First Side Effect**
  Does the verb check the caller's CURRENT role (and token caps and project limits) inside its own transaction, before it reads private data, writes, queues a job, sends mail or calls GitHub? Is any role trusted from a session, a request field or an earlier check?
- [ ] **Tenant Context and the `app_runtime` Role**
  Does every tenant query run inside `withTenant` (transaction-local `set_config(..., true)`), connected as `app_runtime`, never the owner role from request code? Is an id validated as a UUID before use and never put in SQL text? Is any new table registered with `tenantTable`? (checklists Lane 2)
- [ ] **Zod Validation From the Drizzle Tables**
  Are request bodies, form actions, query params and tool inputs parsed with schemas generated in `src/lib/server/db/zod.ts` before use, with bounded numbers and lengths?
- [ ] **Secrets Never Returned or Logged**
  Could a password, token, key, device code, master key, sealed value or hash leave through a response, an MCP reply, a `load`, an export or backup, a log line, an activity event or an error message? Are project secrets sealed only through `src/lib/server/secrets/vault.ts`?
- [ ] **Untrusted Guest Text Sanitised**
  Is all Markdown rendered via `src/lib/markdown.ts` (no raw HTML, safe schemes, no images from guests)? Is guest text escaped for emails, GitHub text, filenames and shell arguments? Any `{@html}` outside that renderer?
- [ ] **Better Auth, Tokens, OAuth**
  Are sessions, lockout, rate limits, verification, device sign-in, redirect targets, token hashing and expiry, PKCE and `redirect_uri` checks kept intact? Are secrets compared in constant time?
- [ ] **Information Leakage in Error Responses**
  Do errors return an `OpError` with a plain message rather than raw database errors, stack traces or internal paths?
- [ ] **Runner, Bridge & CLI Trust Boundary**
  Does the runner act only through `/api/v1` with its own token, run checks read-only against a local build preview, and clean up after itself? Does the bridge stay a thin forwarder that never prints or stores a token outside its store, and replay its queue through server rules? (checklists Lane 1)
- [ ] **Protected Surfaces Untouched**
  Does the diff edit an applied migration, hand-patch generated RLS, rename a technical id, or change the bridge protocol without the user's instruction? Any hit is a `BLOCKER`. (checklists Lane 5)

---

## Lens D - Data Layer, RLS & Runtime Inspector

Inspect the schema, migrations, jobs and database interactions:

- [ ] **Forced RLS From the Registry**
  Is every new tenant table defined with `tenantTable` (so `db/security.ts` generates forced RLS, grants and policies), with `org_id` (and a project column for project scoped data), and covered by `tests/db/isolation.test.ts`?
- [ ] **Migration From `yarn db:generate`**
  Is the migration generated from the schema change, committed with its snapshot and journal entry, numbered after the existing ones, free of hand edits, and is every already-applied migration left unedited? Does every `UPDATE`/`DELETE`/backfill have a stated `WHERE` and row count? (checklists Lane 3)
- [ ] **Constraints & Inserts**
  Are NOT NULL columns, foreign keys and `onDelete` rules explicit, and does every insert (verbs, `db/seed.ts`, the importer, test support) supply every required column?
- [ ] **Background Jobs Carry Org and Project Ids**
  Does each job payload carry its org and project ids and set the tenant context before its first query? Is the job idempotent under retry (pg-boss, the memory runner and the Cloudflare queue behave differently)? (checklists Lane 1 "Background jobs")
- [ ] **Runtime & Adapters**
  Does code on the Cloudflare path (`src/lib/server/cloudflare/`, `adapters/`) avoid Node-only APIs, and does Node-only code stay in the server, scripts, runner and tests? Is configuration for each adapter required loudly?
- [ ] **N+1 Query Hazards & Index Use**
  Are queries structured to avoid repeated single-record queries inside loops? Do new filters and sorts have an index? Is the per-project counter (`db/numbering.ts`) used instead of `max()+1`?
- [ ] **Connections & Slow Calls**
  Are transactions kept short, with no slow external call (GitHub, email, storage upload) held inside an open `withTenant` transaction?
- [ ] **Backup & Restore**
  Do `src/lib/server/backup/` dump and restore still cover the new table and refuse a dump of another shape loudly?

---

## Lens E - Quality, Testability & Edge State Verification

Inspect test coverage, error handling, and component resilience:

- [ ] **Alignment with the validation section**
  Do the automated or manual checks in the item's `validation` section accurately verify the actual implemented behaviour? Are tests in the right folder (`tests/ops`, `tests/db`, `tests/auth`, `tests/mcp`, `tests/checks`, `packages/*/src`)?
- [ ] **Refusals Prove No Side Effect**
  Do access and isolation tests cover each role and a limited token, and assert that nothing was written, queued or sent behind a refusal?
- [ ] **Zero-Jump Loading UI**
  Do loading states render placeholders of the final shape (`RouteSkeleton`, `Skeleton`, `#afb-boot`) so nothing jumps?
- [ ] **Form State Transitions & Button Debouncing**
  Are submit buttons disabled during in-flight submissions to prevent duplicate requests? Do writes carry a `requestId` where agents or retries can repeat them?
- [ ] **Empty, Error and Permission-Denied States**
  Are empty lists, zero-result searches, server errors and a role without access rendered with clear guidance (`EmptyState`, `ErrorState`, `PermissionDenied`)?
- [ ] **Type Safety & Strictness**
  Are types explicit, with no `any`, no `as unknown as Type`, and no `@ts-ignore` without a reason?

---

## Lens F - Design Fit Reviewer

The user is often disappointed because a generated screen comes out bigger, busier or more confusing than the pages around it. There are no UI shots in this repo's flow (standing override 2) and they look at the screen themselves on localhost 5180, so judge from the code. Read the root `CLAUDE.md` "Design fit" list, `DESIGN.md`, `.claude/skills/coding-guidelines/design-fit.md`, `tests/ui-shots/scale.json` (the size scale) and the code of the sibling pages the new screen sits next to. Judge the screen the code builds, not only the diff.

- [ ] **Say what could not be seen**
  Name the screens the diff changes and say plainly that no picture was looked at; the user checks them on localhost 5180. A missing picture is not a finding.
- [ ] **Nothing larger than its neighbours**
  For each screen the diff changes, in the classes it sets for 1440 and 390 and for both modes: is any title, section heading, button, field, card, row, picture or icon larger than the same level on the sibling pages? Compare the utility classes with the sibling page's at the same level; a larger one is a `HIGH` finding with both values, unless it is a different kind of control or a state the sibling does not have (say why). A size that existed before the change is not introduced by it.
- [ ] **No new size or pattern where an existing one fits**
  Compare the classes with `tests/ui-shots/scale.json` and `src/lib/ui/`. A pixel value outside the scale, or a second kind of dialog, tab bar, card or button style where a component or sibling page already has one, is a `HIGH`.
- [ ] **One primary action, and plain words**
  One `button-primary` per view; everything else a plain button or link. Labels and headings a person understands without help; every form field states its own font size, shared by its labels and submit button; a money or limit answer shows a live worked example. A confusing label or a second primary action is a `HIGH`.
- [ ] **Pictures stay small**
  An illustration larger than about 12% of the first screen at 1440, or one that pushes the first action down, is a `HIGH`.
- [ ] **First screen density**
  More elements in the first screen than the sibling pages (the run reports it) is a `HIGH`; well above is `MEDIUM`.
- [ ] **Phone**
  No sideways scrolling, text and controls readable, tap targets at least 44 px, nothing hidden that desktop shows without a way to reach it.
- [ ] **Both modes**
  The dark pictures look right too: colours from the tokens, nothing washed out, every text and surface pair readable (AA). The accent never carries a status.
- [ ] **Taste is advisory**
  Spacing or colour preferences with no measurement behind them are `MEDIUM` at most and never block. Only a measured size larger than its sibling, a missing run, a new pattern or a confusing label blocks.
