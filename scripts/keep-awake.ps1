# Keep this Windows PC from sleeping while a long job runs.
# Display may sleep; the system must not. Ctrl+C restores normal behaviour.
$ErrorActionPreference = "Stop"

$helper = @'
using System;
using System.Runtime.InteropServices;
public static class Cloud9KeepAwake {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
  public const uint ES_CONTINUOUS = 0x80000000;
  public const uint ES_SYSTEM_REQUIRED = 0x00000001;
}
'@

try {
  Add-Type -TypeDefinition $helper -ErrorAction Stop | Out-Null
} catch {
  Write-Host "Cloud9 could not ask Windows to stay awake on this machine - Add-Type failed."
  exit 1
}

$engaged = $false
try {
  $flags = [uint32]([Cloud9KeepAwake]::ES_CONTINUOUS -bor [Cloud9KeepAwake]::ES_SYSTEM_REQUIRED)
  $prev = [Cloud9KeepAwake]::SetThreadExecutionState($flags)
  if ($prev -eq [uint32]0) {
    Write-Host "Cloud9 could not ask Windows to stay awake on this machine - the request was refused."
    exit 1
  }
  $engaged = $true
  Write-Host "Cloud9 is keeping this computer awake (screen may still sleep). Press Ctrl+C when finished."

  while ($true) {
    Start-Sleep -Seconds 30
    [void][Cloud9KeepAwake]::SetThreadExecutionState($flags)
  }
} finally {
  if ($engaged) {
    [void][Cloud9KeepAwake]::SetThreadExecutionState([uint32][Cloud9KeepAwake]::ES_CONTINUOUS)
    Write-Host "Cloud9 released the stay-awake request - normal sleep is back."
  }
}
