# Opens the flight-data dashboard. If the server is not answering, starts the scheduled task first (no token is
# passed anywhere: the dashboard asks for it; it is ADMIN_TOKEN in the local .env).
#   powershell -ExecutionPolicy Bypass -File flightdata\deploy\windows\open-dashboard.ps1
$url = 'http://127.0.0.1:8790'
function Test-Up { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "$url/fd-api/health").StatusCode -eq 200 } catch { $false } }
if (-not (Test-Up)) {
  Write-Output 'Server not running: starting the scheduled task "CDG Navigator flight data"...'
  Start-ScheduledTask -TaskName 'CDG Navigator flight data'
  for ($i = 0; $i -lt 30 -and -not (Test-Up); $i++) { Start-Sleep -Seconds 2 }
  if (-not (Test-Up)) { Write-Output "Still not answering; see the log in $env:LOCALAPPDATA\cdg-navigator\flightdata\logs"; exit 1 }
}
Start-Process $url
