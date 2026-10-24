#!/bin/sh
# 一键安装/更新：
#   1) 把本脚本所在目录的全部文件复制到 ~/termux_deploy
#   2) 设好可执行位
#   3) 配置「打开 Termux 自动启动 bot」（写入 ~/.bashrc，仅一次）
# 用法：在解压出来的 termux_deploy 目录里执行  sh setup.sh
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/termux_deploy"
echo "[setup] 源目录: $SRC"
echo "[setup] 目标目录: $DEST"
mkdir -p "$DEST"
if [ "$SRC" != "$DEST" ]; then
  cp -rf "$SRC"/. "$DEST"/ 2>/dev/null
fi
cd "$DEST" || { echo "[setup] 进入目标目录失败"; exit 1; }
chmod +x start.sh start_session.sh stop.sh restart.sh 2>/dev/null

# 关键资源自检（缺 capture/channel-capture.json → NeoForge 握手必失败，被服务器踢）
MISS=0
for f in capture/channel-capture.json \
         channel-specs.json \
         scenarios.py forge-live.mjs \
         patches/prismarine-nbt/nbt.js \
         apply-patches.mjs; do
  [ -f "$f" ] || { echo "[setup] !! 缺少 $f"; MISS=1; }
done
[ "$MISS" = 0 ] && echo "[setup] 关键资源齐全"

# 恢复 node_modules 补丁（npm install 会覆盖掉，缺了会 "problem inflating chunk"）
echo "[setup] 恢复 node_modules 补丁…"
if [ -d node_modules ]; then
  node apply-patches.mjs 2>&1 | tail -1
else
  echo "[setup] !! 还没装依赖：先执行 cd $DEST && npm install"
fi

# 配置 .bashrc 自启（只在没配过时追加）
if grep -q "start_session.sh" "$HOME/.bashrc" 2>/dev/null; then
  echo "[setup] ~/.bashrc 已配置过自启，跳过"
else
  cat >> "$HOME/.bashrc" <<'RC'

# MC bot 会话模式：打开 Termux 自动启动，关闭 Termux 自动停止
if [ -f "$HOME/termux_deploy/start_session.sh" ]; then
  "$HOME/termux_deploy/start_session.sh" >/dev/null 2>&1 &
fi
RC
  echo "[setup] 已写入 ~/.bashrc：打开 Termux 自动启动"
fi

echo "[setup] 完成！关闭 Termux 再重新打开，bot 会自动启动；关闭 Termux 即停止。"
