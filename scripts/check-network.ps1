#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only Tailscale status check for this Windows machine.

.DESCRIPTION
  Reports whether Tailscale is installed, whether this machine appears signed in /
  connected, and this machine's 100.x Tailscale address when available.
  Makes no system changes: no install, no login, no restart, no config writes.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

function Write-Plain([string]$Message) {
  Write-Output $Message
}

function Find-TailscaleExe {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe'),
    (Join-Path $env:LOCALAPPDATA 'Tailscale\tailscale.exe')
  )

  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      return $path
    }
  }

  $cmd = Get-Command 'tailscale.exe' -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    return $cmd.Source
  }

  return $null
}

function Get-TailscaleIp100 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Exe
  )

  try {
    $ipLines = & $Exe ip -4 2>$null
    if ($LASTEXITCODE -ne 0) {
      return $null
    }
    foreach ($line in @($ipLines)) {
      $text = ([string]$line).Trim()
      if ($text -match '^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
        return $text
      }
    }
  } catch {
    return $null
  }

  return $null
}

function Get-SignedInHint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Exe
  )

  # Prefer structured status when available; fall back to plain "status" text.
  try {
    $jsonText = & $Exe status --json 2>$null
    if ($LASTEXITCODE -eq 0 -and $jsonText) {
      $status = $jsonText | ConvertFrom-Json
      $backend = [string]$status.BackendState
      $selfHost = $null
      if ($status.Self -and $status.Self.HostName) {
        $selfHost = [string]$status.Self.HostName
      }

      if ($backend -eq 'Running') {
        if ($selfHost) {
          return "You appear signed in and connected as '$selfHost'."
        }
        return 'You appear signed in and connected.'
      }
      if ($backend -eq 'NeedsLogin' -or $backend -eq 'NoState') {
        return 'Tailscale is installed, but this machine is not signed in yet.'
      }
      if ($backend -eq 'Stopped') {
        return 'Tailscale is installed, but it is not running right now.'
      }
      if ($backend) {
        return "Tailscale reported state: $backend."
      }
    }
  } catch {
    # Fall through to text status.
  }

  try {
    $text = & $Exe status 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      $joined = ($text | Out-String).Trim()
      if ($joined -match '(?i)logged out|needs login|not logged in') {
        return 'Tailscale is installed, but this machine is not signed in yet.'
      }
      if ($joined -match '(?i)stopped|not running') {
        return 'Tailscale is installed, but it is not running right now.'
      }
      return 'Tailscale is installed, but sign-in status could not be confirmed.'
    }

    if ($text -match '(?i)logged out') {
      return 'Tailscale is installed, but this machine is not signed in yet.'
    }
    return 'Tailscale is installed and appears signed in.'
  } catch {
    return 'Tailscale is installed, but sign-in status could not be confirmed.'
  }
}

Write-Plain 'Cloud9 network check (read-only).'
Write-Plain 'This script only reports Tailscale status. It does not change your system.'
Write-Plain ''

$exe = Find-TailscaleExe
if (-not $exe) {
  Write-Plain 'Tailscale is not installed on this computer (or the Tailscale command was not found).'
  Write-Plain 'Install steps: see docs/plans/tailscale-steps.md'
  Write-Plain 'Nothing was changed.'
  exit 0
}

Write-Plain "Tailscale is installed. Command found at: $exe"

$signedIn = Get-SignedInHint -Exe $exe
Write-Plain $signedIn

$addr = Get-TailscaleIp100 -Exe $exe
if ($addr) {
  Write-Plain "This machine's Tailscale address is $addr."
} else {
  Write-Plain "This machine's Tailscale 100.x address was not available."
  Write-Plain 'If you just installed Tailscale, sign in from the tray icon, then run this check again.'
}

Write-Plain ''
Write-Plain 'Check finished. Nothing was changed.'
exit 0
