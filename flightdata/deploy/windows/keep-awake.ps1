# Keeps this PC awake for -Minutes so the flight-data collector can finish a collection slot. Started by the wake task
# (install-wake.ps1), which wakes the PC shortly after each slot. Holds a Windows power request ("execution required" +
# "system required"), the same mechanism media players use; the display may still turn off. Ends by itself.
param([int]$Minutes = 60)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace CdgNav -Name Power -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct REASON_CONTEXT { public uint Version; public uint Flags; [MarshalAs(UnmanagedType.LPWStr)] public string SimpleReasonString; }
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr PowerCreateRequest(ref REASON_CONTEXT context);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool PowerSetRequest(IntPtr h, int type);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool PowerClearRequest(IntPtr h, int type);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
'@
$ctx = New-Object CdgNav.Power+REASON_CONTEXT
$ctx.Version = 0; $ctx.Flags = 1   # POWER_REQUEST_CONTEXT_SIMPLE_STRING
$ctx.SimpleReasonString = 'CDG Navigator: flight-data collection slot'
$h = [CdgNav.Power]::PowerCreateRequest([ref]$ctx)
$SYSTEM_REQUIRED = 1; $EXECUTION_REQUIRED = 3
try {
  [void][CdgNav.Power]::PowerSetRequest($h, $SYSTEM_REQUIRED)
  [void][CdgNav.Power]::PowerSetRequest($h, $EXECUTION_REQUIRED)
  [void][CdgNav.Power]::SetThreadExecutionState([uint32]'0x80000001')   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
  Start-Sleep -Seconds ($Minutes * 60)
} finally {
  [void][CdgNav.Power]::PowerClearRequest($h, $EXECUTION_REQUIRED)
  [void][CdgNav.Power]::PowerClearRequest($h, $SYSTEM_REQUIRED)
  [void][CdgNav.Power]::CloseHandle($h)
  [void][CdgNav.Power]::SetThreadExecutionState([uint32]'0x80000000')
}
