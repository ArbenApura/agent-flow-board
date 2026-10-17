# Starts the afb Cloudflare Tunnel if it is not already running. Arben's own Cloudflare account, zone arbenger.com.
# It only reaches http://127.0.0.1:5190, the build preview (see start.ps1). Called at logon by "AFB Tunnel.cmd".
$exe = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$config = 'C:\Users\Admin\.cloudflared\afb.yml'
$log = Join-Path $PSScriptRoot 'tunnel.log'
$running = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -like '*afb.yml*' }
if ($running) { exit 0 }
Start-Process -WindowStyle Hidden -FilePath $exe -ArgumentList @('tunnel', '--config', $config, '--logfile', $log, 'run', 'afb')
