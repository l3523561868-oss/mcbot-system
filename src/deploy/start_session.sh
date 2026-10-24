#!/bin/sh
# ============================================================
# 会话模式启动器：在「当前 Termux 会话」内拉起 bot。
#   - 打开 Termux 时由 ~/.bashrc 自动调用；
#   - 关闭 Termux / 退出会话时，bot 作为子进程一起被停。
# 不脱离会话（不用 setsid）：Termux 一关，bot 随之停 —— 与 24h 常开的 start.sh 相反。
# 但会申请 termux-wake-lock，避免 Android 在锁屏/后台时把 Termux 回收
# （不申请的症状：啥也没做，Termux 自己回到 Welcome 界面、bot 全没了）。
# 要「杀干净重来」请用 restart.sh。
# ============================================================

DEP="$HOME/termux_deploy"
cd "$DEP" 2>/dev/null || { echo "[bot] 找不到 $DEP"; exit 1; }

# 自启开关：这个文件存在就不自动拉起（不想改 ~/.bashrc 时用它）
if [ -f "$DEP/NO_AUTOSTART" ]; then
  echo "[bot] 检测到 NO_AUTOSTART，跳过自启。要恢复：rm ~/termux_deploy/NO_AUTOSTART"
  exit 0
fi

# npm install 会还原 node_modules，补丁丢了就会出现
# "problem inflating chunk" / "Cannot read properties of undefined"
if [ -d node_modules ] && [ -f apply-patches.mjs ]; then
  node apply-patches.mjs >/dev/null 2>&1
fi

echo "[bot] 启动中…"

# 申请唤醒锁：阻止 Android 在锁屏/后台时把 Termux 挂起或回收
# （不申请就会出现"啥也没做，Termux 自己回到 Welcome 界面、bot 没了"）
termux-wake-lock 2>/dev/null && echo "[bot] 已申请唤醒锁"

PIDS=""

# ---- 控制台 / 大脑：各自独立判断，缺哪个起哪个 ----
# ★ 不能写成"没有 forge-live 才启动"：Android 杀会话后常留下僵尸 node，
#   那样判断会命中并直接 exit，导致 console.py 根本没启动 → 控制台打不开。
if pgrep -f "console.py" >/dev/null 2>&1; then
  echo "[bot] console.py 已在运行"
else
  CONSOLE_HOST=0.0.0.0 python console.py --host 0.0.0.0 --port 8900 \
    > console.log 2>&1 &
  PIDS="$PIDS $!"
fi

if pgrep -f "brain.py" >/dev/null 2>&1; then
  echo "[bot] brain.py 已在运行"
else
  CONSOLE_HOST=0.0.0.0 python brain.py --host 0.0.0.0 --port 8902 \
    > brain.log 2>&1 &
  PIDS="$PIDS $!"
fi

# ---- bot：只在完全没有残留时才起，避免重复登录被踢 ----
if pgrep -f "forge-live.mjs" >/dev/null 2>&1; then
  echo "[bot] bot 已在运行，跳过重复登录"
else
BOT_PW='<BOT1_PASSWORD>' BOT_REG=0 COMBAT_OFF=1 XP_LOW_LEVEL=0 \
  CHAT_MONITOR_OFF=1 WAYSTONE_EYE_OFF=1 RECONNECT_STAGGER=0 \
  BRIDGE_PORT=8801 node forge-live.mjs \
  mc.example.com 25565 bot_one > bot-8801.log 2>&1 &
PIDS="$PIDS $!"

# 错开 12 秒再上第二个：同 IP 两个账号同一秒登录容易触发服务端 Connection throttled
sleep 12

BOT_PW='<BOT2_PASSWORD>' BOT_REG=0 COMBAT_OFF=1 XP_LOW_LEVEL=0 \
  CHAT_MONITOR_OFF=1 WAYSTONE_EYE_OFF=1 RECONNECT_STAGGER=15000 \
  BRIDGE_PORT=8802 node forge-live.mjs \
  mc.example.com 25565 bot_two > bot-8802.log 2>&1 &
PIDS="$PIDS $!"
fi

stop_all() {
  echo
  echo "[bot] 收到退出信号，停止 bot…"
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  sleep 1
  for p in $PIDS; do kill -9 "$p" 2>/dev/null; done
  termux-wake-unlock 2>/dev/null
  echo "[bot] 已全部停止。"
  exit 0
}
trap stop_all INT TERM HUP EXIT

sleep 3
echo "[bot] 已启动：控制台 http://127.0.0.1:8900"
echo "[bot] 会话运行中；关闭 Termux 即可停止全部 bot（Ctrl-C 也行）。"

# 不用 wait：4 个子进程全死时 wait 会立刻返回，随即触发 EXIT 把刚起的进程再杀一遍。
# 改成心跳轮询：只要还有一个 bot 活着就一直守着。
while :; do
  sleep 5
  pgrep -f "forge-live.mjs" >/dev/null 2>&1 || break
done

echo "[bot] bot 已全部退出，本脚本结束。"
