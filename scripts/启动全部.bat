@echo off
chcp 65001 >nul
title MC 多 bot 一键启动
REM ============================================================
REM 依次拉起：bot1(8801) → bot2(8802) → 控制台(8900) → 大脑(8902)
REM 需要先在 config\ 里复制并填好 bots.json / brain.json
REM ============================================================
set ROOT=%~dp0..
set BOT=%ROOT%\src\bot
set CON=%ROOT%\src\console

if not exist "%CON%\bots.json" (
  echo [!] 缺少 %CON%\bots.json
  echo     请先： copy config\bots.example.json src\console\bots.json  然后填账号
  pause & exit /b 1
)

echo [1/4] bot1 (8801) ...
start "mc-bot-8801" /min cmd /c "cd /d %BOT% && set BRIDGE_PORT=8801&& node forge-live.mjs %MC_HOST% %MC_PORT% %BOT1_USER%"

echo     等 12 秒再起 bot2（同 IP 双登录会触发 Connection throttled）...
timeout /t 12 /nobreak >nul

echo [2/4] bot2 (8802) ...
start "mc-bot-8802" /min cmd /c "cd /d %BOT% && set BRIDGE_PORT=8802&& node forge-live.mjs %MC_HOST% %MC_PORT% %BOT2_USER%"

timeout /t 3 /nobreak >nul
echo [3/4] 控制台 (8900) ...
start "mc-console-8900" /min cmd /c "cd /d %CON% && python console.py --port 8900"

echo [4/4] 大脑 (8902) ...
start "mc-brain-8902" /min cmd /c "cd /d %CON% && python brain.py --port 8902"

timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:8900/"

echo.
echo 已拉起 4 个服务。bot 进服约 60~100 秒，期间控制台显示"离线"属正常。
echo 停止：直接关掉这 4 个窗口，或 taskkill /F /IM node.exe
pause
