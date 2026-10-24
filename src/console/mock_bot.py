"""假协议 bot：完全按《协议bot复刻指南》§6.2 的 8801 接口实现。

用途：在真协议 bot 代码到手前，验证控制台的 adapter / 任务 / 互测链路。
它不是一个桩——控制台走的是和真 bot 一样的 HTTP 路径，所以链路是可信的。

启动：python mock_bot.py --port 8801 --name Bot-A
"""

import argparse
import json
import math
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
STATE = {
    "online": False,
    "name": "Bot-A",
    "position": {"x": 0.0, "y": 64.0, "z": 0.0},
    "health": 20.0,
    "food": 20.0,
    "mode": None,
    "held": "air",
    "chat": [],
}
TARGET = {"x": None, "z": None}


def _log_chat(who, text):
    STATE["chat"].append({"ts": time.strftime("%H:%M:%S"), "who": who, "text": text})
    del STATE["chat"][:-12]  # 只留最近 12 条，与真实 /state 口径一致


def _tick():
    """每秒推进一次：走位 / 饥饿 / 死后重连。"""
    while True:
        time.sleep(1.0)
        with LOCK:
            if not STATE["online"]:
                STATE["online"] = True
                STATE["health"] = 20.0
                STATE["food"] = 20.0
                _log_chat("system", f"{STATE['name']} 已上线")
            tx, tz = TARGET["x"], TARGET["z"]
            if tx is not None:
                p = STATE["position"]
                dx, dz = tx - p["x"], tz - p["z"]
                d = math.hypot(dx, dz)
                if d < 0.6:
                    TARGET["x"] = TARGET["z"] = None
                    STATE["mode"] = None
                    _log_chat("system", "已到达目标")
                else:
                    step = min(3.5, d)
                    p["x"] += dx / d * step
                    p["z"] += dz / d * step
                    STATE["food"] = max(0.0, STATE["food"] - 0.05)
                    if STATE["food"] <= 0:
                        STATE["health"] = max(0.0, STATE["health"] - 0.5)


def _do(payload):
    """按真 bot 的动作语义改内部状态，返回执行结果。"""
    t = payload.get("type")
    with LOCK:
        if t == "say":
            _log_chat(STATE["name"], payload.get("text", ""))
            return {"ok": True, "note": "say"}
        if t == "cmd":
            _log_chat(STATE["name"], payload.get("text", ""))
            return {"ok": True, "note": "cmd"}
        if t == "goto":
            TARGET["x"] = float(payload["x"])
            TARGET["z"] = float(payload["z"])
            return {"ok": True, "note": "goto 开始"}
        if t == "goto_block":
            TARGET["x"] = float(payload.get("x", 20))
            TARGET["z"] = float(payload.get("z", 20))
            return {"ok": True, "note": f"寻找 {payload.get('match')}"}
        if t == "work":
            mode = payload.get("mode", "stop")
            STATE["mode"] = None if mode == "stop" else mode
            if STATE["mode"] in ("log", "stone"):
                TARGET["x"], TARGET["z"] = 6.0, 6.0
            return {"ok": True, "note": f"work={mode}"}
        if t == "follow":
            return {"ok": True, "note": f"follow {payload.get('player')}"}
        if t == "dig":
            STATE["held"] = "dirt"
            return {"ok": True, "note": "dig 完成"}
        if t == "eat":
            STATE["food"] = 20.0
            return {"ok": True, "note": "eat 完成"}
        if t == "stop":
            TARGET["x"] = TARGET["z"] = None
            STATE["mode"] = None
            return {"ok": True, "note": "stop"}
        if t == "inv":
            return {"ok": True, "items": {"oak_log": 3, "cobblestone": 12}}
        # ---- 只读动作（与真 bot 同名，供控制台只读模式联调）----
        if t == "pos":
            return {"ok": True, "position": dict(STATE["position"])}
        if t == "where":
            return {"ok": True, "dim": "minecraft:overworld", "biome": "plains",
                    "position": dict(STATE["position"]),
                    "yaw": 90.0, "pitch": 0.0}
        if t == "players":
            return {"ok": True, "players": [{"name": STATE["name"], "dist": 0.0},
                                            {"name": "Steve", "dist": 12.4}]}
        if t == "inv_list":
            # 模拟真实环境里的 P0：整包解析失败 → 返回 0 件
            return {"ok": True, "count": 0, "items": [], "note": "P0 模拟：window_items 整包失败"}
        if t == "inv_detail":
            return {"ok": True, "slots": [], "note": "P0 模拟：槽位不可读"}
        if t == "armor_status":
            return {"ok": True, "head": "diamond_helmet", "chest": "diamond_chestplate",
                    "legs": "diamond_leggings", "feet": "diamond_boots"}
        if t == "help":
            return {"ok": True, "actions": ["pos", "where", "players", "inv_list",
                                            "armor_status", "state"]}
        return {"ok": False, "error": f"未知动作 {t}"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/state", ""):
            with LOCK:
                self._send(dict(STATE))
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send({"ok": False, "error": "bad json"}, 400)
        self._send(_do(payload))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8801)
    ap.add_argument("--name", default="Bot-A")
    a = ap.parse_args()
    STATE["name"] = a.name
    threading.Thread(target=_tick, daemon=True).start()
    print(f"[mock] {a.name} listening on 127.0.0.1:{a.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
