@echo off
chcp 65001 >nul
REM core selftest: codec / registry / contract / addons / guard
cd /d "%~dp0.."
node src\tools\selftest.mjs %*
pause
