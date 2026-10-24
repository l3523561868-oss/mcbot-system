#!/bin/sh
# ============================================================
# 一键更新：从 PC 拉最新包 → 解压 → 打补丁 → 干净重启
# 用法：sh ~/termux_deploy/update.sh
# 前置：PC 上已运行  python make_deploy.py --serve
# ============================================================

# 下载服务地址：优先环境变量 → 包内 pc_ip.txt（打包时自动写入）→ 兜底
# 临时改：PC_IP=192.168.1.5 PC_PORT=8000 sh ~/termux_deploy/update.sh
PC_IP="${PC_IP:-$(cat "$HOME/termux_deploy/pc_ip.txt" 2>/dev/null)}"
PC_PORT="${PC_PORT:-$(cat "$HOME/termux_deploy/pc_port.txt" 2>/dev/null)}"
PC_IP="${PC_IP:-192.168.1.50}"
PC_PORT="${PC_PORT:-8000}"
# 去掉换行/回车/空格：pc_port.txt 若是 Windows 换行，会拼出 ":8000\r" → curl 报 Port number invalid
PC_IP=$(printf '%s' "$PC_IP" | tr -d '[:space:]')
PC_PORT=$(printf '%s' "$PC_PORT" | tr -d '[:space:]')
BASE="http://$PC_IP:$PC_PORT"
ZIP="$HOME/t.zip"

echo "[update] 目标 $BASE"

echo "[update] 从 $BASE 拉取…"
curl -Lo "$ZIP" "$BASE/termux_deploy.zip" || {
  echo "[update] !! 下载失败。确认 PC 上 python make_deploy.py --serve 正在跑"
  exit 1
}

echo "[update] md5: $(md5sum "$ZIP" 2>/dev/null | cut -d' ' -f1)"
echo "[update] 大小: $(wc -c < "$ZIP" 2>/dev/null) 字节"

unzip -oq "$ZIP" -d "$HOME" || { echo "[update] !! 解压失败"; exit 1; }
echo "[update] 解压完成"

sh "$HOME/termux_deploy/setup.sh"
sh "$HOME/termux_deploy/restart.sh"
