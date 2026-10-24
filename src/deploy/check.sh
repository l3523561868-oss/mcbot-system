#!/bin/sh
# ============================================================
# 一条命令体检：进程 / 控制台 / bot 桥 / 最近的断开与踢出原因
# 用法：sh ~/termux_deploy/check.sh
# 目的：不用记那些带引号和反斜杠的 grep（手打很容易变成 $$end$$ 这种空匹配）
# ============================================================
cd "$HOME/termux_deploy" 2>/dev/null || { echo "找不到 ~/termux_deploy"; exit 1; }

echo "== 时间 =="
date '+%H:%M:%S'

echo "== 进程 =="
echo "  forge-live: $(pgrep -f forge-live.mjs 2>/dev/null | wc -l | tr -d ' ')"
echo "  console.py : $(pgrep -f console.py 2>/dev/null | wc -l | tr -d ' ')"
echo "  watchdog   : $(pgrep -f watchdog.sh 2>/dev/null | wc -l | tr -d ' ')"

echo "== 控制台 =="
echo "  HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8900/ 2>/dev/null)"

echo "== bot 桥 =="
for p in 8801 8802; do
  printf "  %s: " "$p"
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$p/state" 2>/dev/null)
  [ -n "$c" ] && echo "HTTP $c" || echo "无响应"
done

for n in 8801 8802; do
  f="bot-$n.log"
  echo "== bot$n =="
  if [ ! -f "$f" ]; then echo "  (没有 $f)"; continue; fi
  echo "  日志行数: $(wc -l < "$f" | tr -d ' ')"
  echo "  -- 最近断开 --"
  grep -F "[end]" "$f" 2>/dev/null | tail -3 | sed 's/^/  /'
  echo "  -- 最近被踢 --"
  grep -F "[kicked]" "$f" 2>/dev/null | tail -3 | sed 's/^/  /'
  echo "  -- 登录相关 --"
  grep -iE "login|登录" "$f" 2>/dev/null | tail -3 | sed 's/^/  /'
done

echo ""
echo "（隔 1 分钟再跑一次，看「日志行数」有没有涨：涨=进程活着，不动=卡住）"
