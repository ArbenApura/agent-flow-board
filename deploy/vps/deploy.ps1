# DEPLOY THE WORKING TREE TO THE VPS: yarn deploy:vps
# Builds on this PC and sends only the built app and the deploy files, because a build on the server (3.7 GB of memory) ran it out of memory.
# The server takes a database dump and tags the running image first, builds only the small runtime image (Dockerfile.prebuilt), migrates
# and waits for the new container to be healthy. The deploy says Live only when the server finished and the board answers /healthz.
# Keeps the server's .env. Backups are off while BACKUP_KEY is empty in it.
param(
	[string]$Server = 'ubuntu@15.235.241.169',
	[string]$Url = 'https://afb.arbenger.com'
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

# -- BUILD ON THIS PC -- #
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
# build/ and cli/ are git ignored, so they are named here. Nothing else of the source is needed on the server
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

# -- REMOTE SCRIPT (no BOM, LF only) -- #
$remote = @'
set -e
start=$(date +%s)
rm -rf ~/afb-incoming && mkdir ~/afb-incoming && tar -xzf /tmp/afb.tgz -C ~/afb-incoming && rm /tmp/afb.tgz
cd ~/agent-flow-board/deploy/vps

# A DATABASE DUMP FIRST, so a bad migration has something to go back to (the newest 3 are kept)
mkdir -p ~/afb-predeploy
dump=~/afb-predeploy/afb-$(date -u +%Y%m%d-%H%M%S).dump
COMPOSE_FILE=compose.yaml docker compose exec -T postgres pg_dump -U postgres -d afb -Fc > "$dump" || { rm -f "$dump"; echo 'The database dump failed.'; exit 1; }
test -s "$dump" || { rm -f "$dump"; echo 'The database dump is empty.'; exit 1; }
ls -1t ~/afb-predeploy/afb-*.dump | tail -n +4 | xargs -r rm -f
echo "Database dump: $dump ($(du -h "$dump" | cut -f1))"

# THE RUNNING IMAGE KEEPS A SECOND NAME, so it can be started again (the prune below only removes untagged images).
# Only a healthy one: after a bad deploy, the next deploy must not turn the bad image into the rollback
running=$(COMPOSE_FILE=compose.yaml docker compose ps -q app 2>/dev/null || true)
if [ -n "$running" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$running" 2>/dev/null)" = healthy ]; then
  docker tag agent-flow-board:local agent-flow-board:previous
fi

# THE NEW FILES. Nothing outside these folders is deleted, and the server's .env stays
rsync -a --exclude 'deploy/vps/.env' ~/afb-incoming/ ~/agent-flow-board/
for d in build cli src/lib/server/db/migrations; do rsync -a --delete ~/afb-incoming/$d/ ~/agent-flow-board/$d/; done
rm -rf ~/afb-incoming

# ONLY THE RUNTIME IMAGE IS BUILT HERE, THEN EVERYTHING STARTS (the one shot migration runs before the app). The image is made
# from the shipped build (compose.prebuilt.yaml, which has just arrived), never from source on this server
cd ~/agent-flow-board/deploy/vps
export COMPOSE_FILE=compose.yaml:compose.prebuilt.yaml
docker compose build app
docker compose up -d
docker image prune -f >/dev/null
docker compose ps --format '{{.Service}} {{.Status}}'

# THE NEW CONTAINER MUST BE THE NEW IMAGE, AND HEALTHY
cid=$(docker compose ps -q app)
new=$(docker image inspect agent-flow-board:local --format '{{.Id}}')
state=none
for i in $(seq 1 40); do
  state=$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo none)
  [ "$state" = healthy ] && break
  sleep 3
done
if [ "$state" != healthy ]; then echo "The app container is $state, not healthy."; docker compose logs app --tail 30; exit 1; fi
# Made after this deploy started, so it is the new one (an image id is not compared: it differs between Docker image stores)
created=$(date -d "$(docker inspect -f '{{.Created}}' "$cid")" +%s)
if [ "$created" -lt "$start" ]; then echo 'The app container was not recreated by this deploy.'; exit 1; fi

# MEMORY AFTER THE DEPLOY. An unreadable kernel log says unknown, never a false 0
free -h | sed -n 2p
if out=$(sudo -n journalctl -k --since "@$start" --no-pager 2>/dev/null); then
  echo "OOM kills since the deploy started: $(printf '%s\n' "$out" | grep -ciE 'out of memory|oom-kill' || true)"
else
  echo 'OOM kills since the deploy started: unknown (no passwordless sudo for journalctl)'
fi
echo "AFB_DEPLOY_OK $new"
'@
[IO.File]::WriteAllText("$tmp\remote.sh", ($remote -replace "`r", ''), (New-Object Text.UTF8Encoding $false))

# -- SEND AND RUN -- #
scp @sshOptions "$tmp\afb.tgz" "${Server}:/tmp/afb.tgz"
Test-Exit 'Sending the build'
scp @sshOptions "$tmp\remote.sh" "${Server}:/tmp/remote.sh"
Test-Exit 'Sending the script'
$out = ssh @sshOptions $Server 'bash /tmp/remote.sh; code=$?; rm -f /tmp/remote.sh; exit $code'
$code = $LASTEXITCODE
$out | ForEach-Object { Write-Host $_ }
Remove-Item $tmp -Recurse -Force
if ($code -ne 0 -or -not ($out -match 'AFB_DEPLOY_OK')) {
	throw "The server did not finish the deploy (exit code $code). The database dump is in ~/afb-predeploy on the server, and the running image is kept as agent-flow-board:previous (see Rollback in docs/self-hosting.md). On the server: docker compose logs app"
}

# -- WAIT FOR HEALTH FROM OUTSIDE -- #
for ($i = 0; $i -lt 30; $i++) {
	$r = curl.exe -s -m 5 "$Url/healthz"
	if ($r -match '"ok":true') { Write-Host "Live: $Url"; exit 0 }
	Start-Sleep 3
}
throw "The server says the deploy finished, but the board did not answer $Url/healthz in time. On the server: docker compose logs app"
