@echo off
chcp 65001 >nul
REM ============================================================
REM 演示模式：不需要真服务器，用 2 个 mock bot 跑通整条链路
REM 用于验证控制台 UI / 语言指挥 / 场景 / 租约
REM ============================================================
cd /d "%~dp0..\src\console"
echo 启动 2 个 mock bot (8801 / 8802) + 控制台 (8900) ...
start "mock-A" /min cmd /c "cd /d %~dp0..\src\console && python mock_bot.py --port 8801 --name Bot-A"
start "mock-B" /min cmd /c "cd /d %~dp0..\src\console && python mock_bot.py --port 8802 --name Bot-B"
timeout /t 2 >nul
start "" "http://127.0.0.1:8900/"
python console.py --port 8900
pause
