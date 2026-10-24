#!/bin/sh
# ============================================================
# 看门狗：每 30 秒看一眼 8900，挂了就把 console.py 拉起来
# 用法：nohup sh ~/termux_deploy/watchdog.sh >/dev/null 2>&1 &
# restart.sh 会自动启动它；不想用了：pkill -f watchdog.sh
# ============================================================
DEP="$HOME/termux_deploy"
cd "$DEP" 2>/dev/null || exit 1
WLOG="$DEP/watchdog.log"
FAILS=0

echo "[$(date '+%H:%M:%S')] watchdog 启动（pid $$，每 30s 检查 8900）" >> "$WLOG"

while :; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:8900/ 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    FAILS=0
  else
    FAILS=$((FAILS + 1))
    # 连续两次都失败才动手，避免控制台正忙（8s 长请求）时误判
    if [ "$FAILS" -ge 2 ]; then
      echo "[$(date '+%H:%M:%S')] 8900 连续 $FAILS 次异常（$CODE），重启 console.py" >> "$WLOG"
      pkill -f console.py 2>/dev/null
      sleep 1
      pkill -9 -f console.py 2>/dev/null
      CONSOLE_HOST=0.0.0.0 python console.py --host 0.0.0.0 --port 8900 >> console.log 2>&1 &
      sleep 4
      C2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:8900/ 2>/dev/null)
      echo "[$(date '+%H:%M:%S')] 重启后 HTTP $C2" >> "$WLOG"
      FAILS=0
    fi
  fi
  sleep 30
done
