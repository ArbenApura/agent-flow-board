# agent-flow-board

A team board for plans that people and coding agents work on together. Each piece of work is an **item** with a plan of phases and steps, decisions, documents, a log and files. People see it in a web app. Agents read and write the same items through an MCP server, a REST API or a small command line bridge, so a plan stays true while the work is done.

It runs for many organisations, each with many projects and many people, on one server. You run it yourself, on a server with Docker and its own PostgreSQL, and you can import an existing HAPR board into it.

The live board is at https://afb.arbenger.com. This product is planned on itself, in the project AFB (https://afb.arbenger.com/arbenger/AFB).

## What it does

| Area    | What you get                                                                                                                                                                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plans   | Items with phases, counted steps, manual checks, ADRs, a "Settled without asking" list and free documents. Percent and status are calculated from the steps and move by themselves where the rules say so.                                                                                     |
| People  | Owners, admins, members, viewers and guests, per organisation and per project. Invitations by email. Sign in with email and password or Google.                                                                                                                                                |
| Agents  | An MCP server at `/mcp`, a REST API at `/api/v1` (OpenAPI at `/api/v1/openapi.json`), personal access tokens, OAuth for tools that support it, a device code flow, and a local stdio bridge. Hooks for Claude Code, Antigravity and Gemini CLI keep a session bound to the item it works on.   |
| Live    | Every open page updates as items change. A change can be undone for 30 days.                                                                                                                                                                                                                   |
| Checks  | Browser checks that close a step only when they pass on the right target and show their screenshots, and a runner program (local or hosted in a container).                                                                                                                                    |
| Notes   | A Notes area per project: Markdown notes in folders with versions, links to plans and tasks, and a Turn into a plan or tasks action. Agents read and search notes through the MCP tools `note_list` and `note_get` (references `N-<n>`) and write one only when the user asks in that session. |
| Backups | Encrypted nightly backups of every organisation, a restore command, and a backup status in Organisation settings that shows when one is late.                                                                                                                                                                            |

## Run it on your machine

You need Node 24 and Yarn 4. The Yarn program is in `.yarn/releases`, so a plain `yarn` runs it and nothing else is installed.

```
yarn install
node tests/runner/preview.mjs
```

That builds the app, starts a throwaway PostgreSQL of its own for the run (the same embedded server the tests use) and serves the app at http://localhost:5180 with demo organisations and people (read from `.env.test`; the shared sign in password is `seed-password-for-previews` and must never reach a deployment). Sign in as `owner@acme.example`.

Localhost uses two fixed ports: **5180** is the dev server and **5190** is the local build preview (`yarn build && yarn preview`). `vite.config.ts` sets `strictPort`, so a second server fails instead of moving to another port. The live board is the server at https://afb.arbenger.com, deployed with `yarn deploy:vps`.

### Local development (Docker PostgreSQL)

For day to day work run a local PostgreSQL 17 in Docker. It keeps its data in a Docker volume, uses the same roles as production (`app_runtime` serves requests, so forced row level security applies), and listens on `127.0.0.1:5433` only.

```
yarn db:up              # start the container (Docker Desktop must be running)
yarn db:local:migrate   # tables, plus the app_runtime login
yarn dev:local          # http://localhost:5180 with demo data (owner@acme.example)
```

`yarn dev:local` sets its database and `AFB_BASE_URL` in the process, which takes priority over `.env`, so a `DATABASE_URL` in your `.env` stays untouched and cannot be seeded by accident. `yarn db:down` stops the container and keeps the data. `yarn db:local:reset` deletes the volume and rebuilds it empty: **it erases every plan in the local database, so never run it on a database you want to keep.** The passwords in `deploy/local/compose.yaml` and `package.json` are throwaways for this machine. The local owner is the `postgres` superuser, because the demo seed needs to write across organisations, which forced row level security blocks for a normal owner.

To run `yarn dev` against another PostgreSQL, put `AFB_BASE_URL=http://localhost:5180`, a `BETTER_AUTH_SECRET` of 32 or more characters and `DATABASE_URL` in `.env`. `DATABASE_URL` is the PostgreSQL connection of the app as the `app_runtime` role, and the app refuses to start without it. `AFB_AUTO_MIGRATE=1` and `AFB_SEED_DEMO=1` act on whichever database is in use, so leave them out of any `.env` that points at data you want to keep. Every variable is described in `src/env.ts`, and a missing required one stops the app at start with a plain message.

### Item references

A new item is named from its project key and the minute it was made in UTC, for example `HAPR-20261017-0950`. When two items of one project share a minute the second is `HAPR-20261017-0950-b`, then `-c`, up to `-z`. Older items were named `HAPR-2`, a key and a number. Every old name keeps working, because renaming an item keeps its old reference (and any HAPR Board id such as `FLOW-20261014-1047`) as an alias.

One script renames the older items. It is a dry run unless you add `--apply`: it prints, per organisation, what would change and writes nothing.

```
yarn db:local:rename-refs            # the local Docker database: dry run, prints every rename
yarn db:local:rename-refs --apply    # makes the changes, one transaction per organisation
yarn db:rename-refs                  # the DATABASE_URL set in your shell (required, it does not read .env)
```

An imported plan takes the date and time of its HAPR Board id (the Board wrote it in +08:00, so `FLOW-20261014-1047` becomes `HAPR-20261014-0247`); an item made here takes its creation time. An item already in the new form is left alone, so a second run changes nothing. For any `DATABASE_URL` other than the local script, `--apply` also needs `AFB_ALLOW_RENAME_REMOTE=1`. **Never run it with `--apply` on a real database before reading its dry run, and only when the owner has said to.** It reads the list of organisations with the owner connection and does everything else as `app_runtime`.

## The gates

| Command                                       | What it checks                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `yarn run check`                              | Types and Svelte warnings                                                             |
| `yarn eslint .` and `yarn prettier --check .` | Lint and format                                                                       |
| `yarn run check:packages`                     | The runner and scripts type check                                                     |
| `yarn test`                                   | Unit and operations tests on an embedded real PostgreSQL                              |
| `yarn run test:checks`                        | Browser checks on the build preview (never the dev server). Run on request, not in CI |
| `yarn perf`                                   | First load JavaScript and response times against `tests/perf/budgets.json`            |

CI (`.github/workflows/ci.yml`) runs check, check:packages, lint, format check, test and build on every push to `main`.

## Run it for real

| You want                                          | Read                                           |
| ------------------------------------------------- | ---------------------------------------------- |
| A VPS with Docker, PostgreSQL and automatic HTTPS | [docs/self-hosting.md](docs/self-hosting.md)   |
| Your coding tools connected                       | [docs/connect-tools.md](docs/connect-tools.md) |
| Browser checks                                    | [docs/runners.md](docs/runners.md)             |

## System skills

The `/flow` skills are shipped by the product as one versioned bundle, installed by people from **Connect a tool**, the **Skills** tab. There are no custom skills and no MCP prompts. See [docs/skills.md](docs/skills.md).

To release a change to a skill:

1. Edit it only in `src/lib/server/system-skills/skills/<name>/`. `.claude/skills/` is regenerated from there and is never edited by hand.
2. Bump that skill's `version` in `src/lib/server/system-skills/manifest.json`, bump `bundle.version` and `releasedAt`, and add a `changelog` entry at the top (its `skills` map lists every skill's version).
3. Run `yarn skills:sync`. It records the new hash under the new version and rewrites `.claude/skills`. It also removes a file there that the source no longer has (`.agents/skills` is a link to the same folder). It refuses a changed text whose version was not bumped (`--amend` replaces the hash of a version not yet released; never use it for a version that was already deployed).

`yarn vitest run tests/unit/systemSkills.test.ts` fails when a text changed without a version bump or a changelog entry.

## How it is built

- SvelteKit 3 with Svelte 5 runes and Tailwind 4, on `adapter-node`.
- PostgreSQL through Drizzle. Every tenant table has forced row level security, and the app connects as a role that does not own the tables. Live updates use `LISTEN` and `NOTIFY`, background jobs use pg-boss on the same database, and files live on disk or in any S3 compatible store.
- One operations layer (`src/lib/server/ops/`). The pages, the REST API, the MCP server and the commands all call it, and each verb reads the caller's live role.
- Better Auth for sign in, with the OAuth 2.1 and device flows for tools written beside it.
- `packages/runner` (the browser check runner), `packages/bridge` (the MCP stdio bridge and the tool hooks), `DESIGN.md` (the brand and the size scale).

The plan, the decisions and the loophole register this was built from live in the HAPR Board item FLOW-20261014-1047. Current work is planned in the project AFB on the live board.

## Security in one paragraph

Tenants are separated twice: every query filters by organisation and project, and PostgreSQL enforces it again with row level security set inside each transaction. A token's permissions are an upper limit, and the person's current role is read on every call. Secrets (test account passwords, tokens, keys) are never returned by any call and never written to a log; test account passwords are sealed with a per-organisation key wrapped by `AFB_MASTER_KEY`. Anything a guest writes reaches an agent marked as untrusted. Report a problem privately to the maintainers rather than in a public issue.
