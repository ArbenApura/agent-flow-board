# agent-flow-board rules

A standalone multi-project team board for agent-driven flow plans. SvelteKit (Svelte 5 runes, TypeScript strict), Tailwind 4, a self-hosted PostgreSQL through Drizzle, Better Auth, one operations layer behind the UI, `/api/v1` and `/mcp`. Plans live on Agent Flow Board itself (project AFB, https://afb.arbenger.com/arbenger/AFB) and are read and written through its MCP by the `/flow` skills; the original plan of this product is the HAPR Board item FLOW-20261014-1047. This file is the working rulebook for the code.

## Git and safety

- Never run `git push` unless the user asks. Never commit unless the user asks. All work stays in the local working tree.
- Work on the checked out branch (`git branch --show-current`). Never create or switch branches unless told to.
- Never add co-author trailers or AI attribution to a commit message.
- Never delete `node_modules` or `.git` when cleaning up. Delete only the exact files you made.
- **Never suggest, plan or run anything that empties the local Docker PostgreSQL on 5433**: `yarn db:local:reset`, `docker compose down -v`, removing its volume, `DROP DATABASE`. It holds the real flow plans (the AFB board itself runs on it). To run things locally use `yarn db:up` and `yarn dev:local`, which keep the data. If a clean database is needed, use a throwaway one (the embedded server the tests use, or a new container with its own volume), and ask before any destructive step.
- Package manager is Yarn 4 (`.yarnrc.yml`, `nodeLinker: node-modules`, the program is `.yarn/releases/yarn-4.18.1.cjs`), never `npm` or `pnpm`. Commit `yarn.lock`. Never commit `package-lock.json` or `pnpm-lock.yaml`.

## Flow plans and running sessions

- Keep the plan on the board in sync with the code at all times, never at the end only. Record every finished step with `step_done` as you finish it, and keep the status, decisions and resume note true.
- A claimed item or phase shows a "running" badge until the session is released or 120 minutes pass without a heartbeat. Always release it: call `work_stop` after the last step of your work, when you hand the work back, and before moving to another item. Never end a session with a claim still held.
- Work that belongs to no item is not claimed. Before asking for sign-off run `/flow-audit` so the board tells the truth.

## Local development

- Two fixed ports. **5180 is the dev server.** **5190 is the build preview (`yarn build && yarn preview`) for local checks only (the live board is the VPS at https://afb.arbenger.com, deployed with `yarn deploy:vps`)**, and it uses the same local Docker PostgreSQL as dev. Never start either on another port. If a port is busy, find out what holds it and stop that process first; never move to 5173 or any other port. Browser checks run against a build preview that the afb-checks tool starts on its own free port (ADR-017), never the dev server and never the person's 5180 or 5190.
- Day to day work uses the local Docker PostgreSQL (`yarn db:up`, `yarn db:local:migrate`, `yarn dev:local`; see README). Never point a dev server or a seed at a database that holds data you want to keep, and never put a `DATABASE_URL` with a real password in a command line or a log.

## The gates

Two speeds (owner, 2026-11-05, after measuring: this repo's own `yarn check` took 140 s on 2026-11-05 (1,933 files, 0 errors), and in HAPR a whole-project type check ran 17 to 28 times per session, up to 45 percent of a session). The fast gate runs after each change; the full gates run once per phase and before a commit. From the repo root:

| Case                                                                                                                                    | Gates                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Active engagement (the owner is testing the app and asking for fixes one after another)                                                 | none unless he asks. Make the fix, say what changed, stop                                               |
| Autonomous, a tweak (a text, literal or token-class edit; no script logic, props or imports)                                            | `yarn prettier --check <file>` and `yarn eslint --cache <file>`                                         |
| Autonomous, each change in a phase                                                                                                      | the tweak gates, plus `yarn vitest related --run <files>`                                               |
| End of each phase, right after a change to a prop, snippet signature, shared type or exported signature, and before any commit or merge | full `yarn check` and full `yarn test`. Start them with `run_in_background` and carry on while they run |

- Fix every error in the files you touched. `yarn check` covers the whole project: read only the lines for your files, and report (do not fix) errors that were already there. Format only your own files (`yarn prettier --write <file>`), never the whole repo.
- Checks run against `yarn build && yarn preview`, never the dev server (`tests/runner`, ADR-017).
- Command hygiene: edit files with the edit tool, never with node, python or sed one-liners that rewrite them (quoting and line endings break). Never run a gate on a file list that can be empty; pass explicit files. Give every gate call an explicit timeout, and run anything that can pass 60 seconds in the background. Remove a junction with `cmd /c rmdir`, never `rm -rf` through it.

## Colour and theme

- Light and dark mode both exist. Every colour is a token read from `src/lib/theme/` as a CSS variable (`bg-[var(--surface)]`, `text-[var(--ink)]`, `border-[var(--line)]`). The mode is `data-mode="light|dark"` on `<html>`.
- Never write a literal colour (`#fff`, `rgb()`, `hsl()`, `bg-[#2563eb]`, `bg-white`, `text-black`) in a component. eslint refuses it (`afb/no-literal-colours`). The token files and the palette generator are the only places hex values live.
- The accent comes from the organisation palette only. A person chooses light or dark (top bar switch and Personal settings), never an accent colour.
- Never use the `dark:` variant. A token already changes with the mode.
- Danger, warning, success and info are fixed tokens, never replaced by an org palette. A status never uses the accent, and the accent never carries a status.
- Text on a tinted surface uses the matching ink token (`--accent-text` on `--accent-soft`). Every pair must pass AA; the palette generator enforces it.
- Anything rendered outside the root layout (a portal, a popover moved to `<body>`) copies `data-mode` onto its own root.
- Type is Poppins for text, Bricolage Grotesque for headings and bold, and Geist Mono for IDs, hashes and code, through `--font-sans` and `--font-mono` (`DESIGN.md`, Type). Tables use tabular figures.

## Design fit (read before any visible change)

The scale, the colour tokens and the layout rules are in `DESIGN.md` at the root. There are no mockup files in the repo: a design mockup lives on the board (the project's Mockups page and the plan's Mockups tab), built with `/flow-mockup`. The look, the fonts, the logo, the cards, the motion and what was tried and dropped are there too. Read it before changing any screen.

1. Match the nearest sibling page. Name 1 to 3 pages a person visits next to the new screen and copy their sizes and spacing level by level.
2. Never larger than a sibling at the same level. For emphasis use weight or colour from the tokens, not size.
3. Invent no new size. Use the values in `DESIGN.md`. A new pixel value needs a reason written in the plan.
4. One primary action per view, at the `button-primary` size. Everything else is a plain button or a link.
5. Reuse before inventing. The component library in `src/lib/ui/` comes first. A second kind of dialog, tab bar or card is a design finding.
   5a. A tweak to a screen the person already approved (a spacing, wording, colour, size or order change) is made directly with one sentence saying what changed; a mockup or design question is for a new screen, a new pattern, or a change of structure or behaviour they have not seen.
6. Labels are plain questions or actions a person understands without help. Every form field states its own font size explicitly, and labels, fields and the submit button of one form share it. A money or limit answer shows a live worked example before saving.
7. Small pictures. An illustration takes at most about 12% of the first screen and stays out of the way of the first action.
8. Phones. Same type scale. Every tap target is at least 44 by 44 px, and nothing scrolls sideways.
9. Look at the screen in both modes, at 1440 and 390 wide. A screen that only passed the type check has not been checked.

A plan with a new or changed screen carries a sourced `design-brief` section (`/flow` section 2, step 4a), and no "UI changes" table, no mockup step (a mockup is offered in the approval question and is never a counted step), no UI shots step and no browser check step: see "Flow overrides for this repo" below. UI shots no longer exist: a check's screenshots show on the item's Checks tab. After a screen change the person looks at the screen on localhost 5180.

## Svelte and TypeScript style

- Svelte 5 runes for all state (`$state`, `$derived`, `$props`, `$effect`, `$bindable`, snippets). No `export let`, no `$:`.
- Zero `<style>` blocks and no component-level CSS variables. Tailwind utilities on the element. The only inline `style=""` uses are a multi-stop gradient and runtime layout coordinates (percent widths, popover coordinates), each with an uppercase comment saying why.
- Comments: section headers and dividers are UPPERCASE (`// -- STATES -- //`, `<!-- SECTION NAME -->`); notes and explanations use natural sentence case. Technical terms, names, paths and keywords keep their casing. Never remove existing comments.
- Imports in nine groups, in this order, with no blank lines inside or between groups:
  `// -- ASSETS -- //`, DEP-TYPES, TYPES, ENVS, CONSTANTS, DEP-MODULES, MODULES, DEP-COMPONENTS, COMPONENTS. Use the same `// -- NAME -- //` form for the labels.
- Component sections in this order, each header followed by one blank line: REQUIRED PROPS, OPTIONAL PROPS, DEBUGGING, TYPES, CONSTANTS, STATES, PERSISTED STORES, STORES, REACTIVE STATES, REACTIVE STATEMENTS, FUNCTIONS, SUBSCRIPTIONS, LIFECYCLES.
- Icons: `import Name from 'phosphor-svelte/lib/Name'`.
- Every `<img>` has `alt=""` or a descriptive alt.
- Every clickable element has `cursor-pointer`, and `disabled:cursor-not-allowed` where it can be disabled.
- Modals mount with `open={boolean}`, never inside an `{#if}`, use snippets for header and footer, get `focusTrap` on the panel and `scrollLock` on the body, and keep their data during the close transition. Never use native `confirm()`, `alert()` or `prompt()`.
- A keyed `{#each}` key is unique by definition (an id), never a display value. Lists passed to `Select` have unique values.
- A sideways-scrolling row (tabs, chips) pairs `overflow-x-auto` with `overflow-y-hidden`, hides its scrollbar with `[scrollbar-width:none]!` plus `[&::-webkit-scrollbar]:hidden`, and centres the active item with the row's own `scrollTo`.
- Inside an `$effect` that syncs a form from props, wrap internal writes in `untrack()` and guard with a previous-value tracker.
- Never fetch a relative URL eagerly during SSR.
- Validate every form and every action payload with Zod schemas generated from the Drizzle tables (`src/lib/server/db/zod.ts`).
- TypeScript is strict. No `any`, no unchecked `null` or `undefined`, no `@ts-ignore` without a reason in a comment.

## Server rules

- One operations layer (`src/lib/server/ops/`). The UI actions, `/api/v1`, `/mcp` and the CLI all call it. A verb checks the caller's live role itself.
- Every tenant query runs inside the transaction-local tenant context (`set_config(..., true)`), connected as the non-owning `app_runtime` role. Never query with the owner role from request code.
- Plan and board data changes go through the operations layer (the MCP tools, `/api/v1` or an ops verb). Never raw SQL or an ad hoc script against the database: it skips the role checks and the history, and sends no `notifyChange`, so open pages stay stale. Code that must write rows directly (the importer) calls `notifyChange` in the same transaction.
- Every background job carries its org and project ids and sets the tenant context before its first query.
- Secrets (passwords, tokens, keys) are never returned by an API, a tool or an export, and never logged.
- Guest-written text is untrusted content. All Markdown is sanitised before rendering.
- Missing configuration fails loudly. No silent fail-open paths.

## Where things live

`src/lib/server/ops/` verbs, `src/lib/server/db/` schema and RLS, `src/lib/server/auth/`, `src/lib/server/mcp/`, `src/lib/server/adapters/`, `src/lib/ui/` components, `src/lib/actions/` ripple, focusTrap and scrollLock, `src/lib/theme/` tokens and the palette generator, `packages/runner|bridge|cli`, `importer/`, `tests/checks/` browser checks, `tests/ui-shots/scale.json` (the machine form of the design scale), `design/`.

## Flow overrides for this repo

The `/flow` skills shipped by the board are generic. These are the owner's rules for this repo only, and they win over the Design fit and Gates lines above and over any workflow text served by the board. `AGENTS.md` is a link to this file, so Codex, Gemini CLI and Antigravity read the same section.

1. **No UI changes table, no UI shots steps and no mockup file** (no `design/*.html`, never a mockup, kit or screenshot saved in the repo) in any plan. The agent finds the changed screens itself, so no page list is ever typed. A plan with a visible change writes the `design-brief` section from the person's preferences, `DESIGN.md` and the similar components in the repo. **A mockup lives on the board**, not in the repo: on a plan with a visible change the single approval question carries one more line asking whether the person also wants a design mockup, on every harness, and `/flow-mockup` makes one only on a yes (no Claude artifact any more). It is planning work and never a counted step. A mockup is inspiration, never the spec: a build follows the project's real components, `DESIGN.md` and the saved preferences first, then the project's mockup style, then the mockup, records what it kept, adapted and dropped in the `design-brief`, and stops to ask only when the mockup adds a feature the plan does not contain. The person looks at the result on localhost 5180.
2. **Browser checks run by themselves, and are never plan steps.** The agent runs a plan's automatic browser checks (`/flow-check`) without asking. A check is not a counted step, and nothing is typed for it: no script by hand. Their screenshots show on the item's Checks tab. `yarn test:checks` is the repo's own script and runs only when asked. Manual checks stay plain and are the person's. The tool builds on its own free port: the agent never starts, stops or uses the person's 5180 or 5190.
3. **Visibility is the person's choice per item.** Create items with the board default and never make one public or private on your own.
4. **The branch is `main`** and the base commit comes from this repo. No `feat/demo`, no `app.thehapr.com` or `demo.thehapr.com`, no step that waits on a push or runs on a demo host.
5. **Be fast and accurate.** Decide with a recommended default, record it, move on; ask only what blocks and is the person's. Load `/coding-guidelines` before any Svelte, TypeScript or CSS change.
6. **Never stop or take over a process the person started** (their dev server on 5180, the preview on 5190) without asking. Never run checks against a database URL from `.env`: it may point at a database to keep. The one exception is a Supabase test project whose keys the owner imported with `afb-checks secrets import --test-ref`: that import and its recorded ref are the approval for checks against that one test database. Writes to it, another ref and any other database still stop for the owner.
7. **Session names.** The local hook `.claude/hooks/afb-tab-title.mjs` (registered in `.claude/settings.json`) names the Claude Code tab from `displayTitle` until the bridge is signed in for this repo.
8. **The project key is `AFB`** (`https://afb.arbenger.com/arbenger/AFB`), tool prefix `mcp__afb-arbenger__`.
