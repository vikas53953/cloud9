@echo off
rem ============================================================
rem  Start Cloud9 in DEMO MODE - made-up answers, no real AI.
rem
rem  THIS IS NOT THE ONE YOU NORMALLY WANT.
rem
rem  In demo mode your agents do not talk to Claude or Codex at
rem  all. They reply with made-up example text, so you can show
rem  the app to someone with no internet and no sign-in. Every
rem  reply is stamped "[demo - not a real answer]" and the app
rem  screen shows a demo banner the whole time, so nothing here
rem  can ever be mistaken for a real answer.
rem
rem  For real answers from your own Claude and Codex:
rem  double-click "Start Cloud9.cmd" instead.
rem ============================================================
title Cloud9 (demo mode)
cd /d "%~dp0"

echo.
echo   ############################################################
echo   #                                                          #
echo   #   DEMO MODE - the answers below are MADE UP.             #
echo   #   Nothing here comes from Claude or Codex.               #
echo   #                                                          #
echo   ############################################################
echo.
echo   Press Ctrl+C now if you wanted real answers.
echo   Starting in 5 seconds...
timeout /t 5 >nul

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

echo   [2/3] starting your agents IN DEMO MODE...
start "Cloud9 agents" /min cmd /c "set CLOUD9_DEMO=1&& node scripts\engine-host.mjs"

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
echo   Opening Cloud9 in demo mode...
cd apps\desktop
set CLOUD9_DEV_URL=http://127.0.0.1:5173
set CLOUD9_DEMO=1
npx electron .

echo.
echo   Cloud9 closed. Shutting down the background parts...
taskkill /FI "WINDOWTITLE eq Cloud9 hub*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Cloud9 agents*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Cloud9 screen*" /T /F >nul 2>&1
echo   Done.
