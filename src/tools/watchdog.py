"""bot 看门狗：探活失败就按标准姿势重启，连续失败 N 次才放弃。

补的是《交接文档》§7-P4 的缺口：`waitequip.py` 存在但没跑，bot 挂了不会自拉起。

用法（协议 bot）：
  python watchdog.py \
      --url http://127.0.0.1:8801/state --expect online \
      --cwd "D:/下载/亡者世界/你好，新蒸程V1.5.9/你好，新蒸程V1.5.9/Minecraft/server-bot" \
      --cmd 'node forge-live.mjs mc.example.com 25565 bot_one' \
      --kill-match forge-live.mjs --cooldown 120

测试不真重启：加 --dry-run。
只查一次就退出（给计划任务用）：加 --once。
"""

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 绕过系统代理


def log(msg, logfile=None):
    line = f"[{time.strftime('%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    if logfile:
        try:
            with open(logfile, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass


def healthy(url, expect, timeout=6.0):
    """返回 (ok, detail)。连不上 / 非 200 / 缺关键字 都算不健康。"""
    try:
        with _OPENER.open(url, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, f"{type(e).__name__}"
    if expect:
        if expect not in body:
            # 顺便把关键字段读出来，便于判断"活着但没进服"
            try:
                d = json.loads(body)
                brief = f"online={d.get('online')} authed={d.get('authed')} pos={bool(d.get('position'))}"
            except Exception:
                brief = body[:120]
            return False, f"缺少 {expect!r}（{brief}）"
    return True, "ok"


def find_pids(match):
    """按命令行子串找进程 PID（Windows / PowerShell）。

    ★ 必须排除自己和父进程：`--kill-match xxx` 这个参数本身就在看门狗自己的命令行里，
    不排除的话会把看门狗自己杀掉（实测踩过，表现为"重启日志打了一半进程就没了"）。
    """
    if not match:
        return []
    ps = (
        "Get-CimInstance Win32_Process | "
        f"Where-Object {{ $_.CommandLine -like '*{match}*' }} | "
        "Select-Object -ExpandProperty ProcessId"
    )
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                             capture_output=True, text=True, timeout=20)
        pids = [int(x) for x in out.stdout.split() if x.strip().isdigit()]
    except Exception:
        return []
    me = {os.getpid(), os.getppid()}
    return [p for p in pids if p not in me]


def kill(pids, logfile=None):
    for pid in pids:
        try:
            subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                           capture_output=True, timeout=15)
            log(f"  已杀进程 {pid}", logfile)
        except Exception as e:
            log(f"  杀 {pid} 失败：{e}", logfile)


def start(cmd, cwd, logpath, logfile=None):
    argv = shlex.split(cmd, posix=False)
    argv = [a.strip('"') for a in argv]
    out = open(logpath, "ab") if logpath else subprocess.DEVNULL
    p = subprocess.Popen(argv, cwd=cwd or None, stdout=out, stderr=subprocess.STDOUT,
                         env=os.environ.copy())
    log(f"  已拉起 pid={p.pid}：{cmd}", logfile)
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8801/state")
    ap.add_argument("--expect", default="online", help="响应里必须出现的关键字（空=只要求 200）")
    ap.add_argument("--interval", type=float, default=10.0)
    ap.add_argument("--fail-threshold", type=int, default=3, help="连续失败几次才重启")
    ap.add_argument("--cooldown", type=float, default=120.0,
                    help="重启后的静默期（协议 bot 进服要 60~100s，判断太早会误杀）")
    ap.add_argument("--max-restarts", type=int, default=5, help="总共最多重启几次，用完停下")
    ap.add_argument("--cmd", default="", help="重启命令（空=只探活不重启）")
    ap.add_argument("--cwd", default="")
    ap.add_argument("--kill-match", default="", help="重启前按命令行子串清理旧进程")
    ap.add_argument("--bot-log", default="", help="被守护进程的 stdout 追加到这里")
    ap.add_argument("--log", default="", help="看门狗自己的日志文件")
    ap.add_argument("--dry-run", action="store_true", help="只报不重启")
    ap.add_argument("--once", action="store_true", help="检查一次就退出")
    a = ap.parse_args()

    log(f"看门狗启动 url={a.url} interval={a.interval}s "
        f"阈值={a.fail_threshold} 冷却={a.cooldown}s 上限={a.max_restarts} "
        f"{'DRY-RUN' if a.dry_run else ''}", a.log)
    if a.kill_match and any(a.kill_match in x for x in sys.argv):
        log(f"提示：--kill-match {a.kill_match!r} 也出现在看门狗自己的命令行里，"
            f"已自动排除自身与父进程", a.log)

    fails = 0
    restarts = 0
    muted_until = 0.0

    while True:
        if time.time() < muted_until:
            time.sleep(min(a.interval, max(1.0, muted_until - time.time())))
            continue

        ok, detail = healthy(a.url, a.expect)
        if ok:
            if fails:
                log(f"恢复：{a.url} 正常", a.log)
            fails = 0
        else:
            fails += 1
            log(f"探活失败 {fails}/{a.fail_threshold}：{detail}", a.log)

        if fails >= a.fail_threshold:
            if not a.cmd:
                log("  未配置 --cmd，只报告不重启", a.log)
            elif restarts >= a.max_restarts:
                log(f"  已达重启上限 {a.max_restarts} 次，停止重试（需人工介入）", a.log)
                if a.once:
                    sys.exit(2)
            elif a.dry_run:
                log("  [DRY-RUN] 本应重启（清理旧进程 + 重新拉起）", a.log)
            else:
                log(f"  第 {restarts + 1} 次重启", a.log)
                if a.kill_match:
                    kill(find_pids(a.kill_match), a.log)
                    time.sleep(2)
                start(a.cmd, a.cwd, a.bot_log, a.log)
                restarts += 1
                # 进服要 60~100s，静默期内不判定，避免把正在启动的进程当死的再杀一次
                muted_until = time.time() + a.cooldown
            fails = 0

        if a.once:
            sys.exit(0 if ok else 1)
        time.sleep(a.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已停止")
