@echo off
rem ============================================================
rem  Build the real Cloud9 app - double-click this file.
rem
rem  This turns the code in this folder into a proper Windows
rem  program with its own Cloud9 icon. When it finishes you get an
rem  installer; run it once and Cloud9 appears in your Start menu
rem  and on your desktop like any other app.
rem
rem  The installed app needs nothing else running - no black
rem  windows, no "Start Cloud9". Just click Cloud9 and it opens.
rem
rem  It takes a few minutes the first time. Leave this window open.
rem ============================================================
title Building Cloud9
cd /d "%~dp0"

echo.
echo   Building the real Cloud9 app. This takes a few minutes.
echo.

call npm run dist
if errorlevel 1 (
  echo.
  echo   The build did not finish. The lines above say why.
  echo   If this is the first time, try:  npm install
  echo.
  pause
  exit /b 1
)

echo.
echo   Done. Your installer is in the "release" folder:
echo       Cloud9-Setup-0.1.0.exe
echo.
echo   Double-click it to install Cloud9. It installs just for you,
echo   so Windows will not ask for an administrator password.
echo.
start "" "%~dp0release"
pause
