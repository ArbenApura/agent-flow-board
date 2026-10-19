# DEPLOY THE WORKING TREE TO THE VPS: yarn deploy:vps
# Sends tracked and untracked (not ignored) files, keeps the server's .env, backs up first, rebuilds, migrates and waits for /healthz.
param(
	[string]$Server = 'ubuntu@15.235.241.169',
	[string]$Url = 'https://afb.arbenger.com'
)
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
$tmp = Join-Path $env:TEMP 'afb-deploy'
New-Item -ItemType Directory -Force $tmp | Out-Null

# -- PACK -- #
git ls-files -co --exclude-standard | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Set-Content "$tmp\files.txt" -Encoding ascii
tar -czf "$tmp\afb.tgz" -T "$tmp\files.txt"
Write-Host ("Packed {0:N1} MB" -f ((Get-Item "$tmp\afb.tgz").Length / 1MB))

# -- REMOTE SCRIPT (no BOM, LF only) -- #
$remote = @'
set -e
rm -rf ~/afb-incoming && mkdir ~/afb-incoming && tar -xzf /tmp/afb.tgz -C ~/afb-incoming && rm /tmp/afb.tgz
cd ~/agent-flow-board/deploy/vps
echo "Backing up before the update"
docker compose exec -T app node cli/server.mjs backup run </dev/null || echo "backup skipped"
rsync -a --delete --exclude 'deploy/vps/.env' ~/afb-incoming/ ~/agent-flow-board/
rm -rf ~/afb-incoming
docker compose up -d --build
docker image prune -f >/dev/null
docker compose ps --format '{{.Service}} {{.Status}}'
'@
[IO.File]::WriteAllText("$tmp\remote.sh", ($remote -replace "`r", ''), (New-Object Text.UTF8Encoding $false))

# -- SEND AND RUN -- #
scp "$tmp\afb.tgz" "${Server}:/tmp/afb.tgz"
scp "$tmp\remote.sh" "${Server}:/tmp/remote.sh"
ssh $Server 'bash /tmp/remote.sh; rm -f /tmp/remote.sh'
Remove-Item $tmp -Recurse -Force

# -- WAIT FOR HEALTH -- #
for ($i = 0; $i -lt 30; $i++) {
	$r = curl.exe -s -m 5 "$Url/healthz"
	if ($r -match '"ok":true') { Write-Host "Live: $Url"; exit 0 }
	Start-Sleep 3
}
Write-Error "The board did not answer $Url/healthz in time. On the server: docker compose logs app"
