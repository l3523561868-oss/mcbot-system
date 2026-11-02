@echo off
chcp 65001 >nul
REM live smoke test: handshake / registry / online / addons
REM usage: smoke.bat host:port [name]
cd /d "%~dp0.."
if "%~1"=="" (echo usage: smoke.bat host:port [name] & pause & exit /b 1)
node src\tools\smoke-live.mjs %*
pause
