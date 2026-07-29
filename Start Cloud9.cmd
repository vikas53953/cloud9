@echo off
rem ============================================================
rem  Start Cloud9 (WORKBENCH MODE) - double-click this file.
rem  Starts the three parts in order, then opens the app window.
rem  Close this window to shut everything down.
rem
rem  This is the mode for changing Cloud9: the app screen reloads
rem  as soon as a file is edited. It needs this window left open.
rem
rem  For the REAL app - the one with a proper Cloud9 icon that
rem  lives in your Start menu and needs none of this - double-click
rem  "Build Cloud9 app.cmd" instead, once. See the README.
rem ============================================================
title Cloud9
cd /d "%~dp0"

rem  Real answers, always. Demo mode invents answers that LOOK real, so it must
rem  only ever happen because a person asked for it - and this launcher is not
rem  a person asking. Cleared once, here, so nothing started below can inherit
rem  it from whatever window this was opened from: the hub, the agents, the app
rem  screen and the Cloud9 window all get a session with demo mode switched off.
rem  If you DO want made-up answers (a demo with no internet, say), run
rem  "Start Cloud9 (demo).cmd" - it says so on screen the whole time.
set "CLOUD9_DEMO="

echo.
echo   Cloud9 is starting in workbench mode.
echo   Leave this window open while you use the app.
echo.

echo   [1/3] starting the hub...
start "Cloud9 hub" /min cmd /c "set CLOUD9_DEV=1&& node apps\relay\dist\server.js"
node scripts\wait-for-port.mjs 8787 40
if errorlevel 1 (
  echo.
  echo   The hub did not start.
  echo   Open a terminal here and run:  npm install  then  npm run build
  echo.
  pause
  exit /b 1
)
echo         hub ready

rem  Your agents run on YOUR Claude and Codex, signed in on this computer.
rem  Demo mode was cleared for this whole session at the top of this file.
echo   [2/3] starting your agents...
start "Cloud9 agents" /min cmd /c "node scripts\engine-host.mjs"

echo   [3/3] starting the app screen...
start "Cloud9 screen" /min cmd /c "cd apps\desktop&& npx vite dev --host 127.0.0.1 --port 5173"
node scripts\wait-for-port.mjs 5173 90
if errorlevel 1 (
  echo.
  echo   The app screen did not start.
  echo   Open a terminal here and run:  npm install
  echo.
  pause
  exit /b 1
)
echo         screen ready

echo.
echo   Opening Cloud9...
cd apps\desktop
set CLOUD9_DEV_URL=http://127.0.0.1:5173
npx electron .

echo.
echo   Cloud9 closed. Shutting down the background parts...
taskkill /FI "WINDOWTITLE eq Cloud9 hub*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Cloud9 agents*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Cloud9 screen*" /T /F >nul 2>&1
echo   Done.
