@echo off
REM Windows backup launcher. Keep this file ASCII-only (see start.bat for why).
REM Real logic lives in scripts/backup.mjs.

setlocal
cd /d "%~dp0.."
chcp 65001 >nul 2>nul
node --disable-warning=ExperimentalWarning "scripts\backup.mjs" %*
endlocal
