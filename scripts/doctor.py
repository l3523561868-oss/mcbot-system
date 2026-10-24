#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""doctor.py — 环境体检与运行校验（零第三方依赖）

用途：一条命令判断"为什么跑不起来"，并给出下一步该做什么。
适合人和 AI 共用：默认人读，--json 供自动化。

用法（在仓库根目录）：
    python scripts/doctor.py                 # 体检（环境 + 配置 + 通道表 + 端口）
    python scripts/doctor.py --verify        # 追加运行校验（控制台 200 / bot 在线）
    python scripts/doctor.py --json          # 机器可读输出
    python scripts/doctor.py --strict        # 有警告也返回非 0

退出码：0 = 通过（允许警告）；1 = 有 FAIL；2 = --strict 且有 WARN
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONSOLE_DIR = os.path.join(ROOT, "src", "console")
BOT_DIR = os.path.join(ROOT, "src", "bot")
PATCHES = [
    "minecraft-protocol/src/client.js",
    "mineflayer/lib/plugins/inventory.js",
    "prismarine-nbt/nbt.js",
    "prismarine-registry/lib/pc/index.js",
    "prismarine-registry/lib/pc/transforms.js",
]
SAMPLE_THRESHOLD = 100     # 通道表少于这个条数，基本可以判定是仓库自带样本
PORTS = {"控制台": 8900, "大脑": 8902, "bot1 桥": 8801, "bot2 桥": 8802}

RESULTS = []


def add(status, name, detail, fix=""):
    RESULTS.append({"status": status, "name": name, "detail": detail, "fix": fix})


def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def run(cmd):
    """返回 (ok, 输出首行)。自动处理 Windows 的 .cmd/.exe 包装（npm.cmd 等）。"""
    exe = cmd[0]
    path = shutil.which(exe)
    if path is None and os.name == "nt":
        for ext in (".cmd", ".exe", ".bat"):
            path = shutil.which(exe + ext)
            if path:
                break
    if path is None:
        return False, "未找到 %s" % exe
    try:
        p = subprocess.run([path] + list(cmd[1:]), capture_output=True,
                           text=True, timeout=20, shell=False)
    except Exception as e:
        return False, str(e)
    out = (p.stdout or p.stderr or "").strip()
    return p.returncode == 0, out.splitlines()[0] if out else ""


def vtuple(s):
    return tuple(int(x) for x in re.findall(r"\d+", s)[:3] or [0])


# ---------- 环境 ----------

def check_runtime():
    v = "%d.%d.%d" % sys.version_info[:3]
    if sys.version_info[:2] >= (3, 10):
        add("PASS", "Python 版本", v)
    else:
        add("FAIL", "Python 版本", "%s（需要 3.10+）" % v,
            "安装 Python 3.10 或更高版本，并确保 `python` 指向它")

    ok, out = run(["node", "--version"])
    if not ok:
        add("FAIL", "Node.js", "未找到 node",
            "安装 Node 18+（https://nodejs.org 或 nvm）；装完重开终端")
    else:
        ver = out.lstrip("v")
        if vtuple(ver) >= (18, 0, 0):
            add("PASS", "Node.js", ver)
        else:
            add("FAIL", "Node.js", "%s（需要 18+）" % ver,
                "升级 Node：项目依赖 mineflayer 4.x 需要 Node 18 以上")

    ok, out = run(["npm", "--version"])
    add("PASS" if ok else "WARN", "npm", out if ok else "未找到 npm",
        "" if ok else "npm 随 Node 安装；若只有 node 没有 npm，请重新安装 Node")

    ok, out = run(["git", "--version"])
    add("PASS" if ok else "WARN", "git", out if ok else "未找到 git",
        "" if ok else "仅从源码更新时需要；可装 Git for Windows")


# ---------- 文件与补丁 ----------

def check_files():
    required = [
        (os.path.join(CONSOLE_DIR, "console.py"), "控制台后端"),
        (os.path.join(CONSOLE_DIR, "index.html"), "控制台前端"),
        (os.path.join(CONSOLE_DIR, "adapters.py"), "适配层"),
        (os.path.join(BOT_DIR, "forge-live.mjs"), "协议 bot 主程序"),
        (os.path.join(BOT_DIR, "package.json"), "bot 依赖声明"),
    ]
    missing = [n for p, n in required if not os.path.exists(p)]
    if missing:
        add("FAIL", "必要文件", "缺失：" + "、".join(missing),
            "确认在仓库根目录运行；或重新 git clone")
    else:
        add("PASS", "必要文件", "5/5 存在")


def check_patches():
    nm = os.path.join(BOT_DIR, "node_modules")
    if not os.path.isdir(nm):
        add("FAIL", "node 依赖", "未安装 node_modules",
            "cd src/bot && npm install && node apply-patches.mjs")
        return
    add("PASS", "node 依赖", "node_modules 已存在")

    bad, okc = [], 0
    for rel in PATCHES:
        built = os.path.join(nm, rel)
        src = os.path.join(BOT_DIR, "patches", rel)
        if not os.path.exists(src):
            bad.append(rel + "（补丁源缺失）")
            continue
        if not os.path.exists(built):
            bad.append(rel + "（node_modules 中不存在）")
            continue
        if md5(built) == md5(src):
            okc += 1
        else:
            bad.append(rel)

    if not bad:
        add("PASS", "node_modules 补丁", "%d/%d 已生效" % (okc, len(PATCHES)))
    else:
        add("FAIL", "node_modules 补丁", "%d/%d 生效；未生效：%s"
            % (okc, len(PATCHES), "、".join(bad[:3]) + ("…" if len(bad) > 3 else "")),
            "cd src/bot && node apply-patches.mjs（每次 npm install 后都必须重打）")


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def check_channels():
    cap = os.path.join(BOT_DIR, "capture", "channel-capture.json")
    spec = os.path.join(BOT_DIR, "channel-specs.json")
    if not os.path.exists(cap):
        add("FAIL", "通道表", "缺 capture/channel-capture.json",
            "见 src/bot/capture/README.md：用与目标服务器一致的客户端抓一份")
        return
    try:
        n = len(load_json(cap))
    except Exception as e:
        add("FAIL", "通道表", "解析失败：%s" % e, "确认文件是合法 JSON 数组")
        return

    if n < SAMPLE_THRESHOLD:
        add("WARN", "通道表", "%d 条（疑似仓库自带样本）" % n,
            "连真服前必须替换：见 docs/01-部署流程/05-获取整合包与抓包.md；"
            "仅本地演示可设 ALLOW_SAMPLE=1 跳过启动校验")
    else:
        add("PASS", "通道表", "%d 条" % n)

    if os.path.exists(spec):
        try:
            m = len(load_json(spec))
            add("PASS" if m > 20 else "WARN", "通道版本表", "%d 条" % m,
                "" if m > 20 else "条数偏少，版本号会退回默认值，可能协商失败")
        except Exception as e:
            add("WARN", "通道版本表", "解析失败：%s" % e, "")
    else:
        add("WARN", "通道版本表", "缺 channel-specs.json", "可从抓包工具一并导出")


def check_config():
    bots = os.path.join(CONSOLE_DIR, "bots.json")
    if not os.path.exists(bots):
        add("FAIL", "bots.json", "未创建",
            "cd config && cp bots.example.json ../src/console/bots.json，然后填服务器/账号")
        return
    try:
        data = load_json(bots)
    except Exception as e:
        add("FAIL", "bots.json", "解析失败：%s" % e, "检查 JSON 语法（末尾逗号最常见）")
        return
    enabled = [b for b in data if b.get("enabled", True)]
    add("PASS" if enabled else "WARN", "bots.json", "%d 个 bot（启用 %d）" % (len(data), len(enabled)),
        "" if enabled else "没有启用的 bot，控制台会空白")

    brain = os.path.join(CONSOLE_DIR, "brain.json")
    if os.path.exists(brain):
        add("PASS", "brain.json", "已配置（LLM 可选）")
    else:
        add("WARN", "brain.json", "未配置",
            "不接 LLM 可忽略；要接则 cp config/brain.example.json ../src/console/brain.json")


# ---------- 端口与运行态 ----------

def port_open(port):
    s = socket.socket()
    s.settimeout(0.3)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def http_get(port, path="/", timeout=3):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 绕本机代理
    try:
        with opener.open("http://127.0.0.1:%d%s" % (port, path), timeout=timeout) as r:
            return r.status, r.read(4096).decode("utf-8", "replace")
    except Exception as e:
        return None, str(e)


def check_ports():
    snap = {name: port_open(p) for name, p in PORTS.items()}
    up = [n for n, v in snap.items() if v]
    if up:
        add("PASS", "端口占用", "正在监听：" + "、".join(up))
    else:
        add("WARN", "端口占用", "四个端口都空闲（服务未启动）",
            "python src/console/console.py --port 8900 或 scripts/启动全部.bat")
    return snap


# ---------- 运行校验（--verify） ----------

def verify(snap):
    if not snap.get("控制台"):
        add("FAIL", "控制台可达", "8900 未监听", "先启动控制台再 --verify")
    else:
        code, body = http_get(8900, "/")
        if code == 200:
            add("PASS", "控制台可达", "HTTP 200（%d 字节）" % len(body))
        else:
            add("FAIL", "控制台可达", "HTTP %s" % code, "看 console 日志末尾；常见是缺 scenarios.py 或端口被占")

    if not snap.get("bot1 桥"):
        add("FAIL", "bot 在线", "8801 未监听", "启动协议 bot（见 docs/01/01 §4）")
        return
    code, body = http_get(8801, "/state")
    if code != 200:
        add("FAIL", "bot 在线", "桥返回 %s" % code, "看 bot 日志：协商成功 / kicked / login")
        return
    try:
        st = json.loads(body)
    except Exception:
        add("FAIL", "bot 在线", "state 不是合法 JSON", "")
        return
    online = bool(st.get("online"))
    authed = bool(st.get("authed"))
    pos = st.get("position")
    detail = "online=%s authed=%s pos=%s" % (online, authed, pos)
    if online and authed:
        add("PASS", "bot 在线", detail)
    elif online and not authed:
        add("FAIL", "bot 在线", detail + "（未通过 AuthMe 登录）",
            "核对 BOT_PW；日志应有 >> /login（第 N 次）")
    else:
        add("FAIL", "bot 在线", detail, "手握手/通道表问题：grep 协商成功 / kicked 日志")


# ---------- 输出 ----------

def emit(as_json, strict):
    fails = [r for r in RESULTS if r["status"] == "FAIL"]
    warns = [r for r in RESULTS if r["status"] == "WARN"]
    code = 1 if fails else (2 if (strict and warns) else 0)

    if as_json:
        print(json.dumps({"ok": not fails, "exit": code,
                          "pass": len([r for r in RESULTS if r["status"] == "PASS"]),
                          "warn": len(warns), "fail": len(fails),
                          "checks": RESULTS}, ensure_ascii=False, indent=2))
        return code

    icon = {"PASS": "[ OK ]", "WARN": "[WARN]", "FAIL": "[FAIL]"}
    print("MCBot 体检  ·  %s" % ROOT)
    print("-" * 68)
    for r in RESULTS:
        print("%s %-18s %s" % (icon[r["status"]], r["name"], r["detail"]))
        if r["fix"] and r["status"] != "PASS":
            print("        → %s" % r["fix"])
    print("-" * 68)
    print("通过 %d · 警告 %d · 失败 %d" % (
        len([r for r in RESULTS if r["status"] == "PASS"]), len(warns), len(fails)))

    if fails:
        print("\n先解决 FAIL 项。第一条优先：")
        print("  " + fails[0]["name"] + " → " + (fails[0]["fix"] or fails[0]["detail"]))
    elif warns:
        print("\n可用，但注意上面的 WARN（尤其通道表条数）。")
        print("连真服前请确认：docs/01-部署流程/05-获取整合包与抓包.md")
    else:
        print("\n全部通过。启动控制台后可用 --verify 做运行校验。")
    return code


def main():
    ap = argparse.ArgumentParser(description="MCBot 环境体检")
    ap.add_argument("--verify", action="store_true", help="追加运行校验（控制台 200 / bot 在线）")
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    ap.add_argument("--strict", action="store_true", help="有警告也返回非 0")
    a = ap.parse_args()

    check_runtime()
    check_files()
    check_patches()
    check_channels()
    check_config()
    snap = check_ports()
    if a.verify:
        verify(snap)

    sys.exit(emit(a.json, a.strict))


if __name__ == "__main__":
    main()
