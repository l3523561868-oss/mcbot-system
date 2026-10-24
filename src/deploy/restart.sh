#!/bin/sh
# ============================================================
# 干净重启：杀光所有残留 → 恢复 node_modules 补丁 → 启动 → 自检
# 用法：sh ~/termux_deploy/restart.sh
# 日常「重进 Termux 自动启动」走 start_session.sh；
# 一旦出现重复进程 / 端口占用 / 打不开控制台，就用本脚本。
# ============================================================

DEP="$HOME/termux_deploy"
cd "$DEP" 2>/dev/null || { echo "[x] 找不到 $DEP"; exit 1; }

say() { echo "[$(date +%H:%M:%S)] $*"; }

# ---------- 1. 杀光残留 ----------
say "1/5 停止所有残留进程…"

# 唤醒锁：防止 Android 在后台回收 Termux（否则会出现"Termux 自己回到 Welcome、bot 消失"）
termux-wake-lock 2>/dev/null

# 先停包装脚本，避免它退出时又拉起一套
pkill -f start_session.sh 2>/dev/null
pkill -f forge-live.mjs   2>/dev/null
pkill -f console.py       2>/dev/null
pkill -f brain.py         2>/dev/null
sleep 2

# 强杀第二轮
pkill -9 -f forge-live.mjs 2>/dev/null
pkill -9 -f console.py     2>/dev/null
pkill -9 -f brain.py       2>/dev/null
sleep 1

LEFT=$(pgrep -f "forge-live.mjs|console.py|brain.py" 2>/dev/null | wc -l | tr -d ' ')
say "    剩余进程数：$LEFT"
if [ "$LEFT" != "0" ]; then
  say "    !! 仍有残留，列出："
  ps -ef 2>/dev/null | grep -E "forge-live|console\.py|brain\.py" | grep -v grep
fi

# ---------- 2. 补丁 ----------
say "2/5 恢复 node_modules 补丁…"
if [ ! -d node_modules ]; then
  say "    !! 没有 node_modules，先执行：cd $DEP && npm install"
  exit 1
fi
if [ -f apply-patches.mjs ]; then
  node apply-patches.mjs 2>&1 | tail -1
else
  say "    !! 缺少 apply-patches.mjs"
fi

# ---------- 3. 启动 ----------
say "3/5 启动 4 个服务…"

CONSOLE_HOST=0.0.0.0 python console.py --host 0.0.0.0 --port 8900 \
  > console.log 2>&1 &
C_PID=$!

CONSOLE_HOST=0.0.0.0 python brain.py --host 0.0.0.0 --port 8902 \
  > brain.log 2>&1 &
B_PID=$!

BOT_PW='<BOT1_PASSWORD>' BOT_REG=0 COMBAT_OFF=1 XP_LOW_LEVEL=0 \
  CHAT_MONITOR_OFF=1 WAYSTONE_EYE_OFF=1 RECONNECT_STAGGER=0 \
  BRIDGE_PORT=8801 node forge-live.mjs \
  mc.example.com 25565 bot_one > bot-8801.log 2>&1 &
N1_PID=$!

# 单 bot 模式：SINGLE_BOT=1 sh ~/termux_deploy/restart.sh
# 手机资源紧 / bot2 反复被踢时先用它跑起来，只留 bot_one
SINGLE_BOT="${SINGLE_BOT:-0}"

if [ "$SINGLE_BOT" = "1" ]; then
  say "    单 bot 模式：只起 bot_one，跳过 bot2"
  N2_PID=0
else
  # 等 bot1 真正协商成功，再空 15 秒才起 bot2。
  # 固定 sleep 不够：bot1 还没握完手就把 bot2 塞进去，同 IP 双连最容易被判限流/互踢。
  i=0
  while [ $i -lt 50 ]; do
    sleep 2
    i=$((i + 2))
    grep -q "协商成功" bot-8801.log 2>/dev/null && break
    kill -0 $N1_PID 2>/dev/null || break
  done
  [ $i -gt 0 ] && say "    等 bot1 就位 ${i}s，再空 15s 起 bot2（同 IP 错开）"
  sleep 15

  BOT_PW='<BOT2_PASSWORD>' BOT_REG=0 COMBAT_OFF=1 XP_LOW_LEVEL=0 \
    CHAT_MONITOR_OFF=1 WAYSTONE_EYE_OFF=1 RECONNECT_STAGGER=15000 \
    BRIDGE_PORT=8802 node forge-live.mjs \
    mc.example.com 25565 bot_two > bot-8802.log 2>&1 &
  N2_PID=$!
fi

say "    pid: console=$C_PID brain=$B_PID bot1=$N1_PID bot2=$N2_PID"

# ---------- 4. 等握手 ----------
say "4/5 等待 NeoForge 握手（最多 90 秒）…"
i=0
OK1=0
OK2=0
[ "$SINGLE_BOT" = "1" ] && OK2=1    # 单 bot 模式不用等 bot2
while [ $i -lt 90 ]; do
  sleep 3
  i=$((i + 3))
  grep -q "协商成功" bot-8801.log 2>/dev/null && OK1=1
  [ "$SINGLE_BOT" = "1" ] || grep -q "协商成功" bot-8802.log 2>/dev/null && OK2=1
  [ $OK1 = 1 ] && [ $OK2 = 1 ] && break
  kill -0 $N1_PID 2>/dev/null || { say "    !! bot1 进程已退出"; break; }
  [ "$SINGLE_BOT" = "1" ] || { kill -0 $N2_PID 2>/dev/null || { say "    !! bot2 进程已退出"; break; }; }
done

# ---------- 5. 结果 ----------
say "5/5 结果"
echo "  bot1 握手: $([ $OK1 = 1 ] && echo 成功 || echo 未完成)"
if [ "$SINGLE_BOT" = "1" ]; then
  echo "  bot2 握手: 已跳过（单 bot 模式）"
else
  echo "  bot2 握手: $([ $OK2 = 1 ] && echo 成功 || echo 未完成)"
fi

# 控制台真实自检：原来只 echo 一行地址，console.py 崩了/端口被占也照印，等于没查
CH="000"
j=0
while [ $j -lt 10 ]; do
  CH=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:8900/ 2>/dev/null)
  [ "$CH" = "200" ] && break
  sleep 1
  j=$((j + 1))
  kill -0 $C_PID 2>/dev/null || break    # console 进程已死，别再等
done
echo "  控制台   : http://127.0.0.1:8900 （HTTP $CH）"

if [ "$CH" != "200" ]; then
  echo ""
  echo "!! 控制台打不开（HTTP $CH）。下面两条决定原因："
  kill -0 $C_PID 2>/dev/null && echo "   console 进程还在（可能在报错或端口被占）" || echo "   console 进程已退出"
  echo "--- console.log 末尾 ---"
  tail -15 console.log 2>/dev/null
fi

if [ $OK1 = 0 ] || [ $OK2 = 0 ]; then
  echo ""
  echo "--- bot-8801.log 末尾 ---"
  tail -12 bot-8801.log 2>/dev/null
fi

echo ""
# ---------- 6. 看门狗：8900 挂掉自动拉起 ----------
if pgrep -f watchdog.sh >/dev/null 2>&1; then
  say "看门狗已在运行"
else
  nohup sh "$DEP/watchdog.sh" >/dev/null 2>&1 &
  say "看门狗已启动（8900 连续两次不通就自动重启 console.py，日志 watchdog.log）"
fi

echo "停止全部：pkill -f forge-live.mjs; pkill -f console.py; pkill -f brain.py"
echo "停看门狗：pkill -f watchdog.sh"
