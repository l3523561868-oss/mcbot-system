#!/bin/sh
# Termux:Widget 一键启动脚本
# 作用：拉起 bot 桥接(8801/8802) + 控制台(8900) + 大脑(8902)，并脱离挂件会话常驻后台。
# 用法：把本文件 cp 到 ~/.termux/termux-widget/ 并 chmod +x，桌面加 Termux widget 即可点一下启动。
# 控制台地址：手机浏览器打开 http://127.0.0.1:8900
DEP="$HOME/termux_deploy"
if [ ! -f "$DEP/start.sh" ]; then
  echo "未找到 $DEP/start.sh，请先按 README 把 termux_deploy 放到 ~/termux_deploy"
  sleep 3
  exit 1
fi
# setsid + 重定向，确保子进程脱离 widget 会话、不会被挂件关闭时一起杀掉
setsid bash "$DEP/start.sh" < /dev/null > /dev/null 2>&1 &
echo "已在后台启动 MC 控制台 -> 手机浏览器打开 http://127.0.0.1:8900"
sleep 2
