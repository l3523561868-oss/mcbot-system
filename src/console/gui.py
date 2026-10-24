"""gui.py — MC 多 bot 控制台 GUI 版（pywebview 原生窗口）。

行为（2026-10-19 用户要求）：**打开软件才运行，关闭软件强制停掉 bot**。
  - 打开：清残留 bot → 拉起本进程的 bot → 起 控制台(8900)+大脑(8902) → 开窗口
  - 关窗口：终止 bot（并兜底清掉任何残留 forge-live 进程）

打包：pyinstaller --onedir --windowed --name MC-Bot-GUI --icon icon.ico \
        --collect-all webview --collect-all pythonnet --collect-all clr_loader \
        --add-data "index.html;." --add-data "bots.json;." gui.py
"""
import os
import shutil
import socket
import subprocess
import sys
import threading
import time

import webview
from http.server import ThreadingHTTPServer

import brain
import console

# 仓库布局：<repo>/src/console/gui.py → 仓库根 = 上溯两级
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NODE = os.environ.get("NODE_BIN") or "node"          # 可用 NODE_BIN 指定绝对路径
BOT_DIR = os.path.join(ROOT, "src", "bot")
LOG_DIR = os.path.join(console.HERE, "_launcher_log")

NO_WIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def port_open(port):
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", port))
        s.close()
        return True
    except Exception:
        return False


def kill_forge():
    """杀所有 forge-live.mjs 的 node 进程（关软件强制清 bot）。"""
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" "
          "| Where-Object { $_.CommandLine -like '*forge-live.mjs*' } "
          "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                   creationflags=NO_WIN)


BOTS = [
    ("bot_one",  "<BOT1_PASSWORD>",  8801),
    ("bot_two", "<BOT2_PASSWORD>", 8802),
]


def start_bots():
    """拉起全部协议 bot，返回 Popen 列表（关软件时统一 terminate）。"""
    os.makedirs(LOG_DIR, exist_ok=True)
    procs = []
    for i, (user, pw, port) in enumerate(BOTS):
        if i:
            time.sleep(8)   # 错开连接：同 IP 同时双连会触发服务器 "Connection throttled"
        env = dict(os.environ)
        env.update(BOT_PW=pw, BOT_REG="0", COMBAT_OFF="1",
                   XP_LOW_LEVEL="0", BRIDGE_PORT=str(port))
        logf = open(os.path.join(LOG_DIR, f"bot-{port}.log"), "wb")
        procs.append(subprocess.Popen(
            [NODE, "forge-live.mjs", "mc.example.com", "25565", user],
            cwd=BOT_DIR, env=env, stdout=logf, stderr=subprocess.STDOUT,
            creationflags=NO_WIN))
    return procs


def _serve(port, handler, host="127.0.0.1"):
    """线程里起 HTTP 服务；--windowed 无 stdout，异常落盘便于诊断。"""
    try:
        ThreadingHTTPServer((host, port), handler).serve_forever()
    except Exception:
        import traceback
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(os.path.join(LOG_DIR, "gui.err.log"), "a", encoding="utf-8") as f:
            f.write(f"\n[port {port}] " + traceback.format_exc())


def bots_path():
    """bots.json 放 exe 旁边（不是打包进去的 _internal），
    这样控制台里新增的 bot 能存下来，重新打包也不会被覆盖。"""
    bundled = os.path.join(console.HERE, "bots.json")
    if not getattr(sys, "frozen", False):
        return bundled
    ext = os.path.join(os.path.dirname(sys.executable), "bots.json")
    if not os.path.exists(ext):
        try:
            shutil.copy2(bundled, ext)
        except Exception:
            return bundled
    return ext


def start_servers():
    # 对外暴露：默认只本机(127.0.0.1)；设 CONSOLE_HOST=0.0.0.0 后手机/局域网可访问。
    # 远程/公网暴露时务必设 CONSOLE_TOKEN，否则任何人都能控制 bot。
    host = os.environ.get("CONSOLE_HOST", "127.0.0.1")
    token = os.environ.get("CONSOLE_TOKEN", "")
    console.READONLY = False
    console.MANAGE = True          # 桌面版允许在控制台里启动/停止 bot 进程
    # exe 版 HERE 在 _internal 里，按它推不出源码目录 → 显式告诉 console 真实路径与 node
    console.BOT_SRC = BOT_DIR
    console.BOT_NODE = NODE
    console.Handler.bots_path = bots_path()
    console.Handler.token = token
    brain.Handler.token = token
    console.load_bots(console.Handler.bots_path)
    threading.Thread(target=console.poll_loop, daemon=True).start()
    threading.Thread(target=_serve, args=(8900, console.Handler, host),
                     daemon=True).start()
    threading.Thread(target=_serve, args=(8902, brain.Handler, host),
                     daemon=True).start()


def wait_port(port, timeout=15):
    for _ in range(int(timeout * 10)):
        if port_open(port):
            return True
        time.sleep(0.1)
    return False


def main():
    # --windowed 打包后 sys.stdout/stderr 可能为 None，console/brain 里任何 print
    # 会 AttributeError 带崩请求，这里兜底重定向到日志文件。
    os.makedirs(LOG_DIR, exist_ok=True)
    # --windowed 打包后 sys.stdout/stderr 在 webview2 下是 NullWriter（不是 None），
    # 强制重定向到文件，否则 brain/console 的 print 全进黑洞，排障无日志。
    try:
        _log = open(os.path.join(LOG_DIR, "gui.out.log"), "a",
                    encoding="utf-8", buffering=1)
        sys.stdout = _log
        sys.stderr = _log
    except Exception:
        pass

    bots = []
    try:
        kill_forge()          # 打开：清残留 bot，保证「打开才运行」
        bots = start_bots()
        start_servers()
        wait_port(8900, 15)
        webview.create_window(
            "MC 多 bot 控制台", "http://127.0.0.1:8900/",
            width=1380, height=880, min_size=(1100, 700),
            background_color="#0b0e14",
        )
        webview.start(gui="edgechromium")   # 阻塞到窗口关闭
    finally:
        for p in bots:
            if p.poll() is None:
                p.terminate()   # Windows 上 = TerminateProcess，强制
        kill_forge()          # 兜底再清一次，不留孤儿


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(os.path.join(LOG_DIR, "gui.err.log"), "w", encoding="utf-8") as f:
            f.write(traceback.format_exc())
