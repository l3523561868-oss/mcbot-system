#!/bin/sh
# ============================================================
# Termux 启动脚本（旧安卓手机当 24h 常开服务器）
# 作用：在本机跑 bot 桥接 + 控制台，手机/Tailscale 即可远程控制，彻底不依赖你的电脑。
# ============================================================
cd "$(dirname "$0")"

# ========== ① 改成你自己的账号口令（必填） ==========
BOT1_USER=bot_one
BOT1_PW=<BOT1_PASSWORD>
BOT2_USER=bot_two
BOT2_PW=<BOT2_PASSWORD>
# 远程/公网才需要；Tailscale 内网留空即可
CONSOLE_TOKEN=""

# ========== ② 保持唤醒（避免 Termux 被安卓杀后台） ==========
termux-wake-lock 2>/dev/null

# ========== ③ 首次安装 Node 依赖（mineflayer 等，约几百 MB，之后可注释掉） ==========
if [ ! -d node_modules ]; then
  echo "[termux] 首次安装 mineflayer 依赖，请耐心等…"
  npm install
fi

# ========== ④ 启动两个 bot 桥接（连远程 MC 服务器） ==========
echo "[termux] 启动 bot 桥接 8801/8802…"
BOT_PW=$BOT1_PW BOT_REG=0 COMBAT_OFF=1 XP_LOW_LEVEL=0 BRIDGE_PORT=8801 \
  node forge-live.mjs mc.example.com 25565 $BOT1_USER > bot-8801.log 2>&1 &
BOT_PW=$BOT2_PW BOT_REG=0 COMBAT_OFF=1 XP_LOW_LEVEL=0 BRIDGE_PORT=8802 \
  node forge-live.mjs mc.example.com 25565 $BOT2_USER > bot-8802.log 2>&1 &

# ========== ⑤ 启动控制台 + 大脑（对外暴露 0.0.0.0） ==========
echo "[termux] 启动控制台 8900 / 大脑 8902…"
CONSOLE_HOST=0.0.0.0 CONSOLE_TOKEN=$CONSOLE_TOKEN \
  python console.py --host 0.0.0.0 --port 8900 > console.log 2>&1 &
CONSOLE_HOST=0.0.0.0 CONSOLE_TOKEN=$CONSOLE_TOKEN \
  python brain.py --host 0.0.0.0 --port 8902 > brain.log 2>&1 &

echo ""
echo "✅ 已启动。本机浏览器开 http://127.0.0.1:8900 验证。"
echo "   同 Tailscale 的控制端手机开 http://<本机Tailscale IP>:8900 即可遥控。"
echo "   日志：cat console.log / bot-8801.log / bot-8802.log"
