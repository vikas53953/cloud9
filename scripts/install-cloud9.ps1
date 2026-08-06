# ============================================================
#  Install Cloud9 - the one supported way to install it.
#
#  PLAIN WORDS: this runs the Cloud9 installer for you and then
#  CHECKS that it actually worked. If anything goes wrong it tells
#  you in plain English. It will never leave you staring at a
#  window that looks frozen with no idea what is happening.
#
#  Run it by double-clicking "Install Cloud9.cmd" in the main
#  Cloud9 folder, or from a terminal:
#      powershell -ExecutionPolicy Bypass -File scripts\install-cloud9.ps1
#
#  Why it exists: on 2026-08-06 the plain installer was seen to sit
#  there for twelve minutes with no window and no message. The cause
#  was virus scanning making every small step take 10-22 seconds.
#  A silent freeze is the worst possible failure, so this script
#  puts a clock on it and speaks up.
# ============================================================

[CmdletBinding()]
param(
  # How long to wait before declaring the installer stuck, in minutes.
  [int] $TimeoutMinutes = 10,
  # Path to a specific installer; by default the newest one in release\.
  [string] $Installer
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Say  ($m) { Write-Host "  $m" }
function Head ($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }
function Bad  ($m) { Write-Host ""; Write-Host "  $m" -ForegroundColor Red }
function Good ($m) { Write-Host ""; Write-Host "  $m" -ForegroundColor Green }

# ---------- 1. Find the installer ----------
Head "Finding the installer"
if (-not $Installer) {
  $found = Get-ChildItem (Join-Path $repo 'release') -Filter 'Cloud9-Setup-*.exe' -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $found) {
    Bad "No installer found in the 'release' folder."
    Say "Build one first: double-click 'Build Cloud9 app.cmd', or run  npm run dist"
    exit 1
  }
  $Installer = $found.FullName
}
if (-not (Test-Path $Installer)) { Bad "That installer file does not exist: $Installer"; exit 1 }
$size = [math]::Round((Get-Item $Installer).Length / 1MB)
Say "Using: $Installer  ($size MB)"

# ---------- 2. Warn about the thing that makes this slow ----------
Head "Checking how busy your virus scanner is"
$avNames = @()
try {
  $avNames = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop |
               Select-Object -ExpandProperty displayName)
} catch { }
if ($avNames.Count -gt 0) { Say "Security software registered: $($avNames -join ', ')" }

# Time how long Windows takes to start one tiny program. Normally ~20ms.
$probe = [math]::Round((Measure-Command { 1..5 | ForEach-Object { & cmd /c ver | Out-Null } }).TotalMilliseconds / 5)
Say "Starting a small program takes about $probe ms here (a healthy machine is about 20 ms)."
if ($probe -gt 200) {
  Say ""
  Say "  That is slow. Your security software inspects every program as it starts,"
  Say "  so the installer will take longer than you expect. That is normal here."
  if ($avNames.Count -gt 1) {
    Say "  You have more than one security product active, which doubles that cost."
  }
}

# ---------- 3. Close Cloud9 ----------
Head "Closing Cloud9 if it is open"
$open = @(Get-Process -Name 'Cloud9' -ErrorAction SilentlyContinue)
if ($open.Count -gt 0) {
  Say "Closing $($open.Count) Cloud9 window(s)."
  $open | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
} else { Say "Cloud9 was not open." }

# ---------- 4. Run it, with a clock on it ----------
Head "Installing (this can take a few minutes - you will see a heartbeat below)"
$sw = [Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)

while (-not $proc.HasExited -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 15
  $proc.Refresh()
  if ($proc.HasExited) { break }
  $cpu = 0; try { $cpu = [math]::Round($proc.CPU, 1) } catch { }
  Say ("still working - {0}s elapsed, {1}s of actual work done" -f [math]::Round($sw.Elapsed.TotalSeconds), $cpu)
}

if (-not $proc.HasExited) {
  $sw.Stop()
  try { $proc.Kill() } catch { }
  Bad "STUCK. The installer ran for $TimeoutMinutes minutes without finishing, so I stopped it."
  Say ""
  Say "Nothing was broken - your existing Cloud9 is untouched."
  Say ""
  Say "The usual cause is security software scanning the $size MB installer file."
  Say "Ask an administrator to run these two lines in an Administrator PowerShell,"
  Say "then run this installer again:"
  Say ""
  Say "    Add-MpPreference -ExclusionPath '$(Join-Path $repo 'release')'"
  Say "    Add-MpPreference -ExclusionPath '$env:LOCALAPPDATA\Programs\Cloud9'"
  Say ""
  if ($avNames -match 'McAfee') {
    Say "You also have McAfee. Add the same two folders to its exclusions"
    Say "(McAfee -> Settings -> Real-Time Scanning -> Excluded Files)."
    Say ""
  }
  Say "If it still gets stuck, tell Vikas and paste this whole window."
  exit 2
}

$sw.Stop()
$code = $proc.ExitCode
Say ("Installer finished in {0} seconds, result code {1}." -f [math]::Round($sw.Elapsed.TotalSeconds), $code)

if ($code -ne 0) {
  Bad "The installer stopped early (code $code) and Cloud9 was NOT updated."
  if ($code -eq 3) { Say "Reason: Cloud9 was still open and could not be closed. Restart the computer and try again." }
  else             { Say "Tell Vikas and quote result code $code." }
  exit $code
}

# ---------- 5. Prove it actually landed ----------
Head "Checking the installed app really is the new one"
$installed = Join-Path $env:LOCALAPPDATA 'Programs\Cloud9'
$builtAssets     = Join-Path $repo 'apps\desktop\dist-web\assets'
$installedAssets = Join-Path $installed 'resources\app\dist-web\assets'

if (-not (Test-Path $installedAssets)) {
  Bad "Cloud9 was installed but its screen files are missing: $installedAssets"
  Say "That install is not usable. Tell Vikas."
  exit 4
}

$want = @(Get-ChildItem $builtAssets     -File | Select-Object -ExpandProperty Name | Sort-Object)
$got  = @(Get-ChildItem $installedAssets -File | Select-Object -ExpandProperty Name | Sort-Object)
$missing = @(Compare-Object $want $got | Where-Object SideIndicator -eq '<=' | Select-Object -ExpandProperty InputObject)

Say "Freshly built screen files : $($want.Count)"
Say "Files now installed        : $($got.Count)"

if ($missing.Count -gt 0) {
  Bad "The installed Cloud9 is an OLD build - these files did not make it across:"
  $missing | ForEach-Object { Say "    $_" }
  Say "Run 'Build Cloud9 app.cmd' first, then run this again."
  exit 5
}

Good "DONE. Cloud9 is installed and up to date."
Say "Open it from the Start menu or the desktop shortcut."
exit 0
