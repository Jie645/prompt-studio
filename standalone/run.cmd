@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ not found. Opening the standalone HTML instead.
  start "" "%~dp0index.html"
  exit /b 0
)
node server.mjs
if errorlevel 1 pause
