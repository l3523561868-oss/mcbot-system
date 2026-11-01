@echo off
title MC Bot - LAN world
setlocal enabledelayedexpansion

REM ============================================================
REM Connect the bot to a LAN-opened world (single-player "Open to LAN").
REM The console (8900) needs no change: it talks to the bot bridge on 8801.
REM
REM Usage:
REM   connect-lan.bat                  interactive
REM   connect-lan.bat 54815            port only, host = 127.0.0.1
REM   connect-lan.bat 192.168.1.20 54815
REM
REM Keep this file ASCII-only and CRLF: cmd.exe parses .bat by codepage,
REM UTF-8 Chinese text and LF-only line endings both break the parser.
REM ============================================================

cd /d "%~dp0..\src\bot"
if errorlevel 1 goto :nodir

if not "%~1"=="" goto :args

echo.
echo === Connect to LAN world ===
echo   In game: Esc -^> Open to LAN, the chat shows a port, e.g. 54815.
echo   Host = IP address. Port = the number from the chat.
echo.

set "IP=127.0.0.1"
set /p "IP=Host (IP, not port) [127.0.0.1]: "
if not defined IP set "IP=127.0.0.1"

REM Common mistake: typing the port into Host. A pure number is treated as the port.
set "GUESS="
echo %IP%| findstr /r "^[0-9][0-9]*$" >nul && set "GUESS=%IP%"
if defined GUESS (
  set "PORT=%GUESS%"
  set "IP=127.0.0.1"
  echo [i] "%GUESS%" looks like a port -^> host reset to 127.0.0.1, port set to %GUESS%
  goto :askname
)

set "PORT="
set /p "PORT=Port (e.g. 54815): "
if not defined PORT goto :noport
goto :askname

:askname
set "NAME=bot_local"
set /p "NAME=Bot name [bot_local]: "
if not defined NAME set "NAME=bot_local"
goto :run

:args
if not "%~2"=="" (
  set "IP=%~1"
  set "PORT=%~2"
) else (
  set "IP=127.0.0.1"
  set "PORT=%~1"
)
set "NAME=bot_local"
if not "%~3"=="" set "NAME=%~3"

:run
echo.
echo [i] target %IP%:%PORT%  name %NAME%  bridge 8801
echo [i] LAN worlds have no AuthMe; BOT_PW stays empty ("BOT_PW is empty" is harmless).
echo [i] If the log says the channel table is a sample, capture a real one first:
echo     docs/01-deploy/05-get-modpack-and-capture.md (Chinese doc)
echo.

REM Use a private capture when present (untracked, see .gitignore)
if exist "capture\private-channel-capture.json" (
  set "MC_CAPTURE=%CD%\capture\private-channel-capture.json"
  echo [i] using private channel capture
)

REM Pick a free bridge port (8801 may be taken by another bot already running)
set "BRIDGE_PORT="
for %%P in (8801 8802 8803 8804 8805) do (
  if not defined BRIDGE_PORT (
    netstat -ano | findstr ":%%P" | findstr "LISTENING" >nul || set "BRIDGE_PORT=%%P"
  )
)
if not defined BRIDGE_PORT set "BRIDGE_PORT=8801"
echo [i] bridge port %BRIDGE_PORT%  -^>  console base: http://127.0.0.1:%BRIDGE_PORT%

set "BOT_PW="
set "BOT_REG=0"
set "COMBAT_OFF=1"
set "XP_LOW_LEVEL=0"
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
