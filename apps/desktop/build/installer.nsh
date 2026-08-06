# ============================================================
#  Cloud9 installer - custom "is Cloud9 already open?" check
# ============================================================
#
#  PLAIN WORDS: before the installer copies the new Cloud9 over
#  the old one, it has to make sure Cloud9 isn't currently open.
#
#  WHY THIS FILE EXISTS
#  The stock check that ships with our packaging tool answers that
#  question by starting Windows PowerShell and asking it to list
#  every running program - and it does that up to about ten times.
#  On a machine with real-time virus scanning, starting PowerShell
#  once was measured on 2026-08-06 at 10-22 SECONDS. Ten of those is
#  two to four minutes of the installer sitting there doing nothing,
#  showing no window, no progress and no message. To the person who
#  double-clicked it, the installer simply looks dead.
#
#  This replacement asks Windows directly (the nsProcess plugin,
#  no new programs started at all), so the check costs milliseconds
#  instead of minutes, and it is bounded: if Cloud9 genuinely will
#  not close, the installer SAYS SO and stops with an error code
#  instead of spinning in silence.
#
#  Wired up via "nsis.include" in apps/desktop/package.json.
# ============================================================

!macro customCheckAppRunning
  # $R0 = 0 means "found", anything else means "not running".
  DetailPrint "Checking whether Cloud9 is open..."

  nsProcess::_FindProcess /NOUNLOAD `${APP_EXECUTABLE_FILENAME}`
  Pop $R0
  ${If} $R0 != 0
    # Not running - nothing to do.
    nsProcess::_Unload
    Goto c9_app_not_running
  ${EndIf}

  DetailPrint "Cloud9 is open - asking it to close..."

  # Try up to 5 times: ask nicely first, then force it.
  StrCpy $R1 0

  c9_close_loop:
    IntOp $R1 $R1 + 1

    ${If} $R1 <= 2
      # Polite close first, so unsaved work gets a chance to flush.
      nsProcess::_CloseProcess /NOUNLOAD `${APP_EXECUTABLE_FILENAME}`
      Pop $R2
      Sleep 1500
    ${Else}
      nsProcess::_KillProcess /NOUNLOAD `${APP_EXECUTABLE_FILENAME}`
      Pop $R2
      Sleep 1000
    ${EndIf}

    nsProcess::_FindProcess /NOUNLOAD `${APP_EXECUTABLE_FILENAME}`
    Pop $R0
    ${If} $R0 != 0
      nsProcess::_Unload
      Goto c9_app_not_running
    ${EndIf}

    ${If} $R1 < 5
      DetailPrint "Still waiting for Cloud9 to close..."
      Goto c9_close_loop
    ${EndIf}

  # Bounded failure. NEVER loop forever, and NEVER fail quietly:
  # say what is wrong, and exit with an error code so that any
  # script or person running this can tell it did not work.
  nsProcess::_Unload
  SetErrorLevel 3
  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "Cloud9 is still open and will not close, so it cannot be replaced.$\r$\n$\r$\nClose Cloud9 (or restart your computer) and run this installer again." \
    /SD IDOK
  DetailPrint "ERROR: Cloud9 is still running - install stopped."
  Quit

  c9_app_not_running:
!macroend
