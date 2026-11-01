@echo off
title MC Bot - LAN world
setlocal enabledelayedexpansion

REM ============================================================
REM Connect the bot to a LAN-opened world (single-player "Open to LAN").
REM The console (8900) needs no change: it talks to the bot bridge on 8801.
REM Keep this file ASCII-only and CRLF: cmd.exe parses .bat by codepage,
REM UTF-8 Chinese text and LF-only line endings both break the parser.
REM ============================================================

cd /d "%~dp0..\src\bot"
if errorlevel 1 goto :nodir

echo.
echo === Connect to LAN world ===
echo   In game: Esc -^> Open to LAN, the chat shows a port, e.g. 54815.
echo   Host: 127.0.0.1 (same PC) or 192.168.x.x (LAN world on another PC).
echo.

set "IP=127.0.0.1"
set /p "IP=Host [127.0.0.1]: "
if not defined IP set "IP=127.0.0.1"

set "PORT="
set /p "PORT=Port (required, e.g. 54815): "
if not defined PORT goto :noport

set "NAME=bot_local"
set /p "NAME=Bot name [bot_local]: "
if not defined NAME set "NAME=bot_local"

echo.
echo [i] target %IP%:%PORT%  name %NAME%  bridge 8801
echo [i] LAN worlds have no AuthMe; BOT_PW stays empty ("BOT_PW is empty" is harmless).
echo [i] If the log says the channel table is a sample, capture a real one first:
echo     docs\01-部署流程\05-获取整合包与抓包.md
echo.

set "BOT_PW="
set "BOT_REG=0"
set "COMBAT_OFF=1"
set "XP_LOW_LEVEL=0"
set "BRIDGE_PORT=8801"

node forge-live.mjs "%IP%" "%PORT%" "%NAME%"

echo.
echo [i] bot exited. Console: http://127.0.0.1:8900
pause
exit /b 0

:noport
echo [x] port is required.
pause
exit /b 1

:nodir
echo [x] cannot find src\bot (run this file from the repo scripts\ folder).
pause
exit /b 1
