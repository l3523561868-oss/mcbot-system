"""launcher.py — MC 多 bot 一键启动器（打包成单 exe）。

双击后：拉起协议 bot(8801) + 控制台(8900) + 大脑(8902)，自动开浏览器。
已监听端口的组件自动跳过，可反复双击不重复启动。

两种「大脑」：
  - API 接入（花钱）：控制台网页「AI 接入」面板填 DeepSeek key → brain.py 转发
  - 免费思考：在 WorkBuddy 会话里喊我，我连 8900 读状态/派动作/说话

打包：pyinstaller --onefile --console --name MC-Bot-Launcher launcher.py
"""
import os
import socket
import subprocess
import sys
import time
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PY = os.environ.get("PY_BIN") or sys.executable    # 可用 PY_BIN 指定绝对路径
NODE = os.environ.get("NODE_BIN") or "node"        # 可用 NODE_BIN 指定绝对路径
CONSOLE_DIR = os.path.join(ROOT, "src", "console")
BOT_DIR = os.path.join(ROOT, "src", "bot")
LOG_DIR = os.path.join(CONSOLE_DIR, "_launcher_log")

NO_WIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# 子进程要脱离父进程 console（DETACHED + 新进程组），否则启动器一退出会被
# CTRL_CLOSE_EVENT 连带杀。注意别加 CREATE_BREAKAWAY_FROM_JOB——onefile 的
# bootloader 的 job 不允许 breakaway，加了会 PermissionError（WinError 5）。
# 所以改用 --onedir 打包（无 bootloader 解压子进程/job 结构，孙进程能存活）。
DETACH = NO_WIN | getattr(subprocess, "DETACHED_PROCESS", 0) \
                | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)


def port_open(port):
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", port))
        s.close()
        return True
    except Exception:
        return False


def launch(name, args, cwd, env=None):
    os.makedirs(LOG_DIR, exist_ok=True)
    logf = open(os.path.join(LOG_DIR, name + ".log"), "ab")
    return subprocess.Popen(args, cwd=cwd, env=env, stdout=logf,
                            stderr=subprocess.STDOUT, creationflags=DETACH)


def main():
    if os.name == "nt":
        os.system("chcp 65001 >nul")            # 控制台切 UTF-8，避免中文乱码
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    os.makedirs(LOG_DIR, exist_ok=True)
    # 1) 协议 bot（口令同 启动_bot_one.bat）
    if port_open(8801):
        print("[跳过] 8801 已有 bot 在跑")
    else:
        env = dict(os.environ)
        env.update(BOT_PW="<BOT1_PASSWORD>", BOT_REG="0",
                   COMBAT_OFF="1", XP_LOW_LEVEL="0")
        launch("bot", [NODE, "forge-live.mjs", "mc.example.com", "25565",
                       "bot_one"], BOT_DIR, env)
        print("[启动] 协议 bot (8801)，进服约 60~100 秒")

    # 2) 控制台
    if port_open(8900):
        print("[跳过] 8900 控制台已在跑")
    else:
        launch("console", [PY, "console.py", "--port", "8900"], CONSOLE_DIR)
        print("[启动] 控制台 (8900)")

    # 3) 大脑
    if port_open(8902):
        print("[跳过] 8902 大脑已在跑")
    else:
        launch("brain", [PY, "brain.py", "--port", "8902"], CONSOLE_DIR)
        print("[启动] 大脑 (8902)")

    time.sleep(3)
    webbrowser.open("http://127.0.0.1:8900/")
    print("\n全部就绪：控制台 http://127.0.0.1:8900/")
    print("  API 接入(花钱)：控制台「AI 接入」面板填 key")
    print("  免费思考：WorkBuddy 会话里直接喊我")
    print("  日志：", LOG_DIR)
    try:
        input("\n按回车退出启动器（三件套继续后台运行）...")
    except EOFError:            # 无 stdin（管道/后台）时静默退出
        pass


if __name__ == "__main__":
    main()
