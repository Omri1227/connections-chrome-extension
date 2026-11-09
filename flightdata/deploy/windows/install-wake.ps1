# Registers (or replaces) the per-user task "CDG Navigator flight data wake". It WAKES the PC from sleep shortly after
# each collection slot and keeps it awake while the collector catches the slot up (keep-awake.ps1).
# Why: most missed slots (2026-11-02..08) happened while the PC slept.
#
# Slots are 07:00, 15:00 and 23:30 local time at each airport (Europe/Paris-type time for seven hubs, Europe/London for
# LHR). They are converted to this PC's local time for today. Slots within 2 h of each other share one wake, which
# lasts until 60 min after the group's last slot.
#
# Re-run after a time-zone or daylight-saving change in only one of the zones (for example Israel vs EU in spring),
# and after a change of the airport list.
#
# No administrator rights. Wake timers must be allowed in the power plan:
#   Settings > System > Power > "Allow wake timers"
#   powercfg: AC on by default on this PC; on battery they are off by design.
#   powershell -ExecutionPolicy Bypass -File flightdata\deploy\windows\install-wake.ps1           install
#   powershell -ExecutionPolicy Bypass -File flightdata\deploy\windows\install-wake.ps1 -Remove   remove
param([switch]$Remove, [int]$AfterSlotMinutes = 5, [int]$AwakeAfterLastSlotMinutes = 60)
$ErrorActionPreference = 'Stop'
$name = 'CDG Navigator flight data wake'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
if ($Remove) { Write-Output "Removed task '$name'."; return }

$slots = '07:00', '15:00', '23:30'
$zones = 'Central European Standard Time', 'GMT Standard Time'   # CDG FRA FCO AMS MUC MAD ZRH; LHR
$today = (Get-Date).Date
$local = foreach ($z in $zones) {
  $tz = [TimeZoneInfo]::FindSystemTimeZoneById($z)
  foreach ($s in $slots) {
    $t = [datetime]::ParseExact("$($today.ToString('yyyy-MM-dd')) $s", 'yyyy-MM-dd HH:mm', $null)
    [TimeZoneInfo]::ConvertTime($t, $tz, [TimeZoneInfo]::Local).TimeOfDay
  }
}
# minutes after local midnight, sorted, grouped when less than 2 h apart (also across midnight)
$mins = $local | ForEach-Object { [int]$_.TotalMinutes % 1440 } | Sort-Object -Unique
$groups = @(); $cur = @($mins[0])
for ($i = 1; $i -lt $mins.Count; $i++) { if ($mins[$i] - $cur[-1] -lt 120) { $cur += $mins[$i] } else { $groups += , $cur; $cur = @($mins[$i]) } }
$groups += , $cur
if ($groups.Count -gt 1 -and ($groups[0][0] + 1440 - $groups[-1][-1]) -lt 120) { $groups[-1] = $groups[-1] + ($groups[0] | ForEach-Object { $_ + 1440 }); $groups = $groups[1..($groups.Count - 1)] }

$script = Join-Path $PSScriptRoot 'keep-awake.ps1'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$actions = @(); $triggers = @(); $plan = @()
foreach ($g in $groups) {
  $start = $g[0] + $AfterSlotMinutes
  $awake = ($g[-1] - $g[0]) + $AwakeAfterLastSlotMinutes - $AfterSlotMinutes
  $at = $today.AddMinutes($start % 1440)
  $triggers += New-ScheduledTaskTrigger -Daily -At $at
  $plan += '{0:HH:mm} for {1} min' -f $at, $awake
}
# One action per trigger is not possible in one task, so the action reads the awake time from the hour it started.
$table = ($groups | ForEach-Object { '{0}={1}' -f ((($_[0] + $AfterSlotMinutes) % 1440)), (($_[-1] - $_[0]) + $AwakeAfterLastSlotMinutes - $AfterSlotMinutes) }) -join ','
$cmd = "`$m=60; `$now=[int](Get-Date).TimeOfDay.TotalMinutes; foreach(`$p in '$table'.Split(',')){ `$k,`$v=`$p.Split('='); if([math]::Abs(`$now-[int]`$k) -le 30){ `$m=[int]`$v } }; & '$script' -Minutes `$m"
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `"$cmd`""
$settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
  -Description 'CDG Navigator: wakes the PC after each flight-data collection slot and keeps it awake while the collector runs' | Out-Null
Write-Output "Installed '$name' for ${user}: wakes daily at $($plan -join '; ') (local time)."
