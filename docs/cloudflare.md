# Running on Cloudflare

This puts the board on Cloudflare Workers. It is the second way to host it; the first is a server you run yourself (see self-hosting.md). Both run the same code and the same database rules.

## What you need

- A Cloudflare account on a plan that includes Workers, Queues and Durable Objects.
- A PostgreSQL database that Cloudflare can reach. The Worker connects to it through **Hyperdrive**.
- A domain for the board, with its DNS in Cloudflare.

The board does not run its database on Cloudflare. Use any hosted PostgreSQL (version 16 or later) or your own server.

## 1. Prepare the database

Run these once from your own machine. `DATABASE_URL` is the address of the **owner** account (not the one the Worker will use), and `AFB_RUNTIME_PASSWORD` is the password you choose for the `app_runtime` role (16 or more letters, digits and `_ . ~ -`).

```
yarn install
DATABASE_URL=postgres://afb_owner:...@host/afb AFB_RUNTIME_PASSWORD=... yarn db migrate
```

The migration step applies every migration and gives the `app_runtime` role its login. Then make a Hyperdrive configuration that logs in as `app_runtime`:

```
npx wrangler hyperdrive create afb --connection-string="postgres://app_runtime:...@host:5432/afb"
```

**On Supabase.** Use the session pooler string (port 5432, user `postgres.<project ref>`) as `DATABASE_URL` for the migration, and `app_runtime.<project ref>` for Hyperdrive. Supabase gives its public API roles (`anon`, `authenticated`, `service_role`) full access to every new table, and some of the board's tables (users, sessions, accounts) have no row level security. After `yarn db migrate`, run `deploy/supabase/lock-public-api.sql` as the `postgres` role, and run it again after any later migration that adds tables.

Turn Hyperdrive's query cache off (`npx wrangler hyperdrive update <id> --caching-disabled=true`): this app reads rows that change all the time and are private to one organisation, and a cached answer has no place there. Also set `placement.region` in `wrangler.jsonc` to the cloud region of the database (for example `aws:ap-northeast-1`). A page makes many queries one after another, so a Worker far from the database is slow on every one of them.

The Worker must connect as `app_runtime` and never as the owner. That role is bound by row level security, so one organisation can never read another's rows, even if a query is wrong.

## 2. Fill in `wrangler.jsonc`

Replace every value in angle brackets: the Hyperdrive id, `AFB_BASE_URL`, and `EMAIL_FROM`. Create the other things it names:

```
npx wrangler r2 bucket create afb-files
npx wrangler queues create afb-jobs
```

Then set the secrets. Each is one command, and Wrangler asks for the value.

```
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put AFB_MASTER_KEY
npx wrangler secret put RESEND_API_KEY
```

Add `GOOGLE_CLIENT_SECRET` only if you use Google sign in. For publishing to GitHub set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` together (the id and the slug are not secret, so they can go in the `vars` of `wrangler.jsonc`). `BETTER_AUTH_SECRET` and `AFB_MASTER_KEY` are at least 32 characters each. `BETTER_AUTH_SECRET` also signs the messages the queue passes back to the app, so keep it private.

## 3. Deploy

```
yarn build:cloudflare
npx wrangler deploy
```

Point your domain at the Worker in the Cloudflare dashboard (Workers, Settings, Domains and Routes). Then open the address, sign up, and create your organisation.

## How the parts fit

| Part           | What it does                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Hyperdrive     | Pools the connections to PostgreSQL. Each request makes its own single connection through it.                           |
| R2             | Holds attachments in a private bucket. Files are served by the app through short links that expire.                     |
| Queues         | Carry the background jobs (checking whether a change needs publishing). The Worker is both the sender and the receiver. |
| Durable Object | One for each project. It sends live updates to open pages. It holds ids only, never content.                            |

A queue message is handed back to the app over `/internal/jobs`, signed with a key only the app holds. Nobody else can run a job.

## Differences from a server

- **Live updates** come through the Durable Object. The database cannot announce changes through Hyperdrive, so the Worker tells the project's object after the request that made the change has finished.
- **No nightly backup runs on a Worker.** A Worker has no long running process to make one, so nobody is mailed when a backup is late either. Run the backup yourself on a schedule from any machine that reaches the database: set `DATABASE_URL`, `DATABASE_BACKUP_URL` (a role that bypasses row level security), `BACKUP_KEY`, and the settings of the bucket (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; R2 has an S3 address in its dashboard) so the files are read from the bucket the Worker writes to, then run `yarn server backup run`. Set `BACKUP_S3_*` or `BACKUP_DIR` for where the archives go, and keep `AFB_MASTER_KEY` with them. Section 4 of self-hosting.md has the rest.
- **The trash is cleared by use.** Things stay in the trash for 30 days. The first person to open an organisation each day clears out what is older, so no scheduled job is needed.
- **Publishing later** waits in the queue in hops of at most 12 hours (the limit of Cloudflare Queues), so a time up to 30 days ahead works.
- **Browser check runners** work the same: they call the same REST address with their runner token.

## Try it on your machine first

```
# put BETTER_AUTH_SECRET and AFB_MASTER_KEY in a file named .dev.vars (it is never committed)
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://app_runtime:...@localhost:5432/afb \
  npx wrangler dev --var AFB_BASE_URL:http://localhost:8787
```

This runs the real Worker with local copies of the queue, the bucket and the Durable Object, against a PostgreSQL you start yourself.
