#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
同步 PC 端最新代码 -> termux_deploy -> 打包 -> 供手机一键更新。

用法：
    python make_deploy.py              # 只同步 + 打包
    python make_deploy.py --serve      # 同步 + 打包 + 起下载服务（会阻塞）
    python make_deploy.py --ip 192.168.137.1 --port 8001

手机端更新只需一条：
    sh ~/termux_deploy/update.sh
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, "termux_deploy")
SERVE = os.path.join(HERE, "_tmp_serve")

# 控制台 / 后端：来自 <repo>/src/console
SRC_MAIN = os.path.join(os.path.dirname(HERE), "console")
# bot 协议客户端 + 抓包 + 补丁：来自 <repo>/src/bot
SRC_BOT = os.path.join(os.path.dirname(HERE), "bot")

FILES_MAIN = [
    "console.py", "index.html", "adapters.py", "providers.py", "brain.py",
    "scenarios.py", "bots.json", "providers.json", "brain.json", "usage.json",
]
DIRS_MAIN = ["item_icons"]

FILES_BOT = [
    "forge-live.mjs", "channel-specs.json", "package.json",
    "package-lock.json", "apply-patches.mjs",
]
DIRS_BOT = ["capture", "patches"]

PY = sys.executable


def md5(path):
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def sync_files(src_dir, dst_dir, names, label):
    print(f"\n--- {label} ---")
    for n in names:
        s = os.path.join(src_dir, n)
        d = os.path.join(dst_dir, n)
        if not os.path.exists(s):
            print(f"  [跳过] {n}（源不存在）")
            continue
        if os.path.exists(d) and md5(s) == md5(d):
            print(f"  [未变] {n}")
            continue
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(s, d)
        print(f"  [已更新] {n}  {md5(d)[:8]}")


def sync_dir(src_dir, dst_dir, label):
    print(f"\n--- {label} ---")
    if not os.path.isdir(src_dir):
        print("  [跳过] 源目录不存在")
        return
    changed = 0
    for dp, dn, fn in os.walk(src_dir):
        for f in fn:
            s = os.path.join(dp, f)
            rel = os.path.relpath(s, src_dir)
            d = os.path.join(dst_dir, rel)
            os.makedirs(os.path.dirname(d), exist_ok=True)
            if os.path.exists(d) and md5(s) == md5(d):
                continue
            shutil.copy2(s, d)
            changed += 1
    print(f"  {changed} 个文件有变化")


def detect_lan_ip():
    """探测本机对外网卡地址。DHCP 换网段后写死的 IP 会报 WinError 10049，所以每次动态取。"""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def pack():
    out = os.path.join(HERE, "termux_deploy.zip")
    if os.path.exists(out):
        os.remove(out)
    n = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for dp, dn, fn in os.walk(PKG):
            dn[:] = [x for x in dn if x not in ("node_modules", "__pycache__")]
            for f in sorted(fn):
                if f.endswith((".log", ".pyc")):
                    continue
                p = os.path.join(dp, f)
                z.write(p, os.path.relpath(p, HERE))
                n += 1
    b = open(out, "rb").read()
    print(f"\n打包完成：{len(b)} 字节 ({len(b)/1024:.1f} KB)，{n} 个条目")
    print(f"md5 = {hashlib.md5(b).hexdigest()}")

    os.makedirs(SERVE, exist_ok=True)
    shutil.copy2(out, os.path.join(SERVE, "termux_deploy.zip"))
    print(f"已同步到下载目录：{SERVE}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true", help="打包后启动下载服务")
    ap.add_argument("--ip", default="auto", help="默认 auto 自动探测；DHCP 换网段后不用改")
    ap.add_argument("--port", default="8000")
    a = ap.parse_args()

    ip = detect_lan_ip() if a.ip == "auto" else a.ip

    # 把本次地址写进包里 → 手机 update.sh 读它当默认值，换网段也能自动跟上
    # newline="\n"：Windows 默认写 \r\n，手机上 PC_PORT 会变成 "8000\r" → curl 报 Port number invalid
    with open(os.path.join(PKG, "pc_ip.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write(ip + "\n")
    with open(os.path.join(PKG, "pc_port.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write(str(a.port) + "\n")

    sync_files(SRC_MAIN, PKG, FILES_MAIN, "控制台/后端")
    for d in DIRS_MAIN:
        sync_dir(os.path.join(SRC_MAIN, d), os.path.join(PKG, d), d)
    sync_files(SRC_BOT, PKG, FILES_BOT, "bot 客户端")
    for d in DIRS_BOT:
        sync_dir(os.path.join(SRC_BOT, d), os.path.join(PKG, d), d)

    pack()

    if a.serve:
        # 不做 bind-close 预检：那一步和 http.server 抢同一个端口，会把「上次 --serve 还活着」
        # 误报成「地址失效」。直接起服务，失败就顺延端口。
        if a.ip != "auto":
            print(f"\n注意：手动指定了 --ip {ip}。若 DHCP 换过网段会报 WinError 10049，改用 --ip auto")

        print(f"\n手机执行：sh ~/termux_deploy/update.sh")
        print(f"（update.sh 会读包内 pc_ip.txt，默认已指向 {ip}）")
        print("Ctrl-C 停止服务\n")

        start = int(a.port)
        for p in range(start, start + 10):
            print(f"本机下载地址：http://{ip}:{p}/termux_deploy.zip")
            try:
                rc = subprocess.run([PY, "-m", "http.server", str(p), "--bind", ip],
                                    cwd=SERVE).returncode
            except KeyboardInterrupt:
                return
            if rc == 0:
                return
            print(f"\n!! {ip}:{p} 起不来（exit {rc}）。")
            print(f"   若报 WinError 10048 = 端口被占，不是地址失效。查占用：")
            print(f"   netstat -ano | findstr :{p}   →  taskkill /PID <PID> /F")
            print("   自动顺延到下一个端口…\n")
        print(f"!! {start}-{start + 9} 全部失败，请手动 --port 换一个")


if __name__ == "__main__":
    main()
