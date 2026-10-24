@echo off
chcp 65001 >nul
REM 只启动大脑（8902）
cd /d "%~dp0..\src\console"
python brain.py --port 8902 %*
pause
