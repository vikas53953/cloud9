@echo off
rem ============================================================
rem  Install Cloud9 - double-click this file.
rem
rem  This runs the Cloud9 installer and then checks that it really
rem  worked. If anything goes wrong it says so in plain English.
rem  It will never sit there frozen without telling you why.
rem
rem  It installs just for you, so Windows will not ask for an
rem  administrator password. It can take a few minutes.
rem ============================================================
title Installing Cloud9
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-cloud9.ps1"

echo.
pause
