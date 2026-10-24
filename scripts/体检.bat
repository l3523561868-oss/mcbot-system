@echo off
chcp 65001 >nul
REM 环境体检：缺什么、下一步做什么，一条命令说清
cd /d "%~dp0.."
python scripts\doctor.py %*
pause
