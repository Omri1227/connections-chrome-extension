# Registers (or replaces) the per-user scheduled task that runs run-collector.ps1 at logon, hidden, without a time
# limit, restarting on failure. No administrator rights and no system-wide policy change: the task runs as the current
# user with limited rights, and -ExecutionPolicy Bypass applies to its own PowerShell process only.
#   powershell -ExecutionPolicy Bypass -File flightdata\deploy\windows\install-task.ps1          check, install + start
#   powershell -ExecutionPolicy Bypass -File flightdata\deploy\windows\install-task.ps1 -Remove  stop + remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'CDG Navigator flight data'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path

function Stop-Collector {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($t) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }
  # Stopping the task ends the launcher, not necessarily its node child: end the process holding the database lock.
  $lock = Join-Path $env:LOCALAPPDATA 'cdg-navigator\flightdata\pg.lock'
  if (Test-Path $lock) {
    try { $holder = (Get-Content -Raw $lock | ConvertFrom-Json).pid; $p = Get-Process -Id $holder -ErrorAction Stop; if ($p.ProcessName -eq 'node') { Stop-Process -Id $holder -Force; Write-Output "Stopped the running flight-data server (pid $holder)." } } catch {}
  }
}

if ($Remove) {
  Stop-Collector
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
  Write-Output "Removed task '$name'. The database and backups in %LOCALAPPDATA%\cdg-navigator\flightdata are kept."
  return
}

# ---- Pre-flight checks (nothing is changed if one fails) ----
$problems = @()
if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) { $problems += 'npx.cmd not found on PATH (install Node.js)' }
if (-not (Test-Path (Join-Path $repo 'node_modules\.bin\tsx.cmd'))) { $problems += "dependencies missing: run 'npm install' in $repo" }
$envFile = Join-Path $repo '.env'
if (-not (Test-Path $envFile)) { $problems += ".env not found in $repo" } else {
  $vars = @{}; Get-Content $envFile | ForEach-Object { if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $vars[$Matches[1]] = $Matches[2].Trim() } }
  foreach ($k in 'FD_AERODATABOX_KEY', 'FD_AERODATABOX_BASE', 'FD_ASSIGNMENTS') { if (-not $vars[$k]) { $problems += ".env: $k is empty" } }
  if ($vars['FD_SCHEDULER'] -ne 'on') { $problems += '.env: FD_SCHEDULER must be on' }
  if (-not ($vars['FD_ADMIN_TOKEN'] -or $vars['ADMIN_TOKEN'])) { $problems += '.env: ADMIN_TOKEN (dashboard token) is empty' }
  if ($vars['FD_PGLITE_DIR'] -and $vars['FD_PGLITE_DIR'] -match 'OneDrive') { $problems += '.env: FD_PGLITE_DIR points into OneDrive (keep the database in %LOCALAPPDATA%)' }
}
if ($problems.Count) { Write-Output 'Not installed:'; $problems | ForEach-Object { Write-Output "  - $_" }; exit 1 }

Stop-Collector
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
$script = Join-Path $PSScriptRoot 'run-collector.ps1'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
# conhost --headless gives the launcher a console without any window. Plain "powershell -WindowStyle Hidden" is handed
# to Windows Terminal on Windows 11, which shows it as a normal window; closing that window sent Ctrl+C and stopped
# the collector on 2026-10-31 (log ends in "^C", task result 0xC000013A).
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
  -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $repo
# At logon, plus a watchdog every 15 minutes: if the launcher is still running the extra start is ignored
# (MultipleInstances IgnoreNew); if it has died for any reason it is started again within 15 minutes.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 15)
$trigger = @((New-ScheduledTaskTrigger -AtLogOn -User $user), $watchdog)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'CDG Navigator: flight-data collection (AeroDataBox, 8 airports) and research dashboard on http://127.0.0.1:8790' | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "Installed and started task '$name' for $user (runs at every logon; watchdog restart within 15 min)."
