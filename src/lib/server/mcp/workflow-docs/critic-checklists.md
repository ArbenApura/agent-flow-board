# AFB Review Checklists (per lane)

Paste only the lanes the diff touches into `{LANE_CHECKLISTS}` in `code-template.md`, next
to the subagent's lens checklist from `code-lenses.md`. `SKILL.md` section 4 says which lanes go
with which lens. Lanes are numbered (1 to 7) so they do not clash with the lens letters (A to F).
Every item here comes from a written rule (root `CLAUDE.md`, `DESIGN.md`, an ADR named in a file
header) or a real file in this repo; the reason is given so the reviewer can judge cases the
wording does not cover. Paths are repo-relative.

---

## Lane 1 - Operations layer, entry points, jobs, runtime

**The one operations layer (highest priority)**

- [ ] **Every action goes through a verb in `src/lib/server/ops/`.** The web actions
      (`+page.server.ts`, `src/lib/server/web/ctx.ts`), `/api/v1` (`src/lib/server/api/dispatch.ts`,
      `routes.ts`), `/mcp` (`src/lib/server/mcp/tools.ts`, thin wrappers) and the CLI
      (`scripts/server.ts`, `packages/cli`) all call the same verb. A route, tool or script that
      queries tables directly or copies a verb's rules will drift from it; the rules (private items,
      token caps, request ids) are only enforced inside the verb.
- [ ] **The verb checks the caller's LIVE role itself**, inside its own transaction, through the
      `Ctx` of `ops/context.ts` and `orgs/roles.ts` (`ROLE_RANK`, `effectiveProjectRole`). It never
      trusts a role passed in, cached in a session, or checked once by the route. A person who was
      demoted a second ago must be refused on the next call.
- [ ] **A token or session is only an upper limit.** `Actor.tokenCaps` and `tokenProjects` narrow
      what a signed in user can do, never widen it. A new capability is added to `Capability` and
      checked in the verb, not in the entry point.
- [ ] **The check runs BEFORE the first side effect** (a read of a private row, a write, a storage
      call, an email, a job queued, a GitHub call). Read the verb top to bottom and name the first
      side effect.
- [ ] **A new verb is reachable and the same everywhere it should be**: wired into `api/routes.ts`
      and the OpenAPI in `api/openapi.ts`, and into `mcp/tools.ts` when agents need it. A verb that
      exists only for the UI, or only for MCP, is a plan decision, not an accident.
- [ ] **Writes that agents or retries can repeat take a `requestId`** (`Ctx.requestId`,
      `fingerprint`): the same id returns the stored result and writes nothing twice, and the same id
      on another request is refused (`tests/ops/access.test.ts`).
- [ ] **Errors are `OpError`s with a plain message** (`ops/context.ts`). No raw database error, stack
      trace or file path reaches a response, an MCP reply or a page.

**Entry points and authentication**

- [ ] **Every `+server.ts` and form action authenticates and builds its `Ctx` before any work**, then
      calls a verb. Public routes (`/healthz`, `/oauth/*`, sign-in pages, `/device`, an invite link)
      are deliberate and validate their token server-side. `/internal/jobs` and any webhook check their own signature or secret.
- [ ] **Better Auth is the only session source** (`src/lib/server/auth/auth.ts`, `index.ts`).
      Lockout (`lockout.ts`), rate limits, email verification (`unverified.ts`), device sign-in
      (`devices.ts`) and post-sign-in redirects (`next.ts`, tested in `next.test.ts`) are not bypassed
      or reimplemented. A redirect target (`next`) is validated, never an open redirect.
- [ ] **Personal access tokens** (`ops/tokens.ts`): shown once, stored as a hash, `afb_<orgId>.<secret>`
      prefix, at most 90 days, scoped. A change never stores or logs the plain token and never lets a
      token outlive its limits.
- [ ] **OAuth and device flows** (`src/lib/server/oauth/`, `src/routes/oauth/`, `src/routes/device`)
      validate `redirect_uri`, PKCE (`code_challenge`) and scope against the registered client; the
      code and device code are single use.
- [ ] Route files export only names SvelteKit accepts (`load`, `actions`, verbs, `prerender`, ...).
      Anything else is a runtime 500 that passes `yarn check` and the tests.
- [ ] Nothing under `src/lib/server/` or `$app/env/private` is imported from client code or a
      universal `+page.ts`.

**Input and output**

- [ ] Every request body, form and action payload is parsed with a Zod schema generated from the
      Drizzle tables (`src/lib/server/db/zod.ts`) before use; ids are validated (UUID), numbers are
      bounded, free text has a length limit. A hand-written schema that duplicates a table is a
      finding when a generated one fits.
- [ ] Lists have limits and a way to see more (`Pagination`, cursors); a hardcoded `limit` that drops
      rows silently is a finding. Search (`db/search.ts`, `ops/board.ts`) shows only what the caller
      may see.
- [ ] `fields` and compact replies on MCP tools do not widen what a role may read.

**Fail loudly**

- [ ] **Missing configuration refuses, never defaults.** A missing env var, `AFB_MASTER_KEY`, database
      URL, client secret or adapter must throw (as `requireMasterKey` in `secrets/vault.ts` does) or
      deny. Look for `if (key && ...)`, `?? true`, `catch { return allow }`, an empty `catch {}` on an
      auth, token, tenant or secret path.
- [ ] Errors surfaced to the person are actionable; server logs carry ids and the operation, never
      tokens, passwords, keys or secret values.

**Background jobs (`src/lib/server/jobs/index.ts`, `adapters/jobs.ts`, `routes/internal/jobs`)**

- [ ] **Every job payload carries its org id and project id** and the job runs its queries through
      `withTenant` with them before the first query. A job that reads "all projects" or uses the owner
      handle is a `BLOCKER`.
- [ ] Jobs are safe to run twice (pg-boss retries; the memory runner used in tests differs):
      idempotent writes, a stable key, no double email or double publish.
- [ ] A failing job surfaces (retry, activity event, health page) and does not vanish. Fire-and-forget
      is only for work whose loss is harmless, and says why in a comment.

**Runner, bridge and CLI (`packages/runner`, `packages/bridge`, `packages/cli`)**

- [ ] The **bridge** forwards JSON-RPC to the server's `/mcp` and holds no tool code, schema or
      workflow text (ADR-030). The token store, offline queue and protocol version check stay; a
      change does not read or print a token, and a queued write replays through the same server rules.
- [ ] The **runner** talks to the server only through `/api/v1` with its own token (`runner/src/api.ts`,
      `signin.ts`), runs checks and shots read-only against a build preview (`checks.ts`, `shots.ts`),
      and cleans up child processes and temp folders when it stops or fails (`supervisor.ts`).
- [ ] Git and GitHub actions in the runner (`git.ts`, `approvals.ts`) keep their approval step; nothing
      pushes or force-pushes on its own.
- [ ] `yarn check:packages` passes for runner, importer and scripts.

**Runtime**

- [ ] Code stays on the one runtime, the Node server (`adapter-node`); Node-only code (`node:crypto` is fine, `node:fs`, child processes, embedded Postgres) stays in
      the Node server, scripts, runner and tests.
- [ ] No unbounded accumulation of wide rows or `Promise.all` over an unbounded list; long work does
      not assume it outlives the response unless it uses the adapter's own mechanism.
- [ ] Secrets differ per environment and come from `$app/env/private`; nothing secret is exposed to
      the client bundle.

---

## Lane 2 - Tenant isolation, secrets and untrusted text

**Tenant isolation (a break here is a BLOCKER)**

- [ ] **Every tenant query runs inside `withTenant`** (`src/lib/server/db/tenant.ts`), the
      transaction-local `set_config(..., true)` context, connected as the non-owning `app_runtime`
      role (`db/security.ts`, `RUNTIME_ROLE`). Request code never uses the owner handle
      (`DATABASE_OWNER_URL` is for migrations and scripts). Without an org, no tenant row is visible:
      a call that forgot its context must read nothing, and a test should show it.
- [ ] **Org and project walls both hold.** Project scoped tables are narrowed by `projectId` whenever
      the verb works in one project; a verb that takes a project id from the request verifies it
      belongs to the caller's org (RLS) and that the caller may reach it (live role).
- [ ] **Ids are validated as UUIDs before reaching the database** (`uuidOrEmpty` in `tenant.ts`); an id
      or slug is never concatenated into SQL text. `sql` template parameters only.
- [ ] A new table is defined with `tenantTable(...)` (`db/schema/helpers.ts`) so it enters
      `TENANT_TABLES` and gets forced RLS, grants and policies generated by `db/security.ts`. A table
      outside the registry that holds org data, or a hand-written policy that differs, is a finding.
      Tables with no tenant data (users, OAuth clients, device codes, auth tables) are listed in
      `PLAIN_TABLES` / `USER_TABLES` on purpose.
- [ ] Cross-org entry points (an org slug lookup, a token lookup by
      its org id prefix) use the narrow `Tenant` fields (`orgSlug`) that expose one
      row, not a wide read.
- [ ] Seed and test data (`db/seed.ts`, `db/seedAuth.ts`, `tests/support/db.ts`) never run on a real
      database; the importer (`importer/`) sets the tenant context for what it writes.

**Secrets (never returned, never logged)**

- [ ] **No password, token, key, client secret, device code, master key or sealed value is returned**
      by a verb, `/api/v1`, an MCP tool, a page `load`, a backup or export (`backup/`,
      `ops/export.ts`), or written to a log, an activity event or an error message. Check
      `select()` shapes: a table read as a whole may carry a hash or ciphertext column.
- [ ] **Project secrets use the vault** (`src/lib/server/secrets/vault.ts`): sealed with the org data
      key, bound to org, project and name, wrapped by `AFB_MASTER_KEY`. No second encryption scheme,
      no plaintext copy in a row, a URL, a job payload or a runner config.
- [ ] Secrets in the runner and bridge (token store, sign-in) live outside the repo and out of the
      logs; a screenshot or report (`shots.ts`, `checks.ts`) never includes a field that held one.
- [ ] Constant-time comparison (`timingSafeEqual`) or hashing for tokens and webhook signatures,
      never `===` on a secret.

**Untrusted content (guest-written text)**

- [ ] **All Markdown is rendered through `src/lib/markdown.ts`**: no raw HTML, safe link and image
      schemes only, and guest (untrusted) text gets no images. No `{@html}` on anything that did not
      come from that renderer, and no second Markdown or HTML path.
- [ ] Guest text in an email (`email/templates.ts`), a
      Slack-like notification or a filename is escaped for its target; it never becomes a command
      line argument, a path, a header or HTML.
- [ ] Uploads (`ops/attachments.ts`, `routes/api/v1/files`) check size, type and org/project on the
      way in and are served with a safe content type and disposition, never inline from the app origin
      when the type is script-capable.
- [ ] Rendering cost is bounded (`MAX_RENDER_CHARS`, the cache limits): one huge document cannot stall a page.

---

## Lane 3 - Database (Drizzle schema, migrations, RLS)

**Schema and generation**

- [ ] Schema changes are made in `src/lib/server/db/schema/*.ts` and the migration comes from
      `yarn db:generate`, committed with its `meta/` snapshot and journal entry. A hand-edited
      generated file, a missing snapshot or a journal that disagrees with the files is a finding.
- [ ] **An already-applied migration is never edited.** Fixes go in a new one. Numbering follows the
      journal (`0005_...` next after `0004_task_body.sql` at the time of writing); two files with the
      same number silently drop one.
- [ ] Custom SQL that Drizzle cannot express (RLS, grants, triggers) lives in `db/security.ts` or a
      reviewed custom migration, with a header comment saying what it does and why.
- [ ] New columns: every `NOT NULL` column has a default or the insert supplies it, in every verb,
      the seed (`db/seed.ts`), the importer and the test support. Check the table definition, not memory.
- [ ] Foreign keys and `onDelete` rules are explicit and keep the org wall (a child row never points
      to a parent in another org). Counters use the per-project row (`db/numbering.ts`), not
      `max()+1`.
- [ ] Indexes exist for the new filters and sorts (org, project, status, number); no N+1 inside a verb.

**Security**

- [ ] Forced RLS and grants for the new table are produced by the registry (see lane 2). The
      `app_runtime` role gets only the grants it needs; it never owns tables.
- [ ] Policies are checked for both read and write (`using` and `with check`), as `tests/db/isolation.test.ts`
      does for every registered table, on the embedded real PostgreSQL.
- [ ] Any `security definer` function sets `search_path`; nothing is granted to `public` by accident.
- [ ] No secret literal in SQL or a migration.

**Data safety**

- [ ] Every `update` / `delete` / backfill has a `where` whose row count is stated, or a verification
      query is supplied. Wide or destructive statements are flagged for the user.
- [ ] Multi-statement changes are transactional; backfills are idempotent where a re-run is plausible.
- [ ] A migration is checked on a real PostgreSQL as the non-superuser owner with `app_runtime` as the
      app role (`tests/support/db.ts`), not on anything else. Say in `{KNOWN_UNVERIFIED}` if it was not.
- [ ] Backup and restore (`src/lib/server/backup/`) still cover the new table, and a restore refuses
      a dump of another shape loudly.
- [ ] Zod schemas in `db/zod.ts` are regenerated for new or changed columns and `zod.test.ts` still passes.

---

## Lane 4 - UI (Svelte 5, Tailwind 4, tokens)

**Colour and theme (BLOCKER if a literal colour ships)**

- [ ] **Colours are tokens only**, read from `src/lib/theme/` as CSS variables (`bg-[var(--surface)]`,
      `text-[var(--ink)]`, `border-[var(--line)]`). No `#fff`, `rgb()`, `hsl()`, `bg-white`,
      `text-black`, `bg-[#2563eb]` in a component. `afb/no-literal-colours` (`eslint-rules/`) must be clean.
- [ ] **No `dark:` variant.** The mode is `data-mode="light|dark"` on `<html>` and a token changes
      with it. Anything rendered outside the root layout (portal, popover moved to `<body>`) copies
      `data-mode` onto its own root, as `src/lib/ui/Popover.svelte` and `ResponsiveModal.svelte` do.
- [ ] Danger, warning, success and info use their fixed tokens, never an org palette; a status never
      uses the accent and the accent never carries a status. Text on a tinted surface uses the
      matching ink (`--accent-text` on `--accent-soft`).
- [ ] **Checked in both modes** (light and dark). A screen that only passed the type check has not been checked.
- [ ] Type is Poppins (text), Bricolage Grotesque (headings and bold, applied by the rule in
      `src/app.css`) and Geist Mono (ids, hashes, code) per `DESIGN.md`; no other font, nothing loaded
      from a remote font host. Tables use tabular figures.

**Svelte 5 correctness**

- [ ] Runes (`$state`, `$derived`, `$props`, `$effect`, `$bindable`, snippets). No `export let`, no `$:`.
- [ ] `$effect` that syncs form state from props uses `untrack()` for internal writes and a
      previous-value guard; otherwise it loops and wipes keystrokes.
- [ ] `$derived` is used for derived values instead of an `$effect` that assigns state.
- [ ] Modals (`ResponsiveModal`, `ConfirmDialog`) mount with `open={boolean}`, never inside `{#if}`,
      use snippets for header and footer, `focusTrap` on the panel, `scrollLock` on the body
      (`src/lib/actions/`), and keep their data through the close transition. No native `confirm()`,
      `alert()` or `prompt()`.
- [ ] A keyed `{#each}` key is an id, never a display value. Lists passed to `Select` have unique values.
- [ ] No eager relative `fetch` during SSR; client-only loading behind `onMount` or a browser guard.
- [ ] `{@html}` only on output of `src/lib/markdown.ts` (lane 2).

**Conventions**

- [ ] Zero `<style>` blocks and no component-level CSS variables. Inline `style=""` only for a
      multi-stop gradient or runtime layout coordinates, with an UPPERCASE comment saying why.
- [ ] Imports in nine groups in the order of the root `CLAUDE.md`, with no blank lines; component
      sections in the fixed order; UPPERCASE section headers (`// -- STATES -- //`), sentence-case notes.
- [ ] Icons are `import Name from 'phosphor-svelte/lib/Name'`. Every `<img>` has `alt=""` or a real alt.
- [ ] Every clickable element has `cursor-pointer`, and `disabled:cursor-not-allowed` where it can be disabled.
- [ ] A sideways-scrolling row (tabs, chips) pairs `overflow-x-auto` with `overflow-y-hidden`, hides
      its scrollbar with `[scrollbar-width:none]!` and `[&::-webkit-scrollbar]:hidden`, and centres the
      active item with the row's own `scrollTo`.
- [ ] **Existing comments are preserved.** Deleting architectural notes is HIGH, not LOW.

**Phones**

- [ ] Every tap target at least 44 by 44 px; nothing scrolls sideways at 390 wide; same type scale as desktop.
- [ ] Wide data tables stay real tables inside a scroll container, or follow what the nearest sibling does.
- [ ] Loading placeholders match the final layout (`RouteSkeleton`, `Skeleton`, `#afb-boot` in
      `src/app.html`) so nothing jumps; empty, error and permission-denied states use `EmptyState`,
      `ErrorState`, `PermissionDenied`.

---

## Lane 5 - Protected surfaces (always check; any hit is a BLOCKER unless the user explicitly asked)

- [ ] **Applied migrations** in `src/lib/server/db/migrations/` are not edited, renamed or deleted.
- [ ] **Generated security SQL** (`db/security.ts`) is not hand-patched around the tenant table
      registry; the registry stays the single source of RLS (ADR-021).
- [ ] **Technical ids keep their names**: package names (`@agent-flow-board/bridge`), the MCP server
      name, the snapshot format, the user-agent and the connection name `afb-<org-slug>` (older
      connections used `agent-flow-board`). The display
      name "Agent Flow Board" is for people (`DESIGN.md` "Name").
- [ ] **The bridge protocol** (ADR-030): the bridge stays a thin forwarder and the protocol version
      check stays, so existing connections keep working after a server update.
- [ ] **`DESIGN.md` and the token files** are changed only on purpose and with a plan.
      Hex values live only in the token files and the palette generator.
- [ ] `node_modules`, `.git`, `yarn.lock` handling follow the root `CLAUDE.md` (Yarn 4 only; no
      `package-lock.json` or `pnpm-lock.yaml`).
- [ ] Nothing was pushed, committed, branched or given a Claude or Anthropic attribution line.
- [ ] No change reaches a live service (the deployed site, a production database, a real GitHub org)
      without the user confirming first. The live site is not a target for browser checks.

---

## Lane 6 - Tests

- [ ] New behaviour has a test that would fail without the change (check by reasoning about it, or by
      reverting mentally). A test that passes on the old code proves nothing.
- [ ] The test lives in the matching folder: `tests/ops` (verbs and API), `tests/db` (schema, RLS,
      seed), `tests/auth`, `tests/mcp`, `tests/unit`, `tests/checks` (Playwright), `tests/runner`,
      `packages/*/src/*.test.ts`, `src/**/*.test.ts` next to pure code.
- [ ] **Isolation and access tests assert no side effect behind a refusal** (the row was not written,
      the job was not queued, the mail was not sent), not only the status or error code, and cover
      each role (`owner`, `admin`, `member`, `viewer`, `guest`) and a token with caps and project limits.
- [ ] A new tenant table is covered by `tests/db/isolation.test.ts` through the registry; a new verb has
      a case for a role that must be refused.
- [ ] Tests that enumerate files or tables at run time assert the enumeration is non-empty.
- [ ] Mocks do not replace the thing under test; database tests use the real handle from
      `tests/support/db.ts` (embedded PostgreSQL), and error paths are exercised.
- [ ] Browser checks (`tests/checks/*.spec.ts`, `yarn test:checks`) run against the build preview, sign
      in through the real page with the seeded people (`seed owner`, `seed admin`, `seed member`,
      `seed viewer`), and wait on a condition, never an unconditional sleep.
- [ ] No invariant test was weakened to pass (see `SKILL.md` Step 3).

---

## Lane 7 - Design fit (user-facing screens)

From the user's repeated reports of screens that were bigger or more confusing than the rest of the app.
Paste into the Lens F subagent whenever the diff has `.svelte` or style changes. There are no UI shots
(standing override 2); the reviewer works from the code and `DESIGN.md`, and says what it could not see.
The ruler is the nine-step Design fit list in the root `CLAUDE.md`, `DESIGN.md` and `tests/ui-shots/scale.json`.

- [ ] No element larger than its sibling at the same level (title, section, body, label,
      `button-primary`, button, input, card, row, icon). Emphasis comes from weight or colour tokens,
      not size.
- [ ] No new size, radius or spacing value outside `tests/ui-shots/scale.json`; `src/lib/ui/` components and
      the sibling pages' patterns are reused. A second kind of dialog, tab bar or card is a design finding.
- [ ] One primary action per view at the `button-primary` size; labels are plain questions or actions;
      every form field states its own font size, shared by labels, fields and the submit button of
      one form; a money or limit answer shows a live worked example before saving.
- [ ] Pictures stay small (at most about 12% of the first screen, never in front of the first action).
- [ ] Both modes (`light`, `dark`) and both widths (1440 and 390) are handled by the classes: phone has no
      sideways scroll and tap targets of at least 44 px.
