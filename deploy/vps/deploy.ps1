# DEPLOY THE WORKING TREE TO THE VPS: yarn deploy:vps
# Builds on this PC and sends only the built app and the deploy files, because a build on the server (3.7 GB of memory) ran it out of memory.
# The deploy is a ROLLOUT: the new app container starts beside the old one, and Caddy is switched to it only once it is healthy. The old
# one then drains (open requests finish, live-update streams reconnect, running jobs finish) and is removed, so a running agent sees no gap.
# The server takes a database dump and tags the running image first, builds only the small runtime image (Dockerfile.prebuilt), migrates
# and waits for the new container to be healthy. The deploy says Live only when the server finished and the board answers /healthz.
# Keeps the server's .env. Backups are off while BACKUP_KEY is empty in it.
#
#   yarn deploy:vps                  rolling deploy
#   yarn deploy:vps -StopStart       the old way: stop the app, start the new one (a short outage). Needed when a migration is flagged as breaking
#   yarn deploy:vps -Rollback        a rolling rollback to the image tagged agent-flow-board:previous (the schema is NOT rolled back)
param(
	[string]$Server = 'ubuntu@15.235.241.169',
	[string]$Url = 'https://afb.arbenger.com',
	[switch]$StopStart,
	[switch]$Rollback
)
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
$tmp = Join-Path $env:TEMP 'afb-deploy'
New-Item -ItemType Directory -Force $tmp | Out-Null
$sshOptions = @('-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15')

# A native command that fails does not stop a PowerShell script by itself, so every one is checked
function Test-Exit([string]$what) {
	if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE). Nothing was changed on the server." }
}

if ($Rollback -and $StopStart) { throw 'Use -Rollback or -StopStart, not both.' }

# -- WHAT CHANGED SINCE THE LAST DEPLOY THAT AN OLD APP CANNOT SURVIVE -- #
# The old app runs for up to 40 seconds on the new database. A changed row level security policy (src/lib/server/db/security.ts) or a
# new pg-boss version is as breaking as a dropped column, and neither is a SQL file, so they are read from git against the commit the
# last deploy recorded on the server. A false alarm only stops the deploy and asks for -StopStart.
$changeFlags = @()
if (-not $Rollback) {
	$last = (ssh @sshOptions $Server 'cat ~/afb-last-deploy.txt 2>/dev/null') -join ''
	$last = $last.Trim()
	if ($last -match '^[0-9a-f]{40}$') {
		git cat-file -e "$last^{commit}" 2>$null
		if ($LASTEXITCODE -eq 0) {
			git diff --quiet $last -- src/lib/server/db/security.ts
			if ($LASTEXITCODE -ne 0) { $changeFlags += 'row level security policies (security.ts) changed' }
			$pkg = git diff $last -- package.json | Select-String -Pattern '^[+-].*pg-boss'
			if ($pkg) { $changeFlags += 'pg-boss version changed' }
		}
	}
	$LASTEXITCODE = 0
}
$flagText = (($changeFlags -join '; ') -replace "[^A-Za-z0-9 ._()/;-]", '')

# -- BUILD ON THIS PC -- #
if (-not $Rollback) {
	# The build checks the environment variables, so it gets the same placeholders as Dockerfile. They never leave this process
	$env:AFB_BASE_URL = 'https://build.invalid'
	$env:BETTER_AUTH_SECRET = 'build-time-placeholder-0123456789abcdef'
	try {
		yarn run build
		Test-Exit 'yarn run build'
		yarn run build:cli
		Test-Exit 'yarn run build:cli'
	} finally {
		Remove-Item Env:AFB_BASE_URL, Env:BETTER_AUTH_SECRET -ErrorAction SilentlyContinue
	}

	# -- PACK -- #
	# build/ and cli/ are git ignored, so they are named here. Nothing else of the source is needed on the server.
	# deploy/vps/live/ is not sent: the server writes it for every rollout
	$paths = @(
		'build', 'cli', 'package.json', 'yarn.lock', '.yarnrc.yml', '.yarn/releases',
		'packages/bridge/package.json', 'packages/cli/package.json', 'packages/runner/package.json',
		'src/lib/server/db/migrations', 'Dockerfile.prebuilt', 'Dockerfile.prebuilt.dockerignore',
		'deploy/vps/compose.yaml', 'deploy/vps/compose.prebuilt.yaml', 'deploy/vps/Caddyfile',
		'deploy/vps/postgres-init.sh', 'deploy/vps/.env.example'
	)
	foreach ($p in $paths) {
		if (-not (Test-Path -LiteralPath $p)) { throw "Missing $p, so nothing was sent." }
	}
	tar -czf "$tmp\afb.tgz" @paths
	Test-Exit 'tar'
	Write-Host ("Packed {0:N1} MB" -f ((Get-Item "$tmp\afb.tgz").Length / 1MB))
}

# -- REMOTE SCRIPT (no BOM, LF only) -- #
$header = "STOP_START=$([int]$StopStart.IsPresent)`nROLLBACK=$([int]$Rollback.IsPresent)`nCHANGE_FLAGS='$flagText'`n"
$remote = @'
set -e
start=$(date +%s)
cd ~/agent-flow-board/deploy/vps
export COMPOSE_FILE=compose.yaml:compose.prebuilt.yaml

# ONE DEPLOY AT A TIME
exec 9>~/afb-deploy.lock
flock -n 9 || { echo 'Another deploy is running on the server.'; exit 1; }

# -- HELPERS -- #
app_ids() { docker ps -aq --filter label=com.docker.compose.project=agent-flow-board --filter label=com.docker.compose.service=app | sort; }
running_ids() { docker ps -q --filter label=com.docker.compose.project=agent-flow-board --filter label=com.docker.compose.service=app | sort; }
cname() { docker inspect -f '{{.Name}}' "$1" | sed 's#^/##'; }
health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo none; }
sql() { docker compose exec -T postgres psql -U postgres -d afb -Atc "$1"; }
drain_and_remove() { echo "Draining $(cname "$1")"; docker stop -t 50 "$1" >/dev/null; docker rm "$1" >/dev/null; }
wait_healthy() {
  local id=$1 state=none
  for i in $(seq 1 40); do
    state=$(health "$id"); [ "$state" = healthy ] && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" = true ] || return 1
    sleep 3
  done
  return 1
}
# CADDY SENDS TO THE CONTAINER NAMED IN live/app-upstream.caddy. VALIDATE THE WHOLE CONFIG, RELOAD, THEN READ THE RUNNING CONFIG BACK
point_caddy() {
  local name=$1
  mkdir -p live
  printf '%s\n' "reverse_proxy $name:3000 {" "	import afb_proxy" "}" > live/app-upstream.caddy.new
  mv -f live/app-upstream.caddy.new live/app-upstream.caddy
  docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { echo 'Caddy refused the new configuration.'; return 1; }
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { echo 'Caddy could not reload.'; return 1; }
  for i in 1 2 3 4 5; do
    docker compose exec -T caddy wget -qO- http://localhost:2019/config/ 2>/dev/null | grep -q "$name:3000" && return 0
    sleep 1
  done
  echo "Caddy is not sending to $name."; return 1
}
# THE CADDYFILE IS A SINGLE FILE MOUNT: IF THE CONTAINER STILL SEES AN OLDER FILE, RECREATE IT (A FEW SECONDS ON 443)
ensure_caddy_current() {
  docker compose up -d --no-deps caddy >/dev/null
  if ! docker compose exec -T caddy cat /etc/caddy/Caddyfile | cmp -s - Caddyfile; then
    echo 'Caddy sees an older Caddyfile, so it is recreated once.'
    docker compose up -d --no-deps --force-recreate caddy >/dev/null
    sleep 3
  fi
}
# THE OLD WAY: STOP, START (A SHORT OUTAGE)
stop_start() {
  echo "$1"
  docker compose up -d
  ids=($(app_ids))
  [ "${#ids[@]}" = 1 ] || { echo "Expected one app container, found ${#ids[@]}."; exit 1; }
  wait_healthy "${ids[0]}" || { echo "The app container is $(health "${ids[0]}"), not healthy."; docker compose logs app --tail 30; exit 1; }
  point_caddy "$(cname "${ids[0]}")"
}

# WHY A MIGRATION FILE WOULD BREAK THE OLD APP RUNNING ON THE NEW SCHEMA (empty when it would not). A foreign key to a new table, an index or
# a unique index on a table created in the same file, a new column with a default and a data backfill are harmless to the old app
migration_breaks() {
  local f=$1 why="" t line tbl con backfill=0
  grep -Eiq '^[[:space:]]*UPDATE[[:space:]]' "$f" && backfill=1
  grep -Eiq 'DROP[[:space:]]+(COLUMN|TABLE|TYPE)|RENAME' "$f" && why="drops or renames something"
  if [ -z "$why" ]; then grep -Eiq 'SET[[:space:]]+NOT[[:space:]]+NULL|ALTER[[:space:]]+COLUMN[^;]*TYPE' "$f" && why="tightens or changes a column"; fi
  # A check dropped and added back under the same name is widened or rewritten, which the old app survives, unless the same file
  # also rewrites rows (a narrowed list). A constraint on a table created in the same file is harmless. Anything else counts
  while IFS= read -r line; do
    [ -n "$why" ] && break
    con=$(printf '%s' "$line" | sed -E 's/^[^"]*"[^"]+"[^"]*"([^"]+)".*/\1/')
    grep -Eiq "ADD[[:space:]]+CONSTRAINT[[:space:]]+\"$con\"" "$f" && [ "$backfill" = 0 ] || why="drops a constraint"
  done < <(grep -Ei 'DROP[[:space:]]+CONSTRAINT' "$f")
  while IFS= read -r line; do
    [ -n "$why" ] && break
    tbl=$(printf '%s' "$line" | sed -E 's/^[^"]*"([^"]+)".*/\1/')
    con=$(printf '%s' "$line" | sed -E 's/^[^"]*"[^"]+"[^"]*"([^"]+)".*/\1/')
    if grep -Eiq "CREATE[[:space:]]+TABLE[[:space:]]+\"$tbl\"" "$f"; then continue; fi
    if grep -Eiq "DROP[[:space:]]+CONSTRAINT[[:space:]]+\"$con\"" "$f" && [ "$backfill" = 0 ]; then continue; fi
    why="adds a check or unique constraint"
  done < <(grep -Ei 'ADD[[:space:]]+CONSTRAINT.*(CHECK|UNIQUE)' "$f")
  if [ -z "$why" ] && grep -Ei 'ADD[[:space:]]+COLUMN' "$f" | grep -Ei 'NOT[[:space:]]+NULL' | grep -Eiqv 'DEFAULT|GENERATED'; then why="adds a NOT NULL column with no default"; fi
  if [ -z "$why" ]; then
    for t in $(grep -Eio 'CREATE[[:space:]]+UNIQUE[[:space:]]+INDEX[[:space:]]+"[^"]+"[[:space:]]+ON[[:space:]]+"[^"]+"' "$f" | sed -E 's/.*ON[[:space:]]+"([^"]+)"/\1/'); do
      grep -Eiq "CREATE[[:space:]]+TABLE[[:space:]]+\"$t\"" "$f" || why="adds a unique index to an existing table"
    done
  fi
  printf '%s' "$why"
}

# -- INCOMING FILES AND THE MIGRATION GUARD -- #
if [ "$ROLLBACK" != 1 ]; then
  rm -rf ~/afb-incoming && mkdir ~/afb-incoming && tar -xzf /tmp/afb.tgz -C ~/afb-incoming && rm /tmp/afb.tgz

  # A MIGRATION THAT WOULD BREAK THE OLD APP RUNNING BESIDE THE NEW ONE STOPS THE DEPLOY. ONLY MIGRATIONS NOT YET APPLIED ARE READ.
  # This is a guard, not a proof: a developer still judges every migration as additive or breaking (docs/self-hosting.md)
  flagged="$CHANGE_FLAGS"
  # A fresh database has no migrations table yet, so nothing is applied and the guard has nothing to protect
  has_table=$(sql "SELECT to_regclass('public.__afb_migrations') IS NOT NULL") || { echo 'Cannot read the database. Is it running?'; exit 1; }
  applied=""
  [ "$has_table" = t ] && applied=$(sql 'SELECT tag FROM "__afb_migrations"')
  for f in ~/afb-incoming/src/lib/server/db/migrations/*.sql; do
    tag=$(basename "$f" .sql)
    if [ "$has_table" = t ] && printf '%s\n' "$applied" | grep -qx "$tag"; then continue; fi
    [ "$has_table" = t ] || continue
    why=$(migration_breaks "$f")
    [ -z "$why" ] || flagged="${flagged:+$flagged; }migration $tag ($why) can break the old app"
  done
  if [ -n "$flagged" ] && [ "$STOP_START" != 1 ]; then
    echo "The deploy stopped before changing anything: $flagged."
    echo 'The old app would run on the new schema while it drains. Run: yarn deploy:vps -StopStart (a short outage), after you have looked at it.'
    rm -rf ~/afb-incoming
    exit 1
  fi
fi

# -- PREFLIGHT: EXACTLY ONE RUNNING APP CONTAINER -- #
for id in $(app_ids); do
  [ "$(docker inspect -f '{{.State.Running}}' "$id")" = true ] || docker rm -f "$id" >/dev/null
done
ids=($(running_ids))
if [ "${#ids[@]}" -gt 1 ]; then
  # A deploy that died halfway left two. Keep the one Caddy sends to, drain the rest
  current=$(sed -n 's/^reverse_proxy \([^:]*\):3000.*/\1/p' live/app-upstream.caddy 2>/dev/null | head -1)
  keep=""
  for id in "${ids[@]}"; do [ "$(cname "$id")" = "$current" ] && keep=$id; done
  [ -n "$keep" ] || { echo "There are ${#ids[@]} app containers and none is the one Caddy sends to ($current). Fix this by hand first."; exit 1; }
  for id in "${ids[@]}"; do [ "$id" = "$keep" ] || drain_and_remove "$id"; done
  ids=("$keep")
fi
old=${ids[0]:-}

if [ "$ROLLBACK" != 1 ]; then
  # A DATABASE DUMP FIRST, so a bad migration has something to go back to (the newest 3 are kept)
  mkdir -p ~/afb-predeploy
  dump=~/afb-predeploy/afb-$(date -u +%Y%m%d-%H%M%S).dump
  COMPOSE_FILE=compose.yaml docker compose exec -T postgres pg_dump -U postgres -d afb -Fc > "$dump" || { rm -f "$dump"; echo 'The database dump failed.'; exit 1; }
  test -s "$dump" || { rm -f "$dump"; echo 'The database dump is empty.'; exit 1; }
  ls -1t ~/afb-predeploy/afb-*.dump | tail -n +4 | xargs -r rm -f
  echo "Database dump: $dump ($(du -h "$dump" | cut -f1))"

  # THE RUNNING IMAGE KEEPS A SECOND NAME, so it can be started again (the prune below only removes untagged images).
  # Only a healthy one: after a bad deploy, the next deploy must not turn the bad image into the rollback
  if [ -n "$old" ] && [ "$(health "$old")" = healthy ]; then
    docker tag "$(docker inspect -f '{{.Image}}' "$old")" agent-flow-board:previous
  fi

  # THE NEW FILES. Nothing outside these folders is deleted, and the server's .env stays. The Caddyfile is written in place so the
  # container's single file mount keeps seeing it; live/ is written by this script
  rsync -a --exclude 'deploy/vps/.env' --exclude 'deploy/vps/Caddyfile' --exclude 'deploy/vps/live' ~/afb-incoming/ ~/agent-flow-board/
  rsync -a --inplace ~/afb-incoming/deploy/vps/Caddyfile ~/agent-flow-board/deploy/vps/Caddyfile
  for d in build cli src/lib/server/db/migrations; do rsync -a --delete ~/afb-incoming/$d/ ~/agent-flow-board/$d/; done
  rm -rf ~/afb-incoming

  # ONLY THE RUNTIME IMAGE IS BUILT HERE (from the shipped build, never from source on this server). The running container is not touched
  docker compose build app

  # A BACKUP HOLDS A LONG TRANSACTION, AND A TABLE LOCK WOULD QUEUE EVERY QUERY BEHIND IT, SO WAIT FOR IT (10 minutes at most)
  for i in $(seq 1 60); do
    busy=$(sql "SELECT count(*) FROM pg_stat_activity WHERE usename = 'afb_backup' AND xact_start IS NOT NULL" 2>/dev/null || echo 0)
    [ "$busy" = 0 ] && break
    [ "$i" = 1 ] && echo 'A backup is running. Waiting for it to finish before the migration.'
    [ "$i" = 60 ] && { echo 'The backup is still running after 10 minutes. Nothing was migrated; the old app keeps serving. Try again later.'; exit 1; }
    sleep 10
  done

  # THE MIGRATION RUNS ALONE. If it fails the old app keeps serving and no new container exists
  docker compose run --rm -T migrate
else
  docker image inspect agent-flow-board:previous >/dev/null 2>&1 || { echo 'There is no agent-flow-board:previous image to go back to.'; exit 1; }
  docker tag agent-flow-board:previous agent-flow-board:local
  echo 'Rolling back to the previous image. The database schema is not rolled back.'
fi

# CADDY MUST ALREADY BE ON THE CURRENT CONFIGURATION AND POINT AT THE RUNNING CONTAINER BEFORE THE ROLLOUT
mkdir -p live
if [ -n "$old" ]; then name=$(cname "$old"); else name=app; fi
printf '%s\n' "reverse_proxy $name:3000 {" "	import afb_proxy" "}" > live/app-upstream.caddy.new
mv -f live/app-upstream.caddy.new live/app-upstream.caddy
ensure_caddy_current

# -- ROLLOUT -- #
avail=$(free -m | awk '/^Mem:/ {print $7}')
if [ -z "$old" ]; then
  stop_start 'No app container is running, so this is a plain start.'
elif [ "$STOP_START" = 1 ]; then
  stop_start 'Stop and start, as asked (a short outage).'
elif [ "${avail:-0}" -lt 700 ]; then
  stop_start "Only ${avail:-0} MB of memory is free, too little for two app containers, so this is a stop and start (a short outage)."
else
  before=$(app_ids)
  docker compose up -d --no-deps --no-recreate --scale app=2 app
  after=$(app_ids)
  new=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))
  [ "$(printf '%s\n' "$new" | grep -c .)" = 1 ] || { echo "Expected one new app container, found: $new"; exit 1; }
  # The new container must be made by this deploy, from the image tagged local, and healthy. On failure only the new one goes
  created=$(date -d "$(docker inspect -f '{{.Created}}' "$new")" +%s)
  if [ "$created" -lt "$start" ] || [ "$(docker inspect -f '{{.Config.Image}}' "$new")" != agent-flow-board:local ]; then
    echo 'The new container was not made by this deploy.'; docker rm -f "$new" >/dev/null; exit 1
  fi
  if ! wait_healthy "$new"; then
    echo "The new app container is $(health "$new"), not healthy. The old one keeps serving."
    docker compose logs app --tail 30; docker rm -f "$new" >/dev/null; exit 1
  fi
  if ! point_caddy "$(cname "$new")"; then
    point_caddy "$(cname "$old")" || true
    docker rm -f "$new" >/dev/null; exit 1
  fi
  # No new request reaches the old container now. Give Caddy a moment, then let it drain
  sleep 3
  drain_and_remove "$old"
fi
docker image prune -f >/dev/null
docker ps --filter label=com.docker.compose.project=agent-flow-board --format '{{.Names}} {{.Status}}'

# MEMORY AFTER THE DEPLOY. An unreadable kernel log says unknown, never a false 0
free -h | sed -n 2p
if out=$(sudo -n journalctl -k --since "@$start" --no-pager 2>/dev/null); then
  echo "OOM kills since the deploy started: $(printf '%s\n' "$out" | grep -ciE 'out of memory|oom-kill' || true)"
else
  echo 'OOM kills since the deploy started: unknown (no passwordless sudo for journalctl)'
fi
echo "AFB_DEPLOY_OK $(cname "$(running_ids | head -1)")"
'@
[IO.File]::WriteAllText("$tmp\remote.sh", (($header + $remote) -replace "`r", ''), (New-Object Text.UTF8Encoding $false))

# -- SEND AND RUN -- #
if (-not $Rollback) {
	scp @sshOptions "$tmp\afb.tgz" "${Server}:/tmp/afb.tgz"
	Test-Exit 'Sending the build'
}
scp @sshOptions "$tmp\remote.sh" "${Server}:/tmp/remote.sh"
Test-Exit 'Sending the script'
$out = ssh @sshOptions $Server 'bash /tmp/remote.sh; code=$?; rm -f /tmp/remote.sh; exit $code'
$code = $LASTEXITCODE
$out | ForEach-Object { Write-Host $_ }
Remove-Item $tmp -Recurse -Force
if ($code -ne 0 -or -not ($out -match 'AFB_DEPLOY_OK')) {
	throw "The server did not finish the deploy (exit code $code). The old app container keeps serving unless the output above says otherwise. The database dump is in ~/afb-predeploy on the server, and the previous image is tagged agent-flow-board:previous (see Rollback in VPS.md). On the server: docker compose logs app"
}

# -- WAIT FOR HEALTH FROM OUTSIDE -- #
$live = $false
for ($i = 0; $i -lt 30; $i++) {
	$r = curl.exe -s -m 5 "$Url/healthz"
	if ($r -match '"ok":true') { $live = $true; break }
	Start-Sleep 3
}
if (-not $live) { throw "The server says the deploy finished, but the board did not answer $Url/healthz in time. On the server: docker compose logs app" }

# -- RECORD WHAT IS LIVE -- #
# The commit the next deploy compares security.ts and package.json against
if (-not $Rollback) {
	$head = (git rev-parse HEAD).Trim()
	ssh @sshOptions $Server "echo $head > ~/afb-last-deploy.txt"
}
Write-Host "Live: $Url"
exit 0
