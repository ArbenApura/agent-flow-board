# Review Checklists (per lane)

Paste only the lanes the diff touches into `{LANE_CHECKLISTS}` in `code-template.md`, next
to the subagent's lens checklist from `code-lenses.md`. `SKILL.md` section 4 says which lanes go
with which lens. Lanes are numbered (1 to 7) so they do not clash with the lens letters (A to F).
Every item here comes from a written rule (the repo rulebook, a design document, an ADR named in a
file header) or a real file in the repo; the reason is given so the reviewer can judge cases the
wording does not cover. Paths are repo-relative.

Some items only apply to certain stacks. Each of those carries an "Applies when ..." line: if the
trigger is false for this repo, mark the item "not applicable" with that reason instead of raising
a finding. A line marked (example) shows what the item looks like in one stack; read it as an
illustration, and take the real names from the repo rulebook (CLAUDE.md, AGENTS.md, README) and the
code.

---

## Lane 1 - Operations layer, entry points, jobs, runtime

**The one operations layer (highest priority)**

- [ ] **Every action goes through one shared operation.** Every entry point (web actions, public
      API, agent tools, CLI) calls the same operation. A route, tool or script that queries tables
      directly or copies an operation's rules will drift from it; the rules (private items, token
      caps, request ids) are only enforced inside the operation.
      Applies when the repo has one operations or service layer behind several entry points.
      (example) a verb in `src/lib/server/ops/`; web actions (`+page.server.ts`, `src/lib/server/web/ctx.ts`), `/api/v1` (`src/lib/server/api/dispatch.ts`, `routes.ts`), `/mcp` (`src/lib/server/mcp/tools.ts`, thin wrappers) and the CLI (`scripts/server.ts`, `packages/cli`).
- [ ] **The operation checks the caller's LIVE role itself**, inside its own transaction. It never
      trusts a role passed in, cached in a session, or checked once by the route. A person who was
      demoted a second ago must be refused on the next call.
      Applies when the repo has roles or permissions.
      (example) the `Ctx` of `ops/context.ts` and `orgs/roles.ts` (`ROLE_RANK`, `effectiveProjectRole`).
- [ ] **A token or session is only an upper limit.** Token scopes narrow what a signed in user can
      do, never widen it. A new capability is added to the capability list and checked in the
      operation, not in the entry point.
      Applies when the repo has scoped tokens.
      (example) `Actor.tokenCaps` and `tokenProjects`; the `Capability` type.
- [ ] **The check runs BEFORE the first side effect** (a read of a private row, a write, a storage
      call, an email, a job queued, an external service call). Read the operation top to bottom and
      name the first side effect.
- [ ] **A new operation is reachable and the same everywhere it should be**: wired into the public
      API and its spec, and into the agent tools when agents need it. An operation that exists only
      for the UI, or only for agents, is a plan decision, not an accident.
      Applies when the repo exposes the same operations through several entry points.
      (example) `api/routes.ts`, the OpenAPI in `api/openapi.ts`, `mcp/tools.ts`.
- [ ] **Writes that agents or retries can repeat take a request id**: the same id returns the stored
      result and writes nothing twice, and the same id on another request is refused.
      (example) `Ctx.requestId`, `fingerprint`, tested in `tests/ops/access.test.ts`.
- [ ] **Errors are typed errors with a plain message.** No raw database error, stack trace or file
      path reaches a response, an agent reply or a page.
      (example) `OpError` in `ops/context.ts`.

**Entry points and authentication**

- [ ] **Every route and form action authenticates and builds its context before any work**, then
      calls the shared operation. Public routes (health checks, OAuth endpoints, sign-in pages,
      device sign-in, an invite link) are deliberate and validate their token server-side. Internal
      job endpoints and any webhook check their own signature or secret.
      (example) every `+server.ts` and form action; `/healthz`, `/oauth/*`, `/device`, `/internal/jobs`.
- [ ] **One auth library is the only session source.** Lockout, rate limits, email verification,
      device sign-in and post-sign-in redirects are not bypassed or reimplemented. A redirect target
      is validated, never an open redirect.
      Applies when the diff touches authentication.
      (example) Better Auth in `src/lib/server/auth/auth.ts`, `index.ts`; `lockout.ts`, `unverified.ts`, `devices.ts`, and `next.ts` (tested in `next.test.ts`).
- [ ] **Personal access tokens**: shown once, stored as a hash, carrying an identifying prefix, with a
      maximum lifetime, scoped. A change never stores or logs the plain token and never lets a token
      outlive its limits.
      Applies when the repo issues personal access tokens.
      (example) `ops/tokens.ts`, `afb_<orgId>.<secret>` prefix, at most 90 days.
- [ ] **OAuth and device flows** validate `redirect_uri`, PKCE (`code_challenge`) and scope against
      the registered client; the code and device code are single use.
      Applies when the repo runs OAuth or device flows.
      (example) `src/lib/server/oauth/`, `src/routes/oauth/`, `src/routes/device`.
- [ ] Route files export only names the framework accepts. Anything else is a runtime error that
      passes the type check and the tests.
      Applies when the framework restricts what route files may export.
      (example) SvelteKit: `load`, `actions`, HTTP verbs, `prerender`, and so on.
- [ ] Server-only code is never imported from client code or a universal route module.
      Applies when the framework separates server-only and client code.
      (example) nothing under `src/lib/server/` or `$app/env/private` in client code or a universal `+page.ts`.

**Input and output**

- [ ] Every request body, form and action payload is parsed with a schema before use; ids are
      validated, numbers are bounded, free text has a length limit. A hand-written schema that
      duplicates a table is a finding when a generated one fits.
      (example) Zod schemas generated from the Drizzle tables in `src/lib/server/db/zod.ts`; ids validated as UUIDs.
- [ ] Lists have limits and a way to see more (pagination, cursors); a hardcoded limit that drops
      rows silently is a finding. Search shows only what the caller may see.
      (example) `Pagination`, `db/search.ts`, `ops/board.ts`.
- [ ] Field selection and compact replies on agent tools do not widen what a role may read.
      Applies when agent tools offer field selection or compact replies.
      (example) `fields` on MCP tools.

**Fail loudly**

- [ ] **Missing configuration refuses, never defaults.** A missing env var, master key, database
      URL, client secret or adapter must throw or deny. Look for an invented default that lets the
      call through, and an empty `catch {}` on an auth, token, tenant or secret path.
      (example) `AFB_MASTER_KEY`; `requireMasterKey` in `secrets/vault.ts`; `if (key && ...)`, `?? true`, `catch { return allow }`.
- [ ] Errors surfaced to the person are actionable; server logs carry ids and the operation, never
      tokens, passwords, keys or secret values.

**Background jobs**

- [ ] **Every job payload carries its scope ids** and the job runs its queries inside the tenant
      context with them before the first query. A job that reads "all projects" or uses the owner
      handle is a `BLOCKER`.
      Applies when the repo runs background jobs in a multi-tenant system.
      (example) org id and project id through `withTenant`; `src/lib/server/jobs/index.ts`, `adapters/jobs.ts`, `routes/internal/jobs`.
- [ ] Jobs are safe to run twice (queue retries; an in-memory test runner may differ): idempotent
      writes, a stable key, no double email or double publish.
      (example) pg-boss retries versus the memory runner used in tests.
- [ ] A failing job surfaces (retry, activity event, health page) and does not vanish. Fire-and-forget
      is only for work whose loss is harmless, and says why in a comment.

**Runner, bridge and CLI**

- [ ] A thin forwarder (a bridge) forwards requests to the server and holds no tool code, schema or
      workflow text. The token store, offline queue and protocol version check stay; a change does
      not read or print a token, and a queued write replays through the same server rules.
      Applies when the repo ships a bridge or similar forwarder.
      (example) `packages/bridge` forwards JSON-RPC to the server's `/mcp` (ADR-030).
- [ ] A **runner** talks to the server only through the public API with its own token, runs checks
      and screenshots read-only against a build preview, and cleans up child processes and temp
      folders when it stops or fails.
      Applies when the repo ships a runner.
      (example) `packages/runner`: `runner/src/api.ts`, `signin.ts`, `checks.ts`, `shots.ts`, `supervisor.ts`.
- [ ] Git and hosting actions in the runner keep their approval step; nothing pushes or force-pushes
      on its own.
      Applies when the repo ships a runner.
      (example) `git.ts`, `approvals.ts`.
- [ ] The gate commands the repo rulebook names for helper packages pass.
      Applies when the repo has helper packages with their own gate.
      (example) `yarn check:packages` for runner, importer and scripts.

**Runtime**

- [ ] Code stays on the one runtime the repo targets; runtime-only code stays in the server,
      scripts, runner and tests.
      Applies when the repo targets one fixed runtime.
      (example) the Node server (`adapter-node`); `node:crypto` is fine, `node:fs`, child processes and embedded Postgres stay in the Node server, scripts, runner and tests.
- [ ] No unbounded accumulation of wide rows or parallel work over an unbounded list; long work does
      not assume it outlives the response unless it uses the platform's own mechanism.
      (example) `Promise.all` over an unbounded list.
- [ ] Secrets differ per environment and come from the platform's private configuration; nothing
      secret is exposed to the client bundle.
      (example) `$app/env/private`.

---

## Lane 2 - Tenant isolation, secrets and untrusted text

**Tenant isolation (a break here is a BLOCKER)**

- [ ] **Every tenant query runs inside the tenant context**, transaction-local, connected as the
      non-owning runtime role. Request code never uses the owner handle. Without an org, no tenant
      row is visible: a call that forgot its context must read nothing, and a test should show it.
      Applies when the repo is multi-tenant or uses row-level security.
      (example) `withTenant` in `src/lib/server/db/tenant.ts` (`set_config(..., true)`), the `app_runtime` role (`db/security.ts`, `RUNTIME_ROLE`); `DATABASE_OWNER_URL` is for migrations and scripts.
- [ ] **Org and project walls both hold.** Project scoped tables are narrowed by project whenever the
      operation works in one project; an operation that takes a project id from the request verifies
      it belongs to the caller's org and that the caller may reach it (live role).
      Applies when the repo has org and project scoping.
      (example) narrowing by `projectId`, RLS for the org wall.
- [ ] **Ids are validated before reaching the database**; an id or slug is never concatenated into
      SQL text. Query parameters only.
      (example) `uuidOrEmpty` in `tenant.ts`; `sql` template parameters.
- [ ] A new table is defined through the tenant registry so it gets forced row-level security,
      grants and policies generated. A table outside the registry that holds org data, or a
      hand-written policy that differs, is a finding. Tables with no tenant data are listed as such
      on purpose.
      Applies when the repo uses a tenant table registry.
      (example) `tenantTable(...)` in `db/schema/helpers.ts`, `TENANT_TABLES`, `db/security.ts`; `PLAIN_TABLES` / `USER_TABLES` for users, OAuth clients, device codes and auth tables.
- [ ] Cross-org entry points (an org slug lookup, a token lookup by its org id prefix) use the narrow
      fields that expose one row, not a wide read.
      Applies when the repo is multi-tenant.
      (example) the narrow `Tenant` fields (`orgSlug`).
- [ ] Seed and test data never run on a real database; an importer sets the tenant context for what
      it writes.
      (example) `db/seed.ts`, `db/seedAuth.ts`, `tests/support/db.ts`, `importer/`.

**Secrets (never returned, never logged)**

- [ ] **No password, token, key, client secret, device code, master key or sealed value is returned**
      by an operation, the public API, an agent tool, a page load, a backup or export, or written to
      a log, an activity event or an error message. Check the selected columns: a table read as a
      whole may carry a hash or ciphertext column.
      (example) `backup/`, `ops/export.ts`.
- [ ] **Project secrets use the repo's vault**: sealed with the org data key, bound to org, project
      and name, wrapped by the master key. No second encryption scheme, no plaintext copy in a row, a
      URL, a job payload or a runner config.
      Applies when the repo stores project secrets.
      (example) `src/lib/server/secrets/vault.ts`, wrapped by `AFB_MASTER_KEY`.
- [ ] Secrets in helper processes (token store, sign-in) live outside the repo and out of the logs; a
      screenshot or report never includes a field that held one.
      Applies when the repo ships a runner or bridge.
      (example) `shots.ts`, `checks.ts`.
- [ ] Constant-time comparison or hashing for tokens and webhook signatures, never `===` on a secret.
      (example) `timingSafeEqual`.

**Untrusted content (guest-written text)**

- [ ] **All Markdown is rendered through the repo's one sanitising renderer**: no raw HTML, safe link
      and image schemes only, and guest (untrusted) text gets no images. No raw HTML insertion on
      anything that did not come from that renderer, and no second Markdown or HTML path.
      Applies when the repo renders text written by guests or other untrusted people.
      (example) `src/lib/markdown.ts`; no `{@html}` outside it.
- [ ] Guest text in an email, a chat-style notification or a filename is escaped for its target; it
      never becomes a command line argument, a path, a header or HTML.
      (example) `email/templates.ts`.
- [ ] Uploads check size, type and ownership on the way in and are served with a safe content type
      and disposition, never inline from the app origin when the type is script-capable.
      Applies when the repo accepts uploads.
      (example) `ops/attachments.ts`, `routes/api/v1/files`.
- [ ] Rendering cost is bounded: one huge document cannot stall a page.
      (example) `MAX_RENDER_CHARS`, the cache limits.

---

## Lane 3 - Database (schema, migrations, row-level security)

**Schema and generation**

- [ ] Schema changes are made in the schema files and the migration comes from the repo's generator,
      committed with its snapshot and journal entry. A hand-edited generated file, a missing
      snapshot or a journal that disagrees with the files is a finding.
      Applies when the repo has a database schema with generated migrations.
      (example) `src/lib/server/db/schema/*.ts` and `yarn db:generate`, with its `meta/` snapshot and journal.
- [ ] **An already-applied migration is never edited.** Fixes go in a new one. Numbering follows the
      journal; two files with the same number silently drop one.
      Applies when the repo has database migrations.
      (example) `0005_...` next after `0004_task_body.sql` at the time of writing.
- [ ] Custom SQL that the schema tool cannot express (RLS, grants, triggers) lives in one known place
      or a reviewed custom migration, with a header comment saying what it does and why.
      (example) `db/security.ts`.
- [ ] New columns: every `NOT NULL` column has a default or the insert supplies it, in every
      operation, the seed, the importer and the test support. Check the table definition, not
      memory.
      (example) `db/seed.ts`.
- [ ] Foreign keys and delete rules are explicit and keep the org wall (a child row never points to
      a parent in another org). Counters use an atomic per-scope row, not `max()+1`.
      (example) `db/numbering.ts`.
- [ ] Indexes exist for the new filters and sorts; no N+1 inside an operation.
      (example) org, project, status, number.

**Security**

- [ ] Forced RLS and grants for the new table are produced by the registry (see lane 2). The runtime
      role gets only the grants it needs; it never owns tables.
      Applies when the repo uses row-level security.
      (example) the `app_runtime` role.
- [ ] Policies are checked for both read and write (`using` and `with check`), by a test that covers
      every registered table on a real database.
      Applies when the repo uses row-level security.
      (example) `tests/db/isolation.test.ts` on the embedded real PostgreSQL.
- [ ] Any `security definer` function sets `search_path`; nothing is granted to `public` by accident.
      Applies when the repo's database supports `security definer` functions.
      (example) PostgreSQL.
- [ ] No secret literal in SQL or a migration.

**Data safety**

- [ ] Every `update` / `delete` / backfill has a `where` whose row count is stated, or a verification
      query is supplied. Wide or destructive statements are flagged for the user.
- [ ] Multi-statement changes are transactional; backfills are idempotent where a re-run is plausible.
- [ ] A migration is checked on a real throwaway database as the non-superuser owner with the runtime
      role as the app role, not on anything else. Say in `{KNOWN_UNVERIFIED}` if it was not. A
      database the user keeps is never reset, dropped or emptied for this, and a database URL from
      `.env` is never used.
      (example) `tests/support/db.ts`, with `app_runtime` as the app role.
- [ ] Backup and restore still cover the new table, and a restore refuses a dump of another shape
      loudly.
      Applies when the repo has backup or restore code.
      (example) `src/lib/server/backup/`.
- [ ] Generated validation schemas are regenerated for new or changed columns and their test still
      passes.
      Applies when the repo generates validation schemas from the data model.
      (example) `db/zod.ts` and `zod.test.ts`.

---

## Lane 4 - UI (components, styling, design tokens)

**Colour and theme (BLOCKER if a literal colour ships)**

- [ ] **Colours are tokens only**, read from the repo's design tokens. No literal colour values in a
      component, and the repo's lint rule for literal colours is clean.
      Applies when the repo has design tokens.
      (example) CSS variables from `src/lib/theme/` (`bg-[var(--surface)]`, `text-[var(--ink)]`, `border-[var(--line)]`); no `#fff`, `rgb()`, `hsl()`, `bg-white`, `text-black`, `bg-[#2563eb]`; `afb/no-literal-colours` (`eslint-rules/`).
- [ ] **Theme modes work without variant hacks.** A token changes with the mode. Anything rendered
      outside the root layout (portal, popover moved to the page body) carries the mode onto its own
      root.
      Applies when the repo has more than one theme mode.
      (example) `data-mode="light|dark"` on `<html>`, no `dark:` variant; `src/lib/ui/Popover.svelte` and `ResponsiveModal.svelte` copy it.
- [ ] Danger, warning, success and info use their fixed tokens, never an org palette; a status never
      uses the accent and the accent never carries a status. Text on a tinted surface uses the
      matching ink.
      Applies when the repo has status tokens and an accent.
      (example) `--accent-text` on `--accent-soft`.
- [ ] **Checked in every theme mode.** A screen that only passed the type check has not been checked.
      Applies when the repo has more than one theme mode.
      (example) light and dark.
- [ ] Type uses only the fonts the repo's design rules name; nothing loaded from a remote font host.
      Tables use tabular figures.
      Applies when the repo has design rules for fonts.
      (example) Poppins (text), Bricolage Grotesque (headings and bold, applied by the rule in `src/app.css`) and Geist Mono (ids, hashes, code) per `DESIGN.md`.

**Framework correctness**

- [ ] State uses the primitives the repo's framework and rulebook call for, not an older pattern.
      Applies when the repo uses a reactive UI framework with a rulebook on state.
      (example) Svelte 5 runes (`$state`, `$derived`, `$props`, `$effect`, `$bindable`, snippets); no `export let`, no `$:`.
- [ ] An effect that syncs form state from props guards its own writes and keeps a previous-value
      check; otherwise it loops and wipes keystrokes.
      Applies when the repo has reactive effects that sync form state.
      (example) `$effect` with `untrack()` for internal writes.
- [ ] Derived values use the framework's derived primitive instead of an effect that assigns state.
      Applies when the repo uses a reactive UI framework.
      (example) `$derived`.
- [ ] Modals mount with their open flag, never inside a conditional block, use snippets or slots for
      header and footer, a focus trap on the panel and a scroll lock on the body, and keep their data
      through the close transition. No native `confirm()`, `alert()` or `prompt()`.
      Applies when the repo rulebook sets modal conventions.
      (example) `ResponsiveModal`, `ConfirmDialog` with `open={boolean}`, never inside `{#if}`; `focusTrap`, `scrollLock` in `src/lib/actions/`.
- [ ] A keyed list key is an id, never a display value. Lists passed to a select have unique values.
      (example) a keyed `{#each}`; `Select`.
- [ ] No eager relative fetch during server rendering; client-only loading behind a lifecycle hook or
      a browser guard.
      Applies when the repo renders on the server and the client.
      (example) `onMount`.
- [ ] Raw HTML insertion only on output of the repo's one sanitising renderer (lane 2).
      Applies when the framework offers raw HTML insertion.
      (example) `{@html}` only on output of `src/lib/markdown.ts`.

**Conventions**

- [ ] Styling follows the repo's convention, with no blocks or variables the rulebook forbids.
      Applies when the repo rulebook sets a styling convention.
      (example) zero `<style>` blocks and no component-level CSS variables; inline `style=""` only for a multi-stop gradient or runtime layout coordinates, with an UPPERCASE comment saying why.
- [ ] Imports, section order and comment style follow the repo rulebook.
      Applies when the repo rulebook sets file conventions.
      (example) imports in nine groups in the order of the root `CLAUDE.md`, with no blank lines; component sections in the fixed order; UPPERCASE section headers (`// -- STATES -- //`), sentence-case notes.
- [ ] Icons come from the repo's one icon set. Every image has alt text (empty for decoration, a real
      description otherwise).
      (example) `import Name from 'phosphor-svelte/lib/Name'`; `<img alt="">`.
- [ ] Every clickable element has a pointer cursor, and a not-allowed cursor where it can be disabled.
      Applies when the repo rulebook sets cursor conventions.
      (example) `cursor-pointer`, `disabled:cursor-not-allowed`.
- [ ] A sideways-scrolling row (tabs, chips) follows the repo's scroll-row recipe.
      Applies when the repo rulebook has such a recipe.
      (example) `overflow-x-auto` with `overflow-y-hidden`, scrollbar hidden with `[scrollbar-width:none]!` and `[&::-webkit-scrollbar]:hidden`, active item centred with the row's own `scrollTo`.
- [ ] **Existing comments are preserved.** Deleting architectural notes is HIGH, not LOW.
  Applies when the repo rulebook asks for comments to be kept.

**Phones**

- [ ] Every tap target at least 44 by 44 px; nothing scrolls sideways at phone width; same type scale
      as desktop.
- [ ] Wide data tables stay real tables inside a scroll container, or follow what the nearest sibling
      does.
- [ ] Loading placeholders match the final layout so nothing jumps; empty, error and
      permission-denied states use the repo's shared components.
      Applies when the repo has such shared components.
      (example) `RouteSkeleton`, `Skeleton`, `#afb-boot` in `src/app.html`; `EmptyState`, `ErrorState`, `PermissionDenied`.

---

## Lane 5 - Protected surfaces (always check; any hit is a BLOCKER unless the user explicitly asked)

- [ ] **Applied migrations** are not edited, renamed or deleted.
      Applies when the repo has database migrations.
      (example) `src/lib/server/db/migrations/`.
- [ ] **Generated security SQL** is not hand-patched around the tenant table registry; the registry
      stays the single source of RLS.
      Applies when the repo generates row-level security from a registry.
      (example) `db/security.ts` (ADR-021).
- [ ] **Technical ids keep their names**: package names, the server name agents connect with, the
      snapshot format, the user-agent and the connection name. The display name is for people.
      Applies when the repo rulebook lists technical ids.
      (example) `@agent-flow-board/bridge`, the MCP server name, the connection name `afb-<org-slug>` (older connections used `agent-flow-board`); the display name "Agent Flow Board" (`DESIGN.md` "Name").
- [ ] **A published protocol** keeps its thin-forwarder shape and its version check, so existing
      connections keep working after a server update.
      Applies when the repo ships a bridge or similar forwarder.
      (example) the bridge protocol (ADR-030).
- [ ] **The design document and the token files** are changed only on purpose and with a plan. Colour
      values live only in the token files and the palette generator.
      Applies when the repo has a design document or token files.
      (example) `DESIGN.md`.
- [ ] Tooling folders and lockfile handling follow the repo rulebook: `node_modules` and `.git` are
      never deleted, and the lockfile of the package manager the rulebook names is the only one.
      (example) Yarn 4 only; `yarn.lock` is committed; no `package-lock.json` or `pnpm-lock.yaml`.
- [ ] Nothing was pushed, committed, branched or given a Claude or Anthropic attribution line.
- [ ] No change reaches anything live or non-local (a deployed site, a shared or production
      database, a real third-party org, a local server the user started) without the user
      confirming first. A live site is not a target for browser checks.

---

## Lane 6 - Tests

- [ ] New behaviour has a test that would fail without the change (check by reasoning about it, or by
      reverting mentally). A test that passes on the old code proves nothing.
- [ ] The test lives in the folder the repo's layout expects for its kind.
      (example) `tests/ops` (verbs and API), `tests/db` (schema, RLS, seed), `tests/auth`, `tests/mcp`, `tests/unit`, `tests/checks` (Playwright), `tests/runner`, `packages/*/src/*.test.ts`, `src/**/*.test.ts` next to pure code.
- [ ] **Isolation and access tests assert no side effect behind a refusal** (the row was not written,
      the job was not queued, the mail was not sent), not only the status or error code, and cover
      each role and a token with caps and project limits.
      Applies when the repo has roles or scoped tokens.
      (example) `owner`, `admin`, `member`, `viewer`, `guest`.
- [ ] A new tenant table is covered by the isolation test through the registry; a new operation has a
      case for a role that must be refused.
      Applies when the repo is multi-tenant.
      (example) `tests/db/isolation.test.ts`.
- [ ] Tests that enumerate files or tables at run time assert the enumeration is non-empty.
- [ ] Mocks do not replace the thing under test; database tests use a real database handle, and error
      paths are exercised.
      (example) `tests/support/db.ts` (embedded PostgreSQL).
- [ ] Browser checks run against a build preview, sign in through the real page with the seeded
      people, and wait on a condition, never an unconditional sleep.
      Applies when the repo has browser checks.
      (example) `tests/checks/*.spec.ts`, `yarn test:checks`, `seed owner`, `seed admin`, `seed member`, `seed viewer`.
- [ ] No invariant test was weakened to pass (see `SKILL.md` Step 3).

---

## Lane 7 - Design fit (user-facing screens)

From the user's repeated reports of screens that were bigger or more confusing than the rest of the app.
Paste into the Lens F subagent whenever the diff has markup or style changes. If the repo rulebook says
there are no UI shots, the reviewer works from the code and the design rules, and says what it could not see.
The ruler is the repo's design-fit list, design document and size scale, if it has them.
(example) the nine-step Design fit list in the root `CLAUDE.md`, `DESIGN.md` and `tests/ui-shots/scale.json`.

- [ ] The code matches the item's `design-brief` section and follows what the plan's mockup says to keep when there is one (the project's real components come first, and the design brief records what was kept, adapted and dropped),
      and any difference was shown to the user. An unapproved difference is a `HIGH`.
- [ ] No element larger than its sibling at the same level (title, section, body, label,
      primary button, button, input, card, row, icon). Emphasis comes from weight or colour tokens,
      not size.
- [ ] No new size, radius or spacing value outside the repo's scale; shared components and the
      sibling pages' patterns are reused. A second kind of dialog, tab bar or card is a design finding.
      Applies when the repo has a size scale or component library.
      (example) `tests/ui-shots/scale.json`, `src/lib/ui/`.
- [ ] One primary action per view at the primary button size; labels are plain questions or actions;
      every form field states its own font size, shared by labels, fields and the submit button of
      one form; a money or limit answer shows a live worked example before saving.
      (example) `button-primary`.
- [ ] Pictures stay small (at most about 12% of the first screen, never in front of the first action).
- [ ] Every theme mode and both a desktop and a phone width are handled by the classes: phone has no
      sideways scroll and tap targets of at least 44 px.
      (example) `light` and `dark`, 1440 and 390.
