@echo off
REM Windows launcher. Keep this file ASCII-only!
REM cmd.exe reads .bat using the OEM codepage, so UTF-8 Chinese comments
REM get shredded into invalid commands and the script fails to run.
REM All real logic lives in scripts/start.mjs.

setlocal
cd /d "%~dp0.."

REM Switch console to UTF-8 so the Node script's Chinese output is readable.
chcp 65001 >nul 2>nul

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js 22.5 or newer: https://nodejs.org
  exit /b 1
)

node "scripts\start.mjs" %*
endlocal
