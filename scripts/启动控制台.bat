@echo off
chcp 65001 >nul
REM 只启动控制台（8900），并打开浏览器
cd /d "%~dp0..\src\console"
start "" "http://127.0.0.1:8900/"
python console.py --port 8900 %*
pause
