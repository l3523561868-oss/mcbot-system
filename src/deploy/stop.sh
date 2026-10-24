#!/bin/sh
# 手动停止所有 bot（会话模式或 24h 模式通用）
pkill -f forge-live.mjs 2>/dev/null
pkill -f console.py     2>/dev/null
pkill -f brain.py       2>/dev/null
echo "[bot] 已发送停止信号。若进程仍残留，直接关闭 Termux 即可。"
