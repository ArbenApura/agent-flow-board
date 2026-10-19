# SYNC THE LOCAL POSTGRESQL (5433) TO THE VPS: yarn sync:vps
# One way, local to VPS. Backs up the real local orgs (not the demo seeds), takes a VPS backup, then restores them over the VPS copies.
# Anything that exists only on the VPS is replaced, but the VPS backup taken first keeps it. Never writes to the local database.
param(
	[string]$Server = 'ubuntu@15.235.241.169',
	[string]$Url = 'https://afb.arbenger.com',
	[string[]]$Skip = @('acme', 'lumora')
)
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
$tmp = Join-Path $env:TEMP 'afb-sync'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force "$tmp\backups" | Out-Null

# -- ORGS TO SYNC -- #
$rows = docker exec afb-local-postgres-1 psql -U postgres -d afb -Atc "select id from org where slug <> all(string_to_array('$($Skip -join ',')', ','))"
$orgs = @($rows | Where-Object { $_ })
Write-Host "Syncing $($orgs.Count) organisations"

# -- LOCAL BACKUP, ENCRYPTED WITH THE VPS KEY -- #
$key = (ssh $Server "grep '^BACKUP_KEY=' ~/agent-flow-board/deploy/vps/.env | cut -d= -f2").Trim()
$env:BACKUP_KEY = $key
$env:BACKUP_DIR = $tmp
$env:AFB_STORAGE_DIR = "$PWD\.afb\files"
$env:DATABASE_URL = 'postgres://app_runtime:localruntimepassword@127.0.0.1:5433/afb'
$env:DATABASE_OWNER_URL = 'postgres://postgres:localpostgrespassword@127.0.0.1:5433/afb'
$env:DATABASE_BACKUP_URL = 'postgres://postgres:localpostgrespassword@127.0.0.1:5433/afb'
$env:AFB_BASE_URL = 'http://localhost:5180'
$env:BETTER_AUTH_SECRET = 'x' * 40
yarn tsx scripts/server.ts backup run 2>&1 | Select-Object -Last 6
foreach ($o in $orgs) { if (-not (Get-ChildItem "$tmp\backups\$o\*.afbbak" -ErrorAction SilentlyContinue)) { throw "No backup was made for org $o" } }

# -- SEND -- #
ssh $Server 'rm -rf /tmp/imp; mkdir -p /tmp/imp'
foreach ($o in $orgs) { scp (Get-ChildItem "$tmp\backups\$o\*.afbbak" | Sort-Object Name | Select-Object -Last 1).FullName "${Server}:/tmp/imp/$o.afbbak" }
$list = $orgs -join ' '
$remote = @"
cd ~/agent-flow-board/deploy/vps
echo "== VPS backup before overwrite"
docker compose exec -T app node cli/server.mjs backup run </dev/null 2>&1 | tail -4
docker compose cp /tmp/imp app:/data/imp
docker compose exec -T -u root app chown -R node:node /data/imp </dev/null
for o in $list; do
  docker compose exec -T app node cli/server.mjs restore org /data/imp/`$o.afbbak --replace --confirm afb --yes </dev/null 2>&1 | grep -E "Restored|rror" | cut -c1-250
done
docker compose exec -T -u root app rm -rf /data/imp </dev/null
rm -rf /tmp/imp /tmp/sync.sh
"@
[IO.File]::WriteAllText("$tmp\sync.sh", ($remote -replace "`r", ''), (New-Object Text.UTF8Encoding $false))
scp "$tmp\sync.sh" "${Server}:/tmp/sync.sh"
ssh $Server 'bash /tmp/sync.sh'

# -- KEEP A COPY AND CHECK -- #
$keep = "C:\Users\Admin\Desktop\afb-backups\$(Get-Date -Format 'yyyy-MM-dd-HHmm')-local-synced-to-vps"
New-Item -ItemType Directory -Force $keep | Out-Null
Copy-Item "$tmp\backups" $keep -Recurse
Remove-Item $tmp -Recurse -Force
Write-Host (curl.exe -sS -m 20 "$Url/healthz")
