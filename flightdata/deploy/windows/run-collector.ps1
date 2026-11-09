# Keeps the flight-data server running on this Windows machine: research API + dashboard (http://127.0.0.1:8790)
# and, with FD_SCHEDULER=on in .env, the collection tick every 15 minutes. Restarts it 60 s after any exit.
# Started at logon by the scheduled task "CDG Navigator flight data" (install-task.ps1). Logs (one file per day):
#   %LOCALAPPDATA%\cdg-navigator\flightdata\logs\collector-YYYY-MM-DD.log
# Stop: Stop-ScheduledTask -TaskName "CDG Navigator flight data"  (then the node process ends with it).
$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$logDir = Join-Path $env:LOCALAPPDATA 'cdg-navigator\flightdata\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location -LiteralPath $repo
# The task allows one launcher at a time, so a server still holding the database lock was orphaned by an earlier
# launcher (Stop-ScheduledTask ends the launcher, not its node child). Adopt it: wait until it exits, then take over.
# (install-task.ps1 ends it explicitly when the code is reinstalled.) Only this project's server is considered.
$lock = Join-Path $env:LOCALAPPDATA 'cdg-navigator\flightdata\pg.lock'
if (Test-Path $lock) {
  try {
    $holder = (Get-Content -Raw $lock | ConvertFrom-Json).pid
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$holder"
    if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'flightdata[\\/]src[\\/]server\.ts') {
      $log0 = Join-Path $logDir ('collector-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
      # The old server may still hold today's log open, so a failed log write must not skip the wait.
      try { Add-Content -LiteralPath $log0 -Encoding UTF8 -Value ((Get-Date -Format o) + " launcher: server pid $holder is still running; waiting for it to exit") } catch {}
      Wait-Process -Id $holder -ErrorAction SilentlyContinue
    }
  } catch {}
}
while ($true) {
  $log = Join-Path $logDir ('collector-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
  Add-Content -LiteralPath $log -Encoding UTF8 -Value ((Get-Date -Format o) + ' launcher: starting the flight-data server')
  # cmd keeps the log in plain UTF-8 bytes (PowerShell 5.1 redirection would write UTF-16).
  cmd.exe /d /c "npx.cmd tsx flightdata\src\server.ts >> `"$log`" 2>&1"
  Add-Content -LiteralPath $log -Encoding UTF8 -Value ((Get-Date -Format o) + " launcher: server exited (code $LASTEXITCODE); restarting in 60 s")
  Start-Sleep -Seconds 60
}
