"""MC 多 bot 控制台 —— 单文件后端（Python 标准库，零第三方依赖）。

启动：python console.py            # 默认 127.0.0.1:8900
      python console.py --port 8900 --bots bots.json

作用：
  1) 统一接入 协议bot(8801) / 已装模组的客户端bot(8780)，适配差异由 adapters.py 收敛
  2) 下发任务并回读 state 验证（不看返回值，只看状态变化）
  3) bot 之间用「游戏内文本 + 白名单动词」互相指挥，控制台做语法解析与路由
  4) 跑互测场景，出结果
"""

import argparse
import ctypes
import json
import os
import re
import shutil
import subprocess
import threading
import time


def system_ram():
    """Windows 系统内存：返回 (可用 GB, 内存负载%)；失败返回 None。"""
    try:
        class MS(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_uint), ("dwMemoryLoad", ctypes.c_uint),
                        ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong),
                        ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong),
                        ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        st = MS()
        st.dwLength = ctypes.sizeof(MS)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            return round(st.ullAvailPhys / 1073741824, 1), st.dwMemoryLoad
    except Exception:
        pass
    return None
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import adapters
import brain
import providers
import scenarios

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, "item_icons")
ICON_CDN = ("https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/"
            "master/data/1.21.1/items/{name}.png")
LOCK = threading.RLock()
BOTS = []            # 配置：id/name/kind/base/token/...
LIVE = {}            # id -> 最近一次 state 快照 + 元信息
LOG = []             # 操作日志（最近 300 条）
LANG = []            # 语言流（bot 之间被解析出的指令，最近 200 条）
CHAT = []            # 全服聊天流（聚合所有来源，最近 400 条）
SEEN = set()         # 已处理的聊天去重（chat 流 + 语言解析共用）
LEASES = {}          # 目标锁：target_key -> {bot, ts}
INBOX = {}           # 反向接入：bot_id -> [待执行指令]（NAT 后的 bot 主动来领）
VERBS = ("move_to", "dig", "work", "follow", "say", "stop", "eat", "chat_cmd",
         "equip", "move_slot", "use_item", "waystone", "warp_to", "list_waystones")
# 只读模式下唯一放行的动作集：GET /state 由轮询负责，这里管"能下发的"
# 交流类：说话不会伤到 bot，只读模式下也放行（但 chat_cmd 仍禁，它能跑任意指令）
ALLOW_IN_READONLY = ("say",)
RO_VERBS = ("state",) + adapters.RAW_READONLY + ALLOW_IN_READONLY
READONLY = False     # --readonly 打开：任何非 RO_VERBS 的动作直接拒绝
MANAGE = False       # --manage 打开：允许在控制台里启动/停止 bot 进程（仅 PC 端，手机不开）

# 进程启停用到的路径与服务器参数
BOT_SRC = os.environ.get("MC_BOT_DIR") or os.path.join(
    os.path.dirname(HERE), "bot")          # 仓库布局：<repo>/src/bot
BOT_NODE = os.environ.get("MC_BOT_NODE") or "node"
LOG_DIR = os.path.join(HERE, "logs")
# --manage 拉起 bot 时需要；用环境变量指定，避免把具体服务器写进代码
SERVER_HOST = os.environ.get("MC_SERVER_HOST", "mc.example.com")
SERVER_PORT = int(os.environ.get("MC_SERVER_PORT", "25565"))
_PROC_CACHE = {"ts": 0.0, "map": {}}
# 打包成 --windowed 的 exe 后，程序自己没有控制台：此时调用 netstat/taskkill/node
# 会被系统各开一个黑窗口（就是"一直弹命令行"）。全部加 CREATE_NO_WINDOW 消掉。
_NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


AGENT_SYS = """你是 Minecraft 服务器里的 AI 玩家「{name}」。玩家给你一句任务或问题，你要：
1. reply：一句简短中文回复（不超过 40 字，口语化，像真人）
2. actions：需要执行的动作数组，没有就给空数组

可用动作（verb + args）：
- move_to: {{"x": 数字, "z": 数字}}                     走到坐标
- dig: {{}}                                             挖准星方块
- work: {{"mode": "log"|"stone"|"patrol"|"stop"}}        砍树/挖石/巡逻/停工
- follow: {{"player": "名字"}}                           跟随玩家
- say: {{"text": "内容"}}                                在公屏说
- stop: {{}}                                            停止当前动作
- eat: {{}}                                             进食
- equip: {{"name": "物品名"}}                            切换手持
- waystone: {{"name": "石碑名"}}                        走到并打开石碑（省略 name 用最近的传送石碑）
- warp_to: {{"name": "石碑名"}}                          通过传送石碑传送（**黑色共享石碑 sharestone 禁止传送，会失败**）
- list_waystones: {{}}                                  列出已知传送石碑

只输出一行 JSON（必须以左花括号开头，不要思考过程、不要解释、不要 markdown 代码块）：
{{"reply": "...", "actions": [{{"verb": "...", "args": {{}}}}]}}"""

CMD_VERBS = ("move_to", "dig", "work", "follow", "say", "stop", "eat", "equip",
             "waystone", "warp_to", "list_waystones")


def _rule_parse(text):
    """无 LLM 时的关键词解析兜底。返回 (reply, actions)。"""
    tl = text.lower()
    reply, acts = "", []

    if re.search(r"(停下|停止|别动|stop)", tl):
        acts.append({"verb": "stop", "args": {}})
        reply = "好，停下了。"
    m = re.search(r"(?:走到|去|移动到|move_to)\s*(-?\d+(?:\.\d+)?)[,，\s]+(-?\d+(?:\.\d+)?)", text)
    if m:
        acts.append({"verb": "move_to", "args": {"x": float(m.group(1)),
                                                 "z": float(m.group(2))}})
    if re.search(r"(木头|砍树|伐木|原木|\blog\b)", tl):
        acts.append({"verb": "work", "args": {"mode": "log"}})
    if re.search(r"(石头|挖石|采矿|stone)", tl):
        acts.append({"verb": "work", "args": {"mode": "stone"}})
    if re.search(r"(巡逻|patrol)", tl):
        acts.append({"verb": "work", "args": {"mode": "patrol"}})
    if re.search(r"(吃|进食|\beat\b)", tl):
        acts.append({"verb": "eat", "args": {}})
    m = re.search(r"(?:跟着|跟随|follow)\s*([A-Za-z0-9_]+)", text)
    if m:
        acts.append({"verb": "follow", "args": {"player": m.group(1)}})
    m = re.search(r"(?:说|喊|发言)\s*[：:]?\s*(.+)", text)
    if m and len(m.group(1).strip()) <= 90:
        acts.append({"verb": "say", "args": {"text": m.group(1).strip()}})

    if not reply and not acts:
        return ("我在听。可以让我：走到坐标、砍树、挖石头、巡逻、跟随某人、进食、停下。", [])
    return (reply or "收到，这就去办。", acts)


def _think(bot, text):
    """思考：优先 LLM（brain 8902 的提供商），失败退回规则解析。"""
    sys_prompt = AGENT_SYS.format(name=bot.get("name") or bot.get("id"))
    try:
        txt = brain.answer([{"role": "system", "content": sys_prompt},
                            {"role": "user", "content": text}])
    except Exception as e:
        print("[ai_cmd] brain 调用失败:", e, flush=True)
        txt = None
    if txt:
        m = re.search(r"\{.*\}", txt, re.S)
        if m:
            try:
                d = json.loads(m.group(0))
                acts = [{"verb": a.get("verb"), "args": a.get("args") or {}}
                        for a in (d.get("actions") or [])
                        if a.get("verb") in CMD_VERBS]
                return (d.get("reply") or "").strip(), acts
            except Exception:
                pass
        # LLM 回了自然语言但没按格式给 JSON：保留它的回复，动作交给规则补
        # JSON 可能被截断，先尽量从残缺 JSON 里抠出 reply
        mr = re.search(r'"reply"\s*:\s*"((?:[^"\\]|\\.)*)', txt)
        r2, a2 = _rule_parse(text)
        if mr:
            try:
                reply = json.loads('"' + mr.group(1) + '"')
            except Exception:
                reply = mr.group(1)
            return reply.strip()[:200], a2
        good = txt.strip()
        if good and len(good) <= 200:
            return good, a2
        return r2, a2
    return _rule_parse(text)


ICON_MISS = set()        # 拉过一次失败的图标名：记住，别每次刷新都重等超时
ICON_DEAD_UNTIL = 0.0    # 网络不可达时整体熔断（手机上没有 GitHub 直连，靠它保证 404 秒回）


def _icon_bytes(name):
    """物品图标：本地缓存优先，缺失时在线拉一次（原版物品；模组物品拉不到→404 前端降级）。"""
    global ICON_DEAD_UNTIL
    base = name.split(":")[-1]
    if base.lower().endswith(".png"):
        base = base[:-4]
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", base or "unknown")
    path = os.path.join(ICON_DIR, safe + ".png")
    if os.path.exists(path):
        try:
            with open(path, "rb") as f:
                return f.read()
        except Exception:
            return None
    # 失败过的名字 / 整体熔断期内：直接 404，前端降级成色块。
    # 没有这道闸，模组物品图标会让首屏卡十几秒（每个都等一次 DNS+TCP 超时）。
    if safe in ICON_MISS or time.time() < ICON_DEAD_UNTIL:
        return None
    try:
        import urllib.request
        with urllib.request.urlopen(ICON_CDN.format(name=safe), timeout=1.5) as r:
            b = r.read()
        if b:
            os.makedirs(ICON_DIR, exist_ok=True)
            with open(path, "wb") as f:
                f.write(b)
        return b or None
    except Exception:
        ICON_MISS.add(safe)
        ICON_DEAD_UNTIL = time.time() + 60
        return None


def log(kind, msg):
    with LOCK:
        LOG.append({"ts": time.strftime("%H:%M:%S"), "kind": kind, "msg": msg})
        del LOG[:-300]
    print(f"[{kind}] {msg}", flush=True)


def load_bots(path):
    global BOTS
    if not os.path.exists(path):
        BOTS = []
        return
    with open(path, encoding="utf-8") as f:
        BOTS = json.load(f)
    for b in BOTS:
        LIVE.setdefault(b["id"], {})


def save_bots(path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(BOTS, f, ensure_ascii=False, indent=2)


# ---- bot 进程启停（仅 Windows/PC；手机端不开 --manage） ----
def _pid_on_port(port):
    """找正在监听该端口(PID)；没进程返回 None。手机端不走这条路。"""
    if not port or os.name != "nt":
        return None
    try:
        # 中文 Windows 的 netstat 输出是 GBK，用 text=True 会因 UTF-8 解码失败而拿到 None
        r = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True,
                           timeout=10, creationflags=_NOWIN)
        out = (r.stdout or b"").decode("gbk", "replace")
    except Exception:
        return None
    suffix = ":%d" % port
    for line in out.splitlines():
        p = line.split()
        if len(p) >= 5 and p[3] == "LISTENING" and p[1].endswith(suffix):
            try:
                return int(p[4])
            except ValueError:
                return None
    return None


def proc_map():
    """id -> pid（None=没在跑）。3 秒缓存，避免每个 /api/state 都跑 netstat。"""
    now = time.time()
    if now - _PROC_CACHE["ts"] < 3:
        return _PROC_CACHE["map"]
    m = {}
    for b in BOTS:
        m[b["id"]] = _pid_on_port(int(b.get("bridge_port") or 0))
    _PROC_CACHE["ts"] = now
    _PROC_CACHE["map"] = m
    return m


def start_bot(bot):
    if os.name != "nt":
        return False, {"error": "只有 PC(Windows) 端支持启停进程"}
    port = int(bot.get("bridge_port") or 0)
    if not port:
        return False, {"error": "这只 bot 没配 bridge_port"}
    pid = _pid_on_port(port)
    if pid:
        return False, {"error": f"已在运行（PID {pid}，端口 {port}）"}
    acct = (bot.get("account") or "").strip()
    pw = (bot.get("password") or "").strip()
    # 常见填错：把整条命令 "/login 123456" 当成口令填进来 → 会发成 "/login /login 123456"
    if pw.lower().startswith("/login"):
        pw = pw[6:].strip()
    pw = pw.strip("\"'")
    if not acct or not pw:
        return False, {"error": "bots.json 缺 account / password 字段"}
    # 打包成 exe 后 HERE 在 _internal 里，按它推出来的源码目录根本不存在 →
    # 以前直接 Popen 会抛 [WinError 267] 目录名称无效。这里先判存在，并给出可读原因。
    if not os.path.isdir(BOT_SRC):
        return False, {"error": f"找不到 bot 源码目录 {BOT_SRC}（exe 版需在 gui.py 里指定 MC_BOT_DIR）"}
    node = BOT_NODE if os.path.exists(BOT_NODE) else (shutil.which("node") or BOT_NODE)
    if not (os.path.exists(node) or shutil.which(node)):
        return False, {"error": f"找不到 node 可执行文件（当前：{node}）"}
    env = os.environ.copy()
    env.update({"BOT_PW": pw, "BOT_REG": "0", "COMBAT_OFF": "1",
                "XP_LOW_LEVEL": "0", "BRIDGE_PORT": str(port),
                "CHAT_MONITOR_OFF": "1", "WAYSTONE_EYE_OFF": "1"})
    os.makedirs(LOG_DIR, exist_ok=True)
    logf = open(os.path.join(LOG_DIR, f"bot-{port}.out.log"), "a", encoding="utf-8")
    flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        subprocess.Popen([node, "forge-live.mjs",
                          SERVER_HOST, str(SERVER_PORT), acct],
                         cwd=BOT_SRC, env=env, stdout=logf,
                         stderr=subprocess.STDOUT, creationflags=flags)
    except Exception as e:
        logf.close()
        return False, {"error": str(e)}
    logf.close()
    _PROC_CACHE["ts"] = 0
    log("PROC", f"启动 {bot.get('name') or bot['id']}（{acct}，桥 {port}）")
    return True, {"started": True, "port": port}


def stop_bot(bot):
    port = int(bot.get("bridge_port") or 0)
    pid = _pid_on_port(port)
    if not pid:
        return False, {"error": f"端口 {port} 上没有进程在跑"}
    try:
        subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                       capture_output=True, timeout=10, creationflags=_NOWIN)
    except Exception as e:
        return False, {"error": f"停止失败：{e}"}
    time.sleep(1.0)
    still = _pid_on_port(port)
    _PROC_CACHE["ts"] = 0
    if still:
        return False, {"error": f"进程 {pid} 没停掉，仍占着 {port}"}
    log("PROC", f"停止 {bot.get('name') or bot['id']}（PID {pid}）")
    return True, {"stopped": True, "pid": pid}


def get_bot(bot_id_or_name):
    key = (bot_id_or_name or "").strip().lower()
    for b in BOTS:
        if b["id"].lower() == key or b.get("name", "").lower() == key:
            return b
    return None


def poll_loop(interval=2.0):
    """周期拉取每个 bot 的 state，并解析它们之间的对话。"""
    while True:
        for b in list(BOTS):
            if not b.get("enabled", True):
                continue
            if b.get("kind") not in adapters.ADAPTERS:   # reporter 型：等它自己上报，不主动拉
                continue
            ok, data = adapters.make(b).state()
            with LOCK:
                snap = LIVE.setdefault(b["id"], {})
                snap["online"] = bool(ok and data.get("online"))
                snap["ts"] = time.strftime("%H:%M:%S")
                snap["error"] = None if ok else data.get("error")
                if ok:
                    for k in ("position", "health", "food", "mode", "held", "name",
                              "authed", "gamemode", "experience", "username", "reconnects",
                              "ping", "mem_mb", "uptime_s"):
                        if k in data:
                            snap[k] = data[k]
            if ok:
                ingest_chat(b, data.get("chat"))
        time.sleep(interval)


def ingest_chat(bot, entries):
    """把某个来源的聊天并入全服聊天流，并尝试解析 bot 间指令。

    bot 只需有 id/name 两个字段；外部上报（观察者/第三方 reporter）也走同一个入口，
    这样「聊天监测」与「语言指挥」对所有来源行为一致。
    条目格式：[{ts, who, text}]，缺失字段自动补。
    """
    for m in entries or []:
        text = (m.get("text") or "").strip()
        # 真 bot 用 at/seq；mock 与外部上报用 ts。三者都认。
        ts = m.get("ts") or m.get("at") or time.strftime("%H:%M:%S")
        # ★ 去重键不能含 bot id：同一条公屏消息每个 bot 都会收到一次，
        #   按 (时间 + 发言人 + 文本) 合并；只有没时间戳时才退回 per-bot seq。
        key = (ts, m.get("who") or "", text)
        if not (m.get("ts") or m.get("at")) and m.get("seq") is not None:
            key = (bot["id"], "seq", m["seq"])
        with LOCK:
            if key in SEEN:
                continue
            SEEN.add(key)
            CHAT.append({"ts": ts, "src": bot.get("name") or bot["id"],
                         "who": m.get("who") or "", "text": text})
            del CHAT[:-400]
        # 真公屏形如 "[world] <Steve>: 你好" —— 解出发言人，别让所有人都显示成 bot 自己
        mo_who = re.match(r"^\[[^\]]+\]\s*<([^>]+)>[:：]?\s*(.*)$", text)
        if mo_who:
            speaker, body = mo_who.group(1), mo_who.group(2)
            with LOCK:
                for item in reversed(CHAT):
                    if item["text"] == text:
                        item["who"] = speaker
                        item["text"] = body
                        break
        # 协议 bot 公屏不可用，指令默认以 /me 形式发出，解析前先剥掉
        line = re.sub(r"^/me\s+", "", text)
        mo = re.match(r"@(\S+)\s+([a-z_]+)\s*(.*)$", line)
        if not mo:
            continue
        target, verb, rest = mo.group(1), mo.group(2), mo.group(3).strip()
        if verb not in VERBS:
            continue
        tbot = get_bot(target)
        entry = {"ts": time.strftime("%H:%M:%S"), "from": bot.get("name") or bot["id"],
                 "to": target, "verb": verb, "args": rest, "result": ""}
        if not tbot:
            entry["result"] = "目标不存在"
        else:
            args = _parse_args(verb, rest)
            ok, res = dispatch(tbot, verb, args, source=entry["from"])
            entry["result"] = "ok" if ok else ("失败: " + str(res.get("error") or res))
            adapters.make(tbot).say(f"[{entry['from']}] {verb} " + ("ok" if ok else "fail"))
        with LOCK:
            LANG.append(entry)
            del LANG[:-200]
        log("LANG", f"{entry['from']} → {target} {verb} {rest} :: {entry['result']}")


def _parse_args(verb, rest):
    if verb == "move_to":
        nums = re.findall(r"-?\d+(?:\.\d+)?", rest)
        if len(nums) >= 2:
            return {"x": float(nums[0]), "z": float(nums[1])}
        return {}
    if verb == "follow":
        return {"player": rest.split()[0]} if rest else {}
    if verb == "equip":
        m = re.match(r"^\s*(\d+)\s*$", rest)
        if m:
            return {"slot": int(m.group(1))}
        return {"name": rest} if rest else {}
    if verb in ("waystone", "warp_to"):
        return {"name": rest} if rest else {}
    if verb == "list_waystones":
        return {}
    if verb == "work":
        return {"mode": rest.split()[0] if rest else "stop"}
    if verb == "dig":
        return {"block": rest.split()[0]} if rest else {}
    if verb in ("say", "chat_cmd"):
        return {"text": rest}
    return {}


def dispatch(bot, verb, args, source=None):
    """下发一个统一语义动作，带目标锁，返回 (ok, result)。"""
    if READONLY and verb not in RO_VERBS:
        log("BLOCK", f"只读模式拒绝 {bot.get('name')} {verb} {args}")
        return False, {"error": f"只读模式：{verb} 不在白名单内"}
    # 桥已经不响应的 bot 直接快速失败：否则每个动作都干等满 8s，
    # 浏览器同源只有 6 条连接，几下就把 /api/state 也堵死（表现就是「发送中」「连接失败」）。
    if verb != "state" and (LIVE.get(bot["id"]) or {}).get("online") is False:
        return False, {"error": "bot 离线（桥无响应），已跳过，等它重连"}
    lease_key = None
    if verb in ("move_to", "dig", "work"):
        lease_key = f"{verb}:{args.get('x','')},{args.get('z','')}:{args.get('mode','')}"
        now = time.time()
        with LOCK:
            for k, v in list(LEASES.items()):
                if now - v["ts"] > 60:
                    LEASES.pop(k, None)
            cur = LEASES.get(lease_key)
            if cur and cur["bot"] != bot["id"]:
                return False, {"error": f"目标被 {cur['bot']} 占用（{int(now-cur['ts'])}s）"}
            LEASES[lease_key] = {"bot": bot["id"], "ts": now}
    if bot.get("kind") not in adapters.ADAPTERS:
        # 反向接入型：控制台不主动连它，指令进队列等它来领
        cmd = {"id": f"c{int(time.time()*1000)}", "verb": verb, "args": args,
               "ts": time.strftime("%H:%M:%S"), "source": source}
        with LOCK:
            INBOX.setdefault(bot["id"], []).append(cmd)
        log("QUEUE", f"{bot.get('name')} {verb} {args} 入队（等 reporter 领取）")
        return True, {"queued": True, "id": cmd["id"]}
    ok, res = adapters.make(bot).act(verb, **args)
    who = f"{source}→" if source else ""
    if verb not in ("map_slice", "players", "inv_list"):   # 后台轮询动作不写日志（防刷屏）
        log("ACT", f"{who}{bot.get('name')} {verb} {args} -> {'ok' if ok else res}")
    if ok and verb not in ("map_slice", "players", "inv_list"):
        with LOCK:
            LIVE.setdefault(bot["id"], {})["last_action"] = f"{verb} {json.dumps(args, ensure_ascii=False)}"
    return ok, res

# ---------------- HTTP ----------------

class Handler(BaseHTTPRequestHandler):
    bots_path = os.path.join(HERE, "bots.json")
    token = ""          # 非空则所有 /api/* 都要带 X-Console-Token 或 ?t=
    # 手机上一个页面要发 200+ 个请求（图标/状态/地图），HTTP/1.0 每请求都重开 TCP → 又慢又容易断。
    protocol_version = "HTTP/1.1"     # 复用连接（所有响应都有 Content-Length，安全）
    disable_nagle_algorithm = True    # 小 JSON 别等 Nagle 合并，手机端手感差别明显

    def log_message(self, *a):
        pass

    def log_request(self, code="-", size="-"):
        # 记每个请求（图标除外，太吵）。手机浏览器"白屏/黑屏"时，靠它看出卡在哪个请求上。
        try:
            p = urlparse(self.path).path
            if p.startswith("/icons/"):
                return
            print(f"[req] {self.client_address[0]} {self.command} {p} -> {code} {size}", flush=True)
        except Exception:
            pass

    def handle_one_request(self):
        # 浏览器刷新/关页/翻译插件会中途断开 → 原来每次都甩一大段 BrokenPipe traceback，
        # 把 console.log 刷满，真正的错误反而看不见。这里静默收掉。
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _authed(self):
        if not self.token:
            return True
        # 本机（回环）访问一律放行：token 是防公网隧道的，不是防自己。
        # 否则每次本地调试都要带 ?t=，反而逼人去关掉 token。
        if self.client_address and self.client_address[0] in ("127.0.0.1", "::1"):
            return True
        if self.headers.get("X-Console-Token") == self.token:
            return True
        return parse_qs(urlparse(self.path).query).get("t", [""])[0] == self.token

    def _send(self, obj, code=200, ctype="application/json; charset=utf-8"):
        body = obj if isinstance(obj, bytes) else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if "text/html" in ctype:
            # 页面改版频繁，手机浏览器一旦缓存旧 index.html 就一直用旧版（黑屏/报错现象会赖着不走）
            self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    AI_CFG_PATH = os.path.join(os.path.dirname(os.path.dirname(HERE)),
                               "proto_bot_local", "server-bot", "ai_config.json")

    def do_GET(self):
        # 走代理时请求行是绝对 URI（GET http://host/api/state），urlparse 两种形式都能吃
        p = urlparse(self.path).path.rstrip("/") or "/"
        if p in ("/", "/index.html"):
            fp = os.path.join(HERE, "index.html")
            with open(fp, "rb") as f:
                return self._send(f.read(), ctype="text/html; charset=utf-8")
        if p.startswith("/icons/"):
            b = _icon_bytes(p[len("/icons/"):])
            if b:
                return self._send(b, ctype="image/png")
            return self._send({"error": "no icon"}, 404)
        if p.startswith("/api/") and not self._authed():
            return self._send({"error": "unauthorized"}, 401)
        if p == "/api/ai":
            try:
                with open(self.AI_CFG_PATH, encoding="utf-8") as f:
                    cfg = json.load(f)
            except Exception:
                cfg = {}
            return self._send({"ok": True, "ai": cfg})
        if p == "/api/providers":
            ps, dft = providers.list_providers()
            return self._send({"ok": True, "providers": ps, "default": dft})
        if p == "/api/state":
            pm = proc_map() if MANAGE else {}
            with LOCK:
                bots = [{**b, **LIVE.get(b["id"], {}),
                         **({"proc": pm.get(b["id"])} if MANAGE else {})} for b in BOTS]
                return self._send({"ts": time.strftime("%H:%M:%S"), "bots": bots,
                                   "log": LOG[-80:], "lang": LANG[-60:],
                                   "chat": CHAT[-120:],
                                   "leases": LEASES, "verbs": VERBS,
                                   "manage": MANAGE,
                                   "readonly": READONLY, "ro_verbs": list(RO_VERBS),
                                   "sys": (lambda r: {"ram_avail_gb": r[0], "ram_load": r[1]} if r else None)(system_ram())})

        if p == "/api/inbox":
            bid = parse_qs(urlparse(self.path).query).get("bot", [""])[0]
            with LOCK:
                cmds = INBOX.pop(bid, [])
            return self._send({"cmds": cmds})
        if p == "/api/scenarios":
            return self._send({"scenarios": scenarios.catalog()})
        return self._send({"error": "not found"}, 404)

    def do_POST(self):
        p = urlparse(self.path).path.rstrip("/")
        if p.startswith("/api/") and not self._authed():
            return self._send({"ok": False, "error": "unauthorized"}, 401)
        try:
            body = self._body()
        except Exception:
            return self._send({"ok": False, "error": "bad json"}, 400)

        if p == "/api/act":
            bot = get_bot(body.get("bot"))
            if not bot:
                return self._send({"ok": False, "error": "bot 不存在"})
            ok, res = dispatch(bot, body.get("verb"), body.get("args") or {})
            return self._send({"ok": ok, "result": res})

        if p == "/api/say":
            bot = get_bot(body.get("bot"))
            if not bot:
                return self._send({"ok": False, "error": "bot 不存在"})
            mode = body.get("mode") or None          # "say"=公屏 | "me"=/me
            ok, res = adapters.make(bot).act("say", text=body.get("text", ""),
                                            **({"mode": mode} if mode else {}))
            tag = "公屏" if mode != "me" else "/me"
            log("SAY", f"[{tag}] {bot.get('name')}: {body.get('text')} -> {'ok' if ok else res}")
            return self._send({"ok": ok, "result": res})

        if p == "/api/bots":
            b = body.get("bot") or {}
            if not b.get("id") or not b.get("kind") or not b.get("base"):
                return self._send({"ok": False, "error": "id/kind/base 必填"})
            with LOCK:
                for i, old in enumerate(BOTS):
                    if old["id"] == b["id"]:
                        BOTS[i] = {**old, **b}
                        break
                else:
                    BOTS.append(b)
                save_bots(self.bots_path)
            log("CFG", f"保存 bot {b['id']}")
            return self._send({"ok": True})

        if p == "/api/bots/remove":
            with LOCK:
                BOTS[:] = [x for x in BOTS if x["id"] != body.get("id")]
                LIVE.pop(body.get("id"), None)
                save_bots(self.bots_path)
            return self._send({"ok": True})

        if p in ("/api/bots/start", "/api/bots/stop"):
            if not MANAGE:
                return self._send({"ok": False, "error": "本机未开启 --manage（手机端不支持启停）"}, 403)
            bot = get_bot(body.get("id"))
            if not bot:
                return self._send({"ok": False, "error": "bot 不存在"})
            ok, res = (start_bot if p.endswith("start") else stop_bot)(bot)
            return self._send({"ok": ok, "result": res})

        if p == "/api/report":
            # 反向接入上报：{bot:{id,name,kind}, state:{...}, chat:[{ts,who,text}]}
            rb = body.get("bot") or {}
            if not rb.get("id"):
                return self._send({"ok": False, "error": "bot.id 必填"})
            with LOCK:
                for i, old in enumerate(BOTS):
                    if old["id"] == rb["id"]:
                        BOTS[i] = {**old, **rb, "kind": "reporter",
                                   "local_kind": rb.get("kind") or old.get("local_kind") or "protocol"}
                        break
                else:
                    BOTS.append({"enabled": True, **rb, "kind": "reporter",
                                 "local_kind": rb.get("kind") or "protocol"})
                st = body.get("state") or {}
                snap = LIVE.setdefault(rb["id"], {})
                snap.update({k: st[k] for k in ("position", "health", "food", "mode", "held") if k in st})
                snap["online"] = bool(st.get("online", True))
                snap["ts"] = time.strftime("%H:%M:%S")
                snap["error"] = None
            ingest_chat({"id": rb["id"], "name": rb.get("name") or rb["id"]}, body.get("chat"))
            return self._send({"ok": True})

        if p == "/api/result":
            log("RESULT", f"{body.get('bot')} 指令 {body.get('id')} -> "
                          f"{'ok' if body.get('ok') else 'fail'} {str(body.get('result'))[:120]}")
            return self._send({"ok": True})

        if p == "/api/ai":
            ai = body.get("ai") or {}
            if not ai.get("url"):
                return self._send({"ok": False, "error": "url 必填"})
            ai.setdefault("enabled", True)
            try:
                with open(self.AI_CFG_PATH, "w", encoding="utf-8") as f:
                    json.dump(ai, f, ensure_ascii=False, indent=2)
                log("AI", f"AI 配置已下发：{ai.get('url')} model={ai.get('model')} "
                          f"enabled={ai.get('enabled')}（bot 5 秒内自动读取）")
                return self._send({"ok": True})
            except Exception as e:
                return self._send({"ok": False, "error": str(e)})

        if p == "/api/ai_cmd":
            bot = next((b for b in BOTS if b["id"] == body.get("bot")), None)
            if not bot:
                return self._send({"ok": False, "error": "bot 不存在"})
            text = (body.get("text") or "").strip()
            if not text:
                return self._send({"ok": False, "error": "内容为空"})
            reply, acts = _think(bot, text)
            results = []
            for a in acts:
                try:
                    ok, res = adapters.make(bot).act(a["verb"], **(a.get("args") or {}))
                except Exception as e:
                    ok, res = False, str(e)
                # 业务层可能嵌套 ok=false（如 sharestone_blocked），不能只看 HTTP 成功
                if ok and isinstance(res, dict) and res.get("ok") is False:
                    ok = False
                results.append({"verb": a["verb"], "ok": bool(ok),
                                "result": None if ok else res})
                log("AI", f"{bot.get('name')} {a['verb']} -> {'ok' if ok else res}")
            if reply:
                try:
                    adapters.make(bot).act("say", text=reply[:90])
                    log("AI", f"{bot.get('name')} 回复：{reply[:60]}")
                except Exception:
                    pass
            return self._send({"ok": True, "reply": reply,
                               "actions": acts, "results": results})

        if p == "/api/providers":
            ok, err = providers.upsert(body.get("provider") or {})
            if not ok:
                return self._send({"ok": False, "error": err})
            log("CFG", f"保存提供商 {body.get('provider', {}).get('id')}")
            return self._send({"ok": True})

        if p == "/api/providers/remove":
            providers.remove(body.get("id"))
            log("CFG", f"删除提供商 {body.get('id')}")
            return self._send({"ok": True})

        if p == "/api/providers/default":
            ok, err = providers.set_default(body.get("id"))
            if not ok:
                return self._send({"ok": False, "error": err})
            return self._send({"ok": True})

        if p == "/api/providers/models":
            req = dict(body or {})
            k = (req.get("api_key") or "").strip()
            # 前端显示的是脱敏 key → 用已保存的真实 key
            if ("****" in k or not k) and req.get("id"):
                ps, _ = providers.list_providers(mask=False)
                old = next((x for x in ps if x["id"] == req.get("id")), None)
                if old:
                    req["api_key"] = old.get("api_key", "")
                    if not req.get("base_url"):
                        req["base_url"] = old.get("base_url", "")
                    if not req.get("protocol"):
                        req["protocol"] = old.get("protocol", "openai")
            ok, res = providers.fetch_models(req)
            return self._send({"ok": ok, "result": res})

        if p == "/api/providers/balance":
            ps, _ = providers.list_providers(mask=False)
            pv = next((x for x in ps if x["id"] == body.get("id")), None)
            if not pv:
                return self._send({"ok": False, "error": "提供商不存在"})
            ok, res = providers.query_balance(pv)
            return self._send({"ok": ok, "result": res})

        if p == "/api/chat":
            # 外部聊天上报：观察者/第三方 reporter 用。{source, who, text, ts?}
            src = body.get("source") or "observer"
            if not body.get("text"):
                return self._send({"ok": False, "error": "text 必填"})
            ingest_chat({"id": f"src:{src}", "name": src},
                        [{"ts": body.get("ts"), "who": body.get("who"), "text": body.get("text")}])
            return self._send({"ok": True})

        if p == "/api/scenario":
            name = body.get("name")
            res = scenarios.run(name, dispatch, get_bot, BOTS)
            log("TEST", f"场景 {name}: {'通过' if res.get('ok') else '未通过'} {res.get('note','')}")
            return self._send(res)

        return self._send({"error": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8900)
    ap.add_argument("--bots", default=os.path.join(HERE, "bots.json"))
    ap.add_argument("--token", default="", help="非空则 /api/* 需要 X-Console-Token（开公网必填）")
    ap.add_argument("--host", default="127.0.0.1", help="对外暴露时用 0.0.0.0")
    ap.add_argument("--readonly", action="store_true",
                    help="只读模式：只允许查询类动作，任何改变世界的动作直接拒绝")
    ap.add_argument("--manage", action="store_true",
                    help="允许在控制台启动/停止 bot 进程（仅 PC 端；手机别开）")
    a = ap.parse_args()
    global READONLY, MANAGE
    READONLY = a.readonly
    MANAGE = a.manage
    Handler.bots_path = a.bots
    Handler.token = a.token
    load_bots(a.bots)
    threading.Thread(target=poll_loop, daemon=True).start()
    print(f"[console] http://{a.host}:{a.port}/  bots={len(BOTS)}  "
          f"token={'on' if a.token else 'off'}  readonly={'on' if READONLY else 'off'}  "
          f"manage={'on' if MANAGE else 'off'}", flush=True)
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
