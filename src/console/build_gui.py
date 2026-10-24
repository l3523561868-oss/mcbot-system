"""build_gui.py — 安全打包 GUI（避免目录嵌套/套娃）。

用法：python build_gui.py
旧目录删不掉（exe 在跑）会直接报错，不会出现 MC-Bot-GUI/MC-Bot-GUI 嵌套。
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
DST = os.path.join(HERE, "MC-Bot-GUI")


def rmtree_checked(path):
    shutil.rmtree(path, ignore_errors=True)
    if os.path.exists(path):
        raise RuntimeError(
            f"删不掉 {path}\n"
            "→ 先把 MC-Bot-GUI.exe 关掉（任务管理器/关窗口）再打包")


def main():
    rmtree_checked(DST)
    shutil.rmtree(os.path.join(HERE, "build"), ignore_errors=True)
    shutil.rmtree(os.path.join(HERE, "dist"), ignore_errors=True)

    args = [sys.executable, "-m", "PyInstaller",
            "--onedir", "--windowed", "--name", "MC-Bot-GUI", "--noconfirm",
            "--icon", "icon.ico",
            "--collect-all", "webview",
            "--collect-all", "pythonnet",
            "--collect-all", "clr_loader",
            "--add-data", "index.html;.",
            "--add-data", "bots.json;.",
            "--add-data", "item_icons;item_icons",
            "gui.py"]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout[-3000:])
        print(r.stderr[-3000:])
        sys.exit(1)

    # 目标已确保不存在 → move 一定是重命名，不会嵌套
    shutil.move(os.path.join(HERE, "dist", "MC-Bot-GUI"), DST)
    shutil.rmtree(os.path.join(HERE, "build"), ignore_errors=True)
    shutil.rmtree(os.path.join(HERE, "dist"), ignore_errors=True)
    spec = os.path.join(HERE, "MC-Bot-GUI.spec")
    if os.path.exists(spec):
        os.remove(spec)

    print("打包完成:", os.path.join(DST, "MC-Bot-GUI.exe"))
    print("目录内容:", sorted(os.listdir(DST)))


if __name__ == "__main__":
    main()
