@echo off
chcp 65001 >nul
REM ============================================================
REM 手机 / 局域网访问模式：控制台绑到 0.0.0.0
REM 默认只绑 127.0.0.1，手机连不上是设计如此。
REM ============================================================
cd /d "%~dp0..\src\console"
set CONSOLE_HOST=0.0.0.0

REM 公网/隧道暴露时必须开 token（去掉下一行注释并改成强口令）：
REM set CONSOLE_TOKEN=换成你自己的长随机串

echo [手机模式] 控制台监听 0.0.0.0:8900
echo   本机： http://127.0.0.1:8900
echo   手机： http://^<本机局域网/Tailscale IP^>:8900
python console.py --port 8900 --host 0.0.0.0 %*
pause
