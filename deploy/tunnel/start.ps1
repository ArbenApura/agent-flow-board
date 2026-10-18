# Starts the public preview of agent-flow-board at logon: Docker PostgreSQL, a build, then the build preview on 127.0.0.1:5190.
# The Cloudflare tunnel (tunnel.ps1) serves that port as https://agent-flow-board.arbenger.com. Dev stays on 5180.
# Called by "AFB Preview.cmd" in the Startup folder. Run it by hand to restart: powershell -File deploy\tunnel\start.ps1
$ErrorActionPreference = 'Continue'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repo
$log = Join-Path $repo '.afb\preview.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null

# A preview that already answers on 5190 is left alone
if (Get-NetTCPConnection -LocalPort 5190 -State Listen -ErrorAction SilentlyContinue) { exit 0 }

# Docker Desktop may not be up yet at logon, so wait for it
$docker = "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
docker info *> $null
if ($LASTEXITCODE -ne 0) {
	Start-Process $docker -WindowStyle Hidden
	for ($i = 0; $i -lt 60; $i++) { Start-Sleep 5; docker info *> $null; if ($LASTEXITCODE -eq 0) { break } }
}
docker compose -f deploy/local/compose.yaml up -d --wait
if ($LASTEXITCODE -ne 0) { throw "Docker PostgreSQL did not start" }

# The two secrets live outside the repo. Nothing here is printed or logged
$secrets = @{}
Get-Content 'C:\Users\Admin\Desktop\agent-flow-board-secrets.txt' | ForEach-Object {
	if ($_ -match '^([A-Z_]+)=(.+)$') { $secrets[$Matches[1]] = $Matches[2] }
}
foreach ($k in 'BETTER_AUTH_SECRET', 'AFB_MASTER_KEY') { if (-not $secrets[$k]) { throw "$k is missing from the secrets file" } }
$env:BETTER_AUTH_SECRET = $secrets['BETTER_AUTH_SECRET']
$env:AFB_MASTER_KEY = $secrets['AFB_MASTER_KEY']

# The same local database as dev. These values beat any DATABASE_URL in .env. Never seed the demo here
$env:DATABASE_URL = 'postgres://app_runtime:localruntimepassword@127.0.0.1:5433/afb'
$env:DATABASE_OWNER_URL = 'postgres://postgres:localpostgrespassword@127.0.0.1:5433/afb'
$env:AFB_BASE_URL = 'https://agent-flow-board.arbenger.com'
$env:AFB_AUTO_MIGRATE = '1'
$env:AFB_SEED_DEMO = '0'
$env:AFB_ENABLE_GALLERY = '0'

yarn build *> $log
if ($LASTEXITCODE -ne 0) { throw "The build failed. See $log" }
Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList @('node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5190') -RedirectStandardOutput (Join-Path $repo '.afb\preview.out.log') -RedirectStandardError (Join-Path $repo '.afb\preview.err.log')
