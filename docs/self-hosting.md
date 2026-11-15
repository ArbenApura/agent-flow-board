# Self-hosting on a VPS

This puts the board on one small server with Docker: PostgreSQL, a one-shot migration step, the app, and a proxy that gets an HTTPS certificate for you. It needs a machine with 2 GB of memory, Docker with the Compose plugin, a domain name that points at the machine, and ports 80 and 443 open.

## 1. Get the files

```
git clone <your copy of this repository> agent-flow-board
cd agent-flow-board/deploy/vps
cp .env.example .env
```

Open `.env` and fill in every line that has no value. Make each secret with

```
openssl rand -base64 48 | tr -d '/+=' | cut -c1-40
```

| Setting                                                             | What it is                                                                                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AFB_BASE_URL`, `AFB_DOMAIN`                                        | The address people use, for example `https://board.example.com` and `board.example.com`.                                                                                               |
| `POSTGRES_PASSWORD`, `AFB_OWNER_PASSWORD`, `AFB_BACKUP_DB_PASSWORD` | Letters and digits only. They are written into SQL the first time the database starts.                                                                                                 |
| `AFB_RUNTIME_PASSWORD`                                              | 16 or more of letters, digits and `_ . ~ -`. The migration step gives the `app_runtime` role this password, and the app connects as that role.                                         |
| `BETTER_AUTH_SECRET`                                                | At least 32 characters. Signs sessions. Changing it signs everyone out.                                                                                                                |
| `BACKUP_KEY`                                                        | At least 32 characters. Encrypts every backup. **If you lose it, the backups cannot be read.** Keep a copy somewhere else.                                                             |
| `AFB_MASTER_KEY`                                                    | At least 32 characters. Wraps the keys that seal test account passwords.                                                                                                               |
| `EMAIL_PROVIDER` and its key                                        | `resend`, `postmark` or `smtp`. With `log`, mail is only kept in memory (and in the file named by `AFB_OUTBOX_FILE`, when set), so nobody receives a verification or invitation email. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                          | Optional Google sign in.                                                                                                                                                               |
| `MOCKUP_ORIGIN`, `MOCKUP_DOMAIN`                                    | Optional, recommended. A second hostname that serves mockups (see "Mockup hostname" below). Leave both empty to serve mockups from the board host, for local development only.         |

## 2. Start it

```
docker compose up -d --build
docker compose ps
```

What starts, in order:

1. `postgres` makes the database and two roles. `afb_owner` owns the database and is not a superuser, so row level security binds it too. `afb_backup` reads and restores every organisation and bypasses row level security, so only backups use it.
2. `migrate` applies the migrations as `afb_owner`, then gives `app_runtime` its login. It runs once and stops.
3. `app` starts as `app_runtime`, the role that owns nothing. Every tenant table has forced row level security, so a query without a tenant sees nothing.
4. `caddy` serves the app on your domain with a Let's Encrypt certificate and keeps live updates from being buffered.

Open `https://<your domain>`, sign up, and create your organisation. The first person to create an organisation owns it. Check `https://<your domain>/healthz` answers `{"ok":true}`.

## 3. Email

Without a working email provider nobody can verify an address or accept an invitation. Set `EMAIL_PROVIDER` and its key, then `docker compose up -d`. In the organisation settings, Email, send a test email to yourself. If the board has no mail yet, an Owner who is locked out can be given a new password from the server:

```
docker compose exec app node cli/server.mjs owner reset-password \
  --org <slug> --email <owner address> --confirm afb --yes
```

The command prints the new password once, ends that Owner's sessions and clears their lockout. It refuses anyone who is not an Owner of that organisation.

## 4. Backups

The app backs up every organisation each night (the hour is `AFB_BACKUP_HOUR`, UTC, 2 by default) into the `appdata` volume under `/data/backups`, as encrypted archives with the database rows and the files. It keeps 14 daily, 8 weekly and 12 monthly archives. Organisation settings shows when a backup is late or has failed, and an Owner gets an email. **Keep a copy of `AFB_MASTER_KEY` with the backups.** The archives hold the sealed test account passwords, and they cannot be opened without it.

**Copy the archives off the machine.** A backup on the same disk is not a backup. For example, from your own computer:

```
rsync -av user@server:/var/lib/docker/volumes/agent-flow-board_appdata/_data/backups/ ./backups/
```

Commands for the operator (run them in the app container):

```
docker compose exec app node cli/server.mjs backup run
docker compose exec app node cli/server.mjs backup list
docker compose exec app node cli/server.mjs backup verify /data/backups/backups/<org id>/<file>
```

A restore shows its plan and does nothing until you repeat it with the database name and `--yes`:

```
# One organisation, replacing what is there
docker compose exec app node cli/server.mjs restore org <file> --replace --confirm afb --yes
# Everything, into an empty database
docker compose exec app node cli/server.mjs restore full /data/backups --confirm afb --yes
```

Try a restore on a spare machine now and then. A backup you have never restored is a guess.

A backup and a restore read and write a piece at a time, so their memory use stays small whatever the size of the organisation (one attachment, at most 100 MB, is held at a time). The archive is written under a `.partial` name and renamed when it is complete, so a crash never leaves a half archive that looks like a backup. A restore reads the archive completely once, with nothing written, before it touches the database.

## 5. Updating

```
git pull
docker compose up -d --build
```

The `migrate` step runs first and the app starts only when it succeeded. Migrations only go forward. To go back to an older version, restore a backup taken before the update.

### A small server (4 GB or less)

A build runs the server out of memory. Build somewhere else and let the server only run the image: `deploy/vps/deploy.ps1` builds on a developer's PC (`yarn run build` and `yarn run build:cli`), sends `build/` and `cli/`, and the server builds a small image from them (`Dockerfile.prebuilt`, with `compose.prebuilt.yaml` added on top of `compose.yaml`). Before it changes anything it takes a database dump into `~/afb-predeploy` (the newest 3 are kept) and keeps the running image as `agent-flow-board:previous`. It says Live only when the new container is healthy and the board answers. `compose.yaml` also caps each container's memory (database 1 GB, app 1.5 GB with a 1 GB JavaScript heap, proxy 192 MB) and makes the kernel stop the app before the database if memory ever runs out. On a server of 8 GB or more the caps are plenty of room and nothing here is needed: build from the source as above.

**A deploy that does not cut anyone off.** `deploy.ps1` is a rolling deploy. The new app container starts beside the old one, and Caddy is switched to it only when it is healthy (the container's name is written to `deploy/vps/live/app-upstream.caddy` and Caddy is reloaded, which sends no new request to the old container). The old container then gets up to 40 seconds: open requests finish, running background jobs finish, and every live-update stream is told to refetch and reconnect to the new container. Then it is removed. A request that cannot reach any app container (a crash, a restart) waits up to 15 seconds in Caddy instead of failing. Three things stop it from rolling and fall back to `-StopStart`, the old way (stop, then start, a short outage): less than 700 MB of free memory, no app running, or a flag you pass.

The old container runs for those seconds on the already migrated database, so a migration has to be one the old code survives. **Judge every migration as additive or breaking.** Adding a table, or a column with a default, is additive. These are breaking and are never shipped on a rolling deploy: dropping or renaming a column or table, a new `NOT NULL` column without a default, tightening a column, a new `CHECK` or `UNIQUE` on an existing table, a check whose list is narrowed, a data rewrite the old code cannot read, a changed row level security policy (`security.ts`) and a new `pg-boss` version. The deploy reads the migrations the server has not applied yet and stops, before it changes anything, when it finds one of the first kinds, and when `security.ts` or the `pg-boss` version changed since the last deploy. This is a guard and not a proof: the developer decides. After looking, run `yarn deploy:vps -StopStart`.

The deploy also waits (up to 10 minutes) while a backup is running, because the backup holds a long transaction and a table change would make every query queue behind it. Migrations and the security statements give up after 5 seconds waiting for a table lock and fail loudly, leaving the old app serving.

**Rollback.** If the new version does not work, from the PC: `yarn deploy:vps -Rollback`. It starts the image tagged `agent-flow-board:previous` beside the bad container, switches Caddy and removes the bad container, the same way. Never run a bare `docker compose up -d` during or just after a rollout: it scales the app back to one and can remove the container Caddy is using.

A migration that already ran stays. After an additive deploy that is fine: the previous code runs on it. After a breaking one, the previous code may not, and the schema has to go back too: restore the newest dump from `~/afb-predeploy` into an empty database with `pg_restore` (writes since the dump are lost, so decide that with the owner first).

If a deploy dies halfway (a dropped connection) the next deploy finds two app containers, keeps the one Caddy sends to and drains the other before it does anything else.

## 6. Changing a key

- **`AFB_MASTER_KEY`.** Run the rotation with both keys, then set the new key in `.env`:

  ```
  docker compose exec -e AFB_NEW_MASTER_KEY=<the new key> app node cli/server.mjs secrets rotate-master-key --confirm afb --yes
  ```

  It re-wraps each organisation's key without touching the sealed passwords, then you put the new value in `AFB_MASTER_KEY` and restart.

- **`BACKUP_KEY`.** A new key encrypts new archives. Keep the old key as long as you keep old archives.
- **`BETTER_AUTH_SECRET`.** Change it and restart. Everyone signs in again.

## 7. Browser checks

The runner is a separate program (see [runners.md](runners.md)). Hosted runs use a supervisor that starts one throwaway container for each waiting run. Run it on a different machine from the board, on a network that cannot reach your private network.

## Mockup hostname

Mockups are untrusted pages, so they are served from a second hostname that has its own DNS record and certificate. The board's session cookie is host-only, so the browser never sends it to the mockup host, and the app answers only signed mockup files and public mockup links there (everything else is a 404).

1. Add a DNS record for the new name that points to the same server as the board. If the board's record is DNS only (not proxied), keep this one DNS only too, so Caddy gets its own certificate. A proxied name two levels below the zone (`mockups.board.example.com`) is not covered by a free proxy certificate.
2. In `deploy/vps/.env` set `MOCKUP_ORIGIN=https://mockups.board.example.com` and `MOCKUP_DOMAIN=mockups.board.example.com` (the same name, with and without `https://`). The name must differ from `AFB_BASE_URL`'s host, not only by port. A wrong value stops the app at start with a plain message.
3. Run `docker compose up -d --build`. Caddy now answers the new name, and the board's own page for a mockup loads it from there.

Raw mockup file addresses on the board host stop working once this is on; addresses the board gives out come from the mockup host. Caddy's log never writes the `sig` of a signed address, a cookie or an authorization header (see the `log` block of the Caddyfile).

## 8. Behind another proxy

If you already run nginx, Traefik or a cloud load balancer, remove the `caddy` service, publish the app's port 3000 to that proxy only (bind it to `127.0.0.1:3000`, so nobody can reach the app directly and send their own `X-Forwarded-*` headers), keep `AFB_BASE_URL` set to the public address, make the proxy send `X-Forwarded-Proto` and `X-Forwarded-Host` (the app sets `PROTOCOL_HEADER` and `HOST_HEADER` to read them; without them it assumes `https` and every form post is refused as cross-site), and turn off response buffering for the path `/*/stream` (the live updates are one long Server-Sent Events response each). A proxy that buffers it makes pages update only after they are reloaded.

File uploads: a file can be up to 100 MB. The API accepts a request body of up to 101 MB, and the image sets `BODY_SIZE_LIMIT=102M` so the server does not refuse a file earlier (the Node default is 512 KB, which fails an upload with a 413). Allow at least 102 MB in your own proxy too (nginx: `client_max_body_size 102m;`). Caddy has no limit by default.

## What this does not cover

PostgreSQL is a single container with a volume. For high availability use a managed PostgreSQL (set `DATABASE_URL`, `DATABASE_OWNER_URL` and `DATABASE_BACKUP_URL` to it and drop the `postgres` service). The owner, runtime and backup roles are described at the top of `postgres-init.sh`; recreate them on your database.
