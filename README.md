# agent-flow-board

A team board for plans that people and coding agents work on together. Each piece of work is an **item** with a plan of phases and steps, decisions, documents, a log and files. People see it in a web app. Agents read and write the same items through an MCP server, a REST API or a small command line bridge, so a plan stays true while the work is done.

It runs for many organisations, each with many projects and many people, on one server. You can run it yourself (a VPS with Docker, or Cloudflare) and import an existing HAPR board into it.

## What it does

| Area       | What you get                                                                                                                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plans      | Items with phases, counted steps, manual checks, ADRs, a "Settled without asking" list and free documents. Percent and status are calculated from the steps and move by themselves where the rules say so.                                                                                   |
| People     | Owners, admins, members, viewers and guests, per organisation and per project. Invitations by email. Sign in with email and password or Google.                                                                                                                                              |
| Agents     | An MCP server at `/mcp`, a REST API at `/api/v1` (OpenAPI at `/api/v1/openapi.json`), personal access tokens, OAuth for tools that support it, a device code flow, and a local stdio bridge. Hooks for Claude Code, Antigravity and Gemini CLI keep a session bound to the item it works on. |
| Live       | Every open page updates as items change. A change can be undone for 30 days.                                                                                                                                                                                                                 |
| Checks     | Browser checks that close a step only when they pass on the right target, UI shots that measure a new screen against the pages around it, and a runner program (local or hosted in a container).                                                                                             |
| Publishing | A cancellable, scheduled copy of a project's public items to a GitHub repository, through a GitHub App.                                                                                                                                                                                      |
| Backups    | Encrypted nightly backups of every organisation, a restore command, and a health panel that shows when one is late.                                                                                                                                                                          |
| Import     | A read-only importer for a HAPR `.board`, with a report that compares every fact by content.                                                                                                                                                                                                 |

## Run it on your machine

You need Node 24 and Yarn 4. The Yarn program is in `.yarn/releases`, so a plain `yarn` runs it and nothing else is installed.

```
yarn install
node tests/runner/preview.mjs
```

That builds the app and serves it at http://localhost:5180 with demo organisations and people (read from `.env.test`; the shared sign in password is `seed-password-for-previews` and must never reach a deployment). Sign in as `owner@acme.example`.

For development, copy `.env.example` to `.env`, set `AFB_BASE_URL=http://localhost:5173`, a `BETTER_AUTH_SECRET` of 32 or more characters, `AFB_AUTO_MIGRATE=1` and, for demo data, `AFB_SEED_DEMO=1`, then run `yarn dev`.

A local PGlite folder is the database unless `DATABASE_URL` is set. Every variable is described in `src/env.ts`, and a missing required one stops the app at start with a plain message.

## The gates

| Command                                       | What it checks                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `yarn run check`                              | Types and Svelte warnings                                                  |
| `yarn eslint .` and `yarn prettier --check .` | Lint and format                                                            |
| `yarn run check:packages`                     | The runner and the importer type check                                     |
| `yarn test`                                   | Unit and operations tests on PGlite and on a real PostgreSQL               |
| `yarn run test:checks`                        | Browser checks on the build preview (never the dev server)                 |
| `yarn run ui-shots`                           | The product's own UI shots over `tests/ui-shots/ui-changes.md`             |
| `yarn perf`                                   | First load JavaScript and response times against `tests/perf/budgets.json` |

## Run it for real

| You want                                          | Read                                             |
| ------------------------------------------------- | ------------------------------------------------ |
| A VPS with Docker, PostgreSQL and automatic HTTPS | [docs/self-hosting.md](docs/self-hosting.md)     |
| Cloudflare Workers, Hyperdrive, R2 and Queues     | [docs/cloudflare.md](docs/cloudflare.md)         |
| Your coding tools connected                       | [docs/connect-tools.md](docs/connect-tools.md)   |
| Browser checks and UI shots                       | [docs/runners.md](docs/runners.md)               |
| Publishing to GitHub                              | [docs/github-app.md](docs/github-app.md)         |
| An existing HAPR board brought in                 | [docs/importing-hapr.md](docs/importing-hapr.md) |

## How it is built

- SvelteKit 3 with Svelte 5 runes and Tailwind 4. `adapter-node` for a server, `adapter-cloudflare` for Workers.
- PostgreSQL through Drizzle. Every tenant table has forced row level security, and the app connects as a role that does not own the tables. PGlite stands in for PostgreSQL in development and tests.
- One operations layer (`src/lib/server/ops/`). The pages, the REST API, the MCP server and the commands all call it, and each verb reads the caller's live role.
- Better Auth for sign in, with the OAuth 2.1 and device flows for tools written beside it.
- `packages/runner` (the browser check runner), `packages/bridge` (the MCP stdio bridge and the tool hooks), `importer/` (the HAPR importer), `design/` (the brand and the size scale).

The plan, the decisions and the loophole register this was built from live in the HAPR Board item FLOW-20261014-1047.

## Security in one paragraph

Tenants are separated twice: every query filters by organisation and project, and PostgreSQL enforces it again with row level security set inside each transaction. A token's permissions are an upper limit, and the person's current role is read on every call. Secrets (test account passwords, tokens, keys) are never returned by any call and never written to a log; test account passwords are sealed with a per-organisation key wrapped by `AFB_MASTER_KEY`. Anything a guest writes reaches an agent marked as untrusted. Report a problem privately to the maintainers rather than in a public issue.
