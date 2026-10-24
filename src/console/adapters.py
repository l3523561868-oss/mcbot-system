"""多 bot 适配层：把不同 bot 的私有接口统一成 3 个方法。

统一语义（最小公倍数，协议 bot 与客户端 bot 都能覆盖）：
    state()                 -> dict
    act(verb, **args)       -> dict
    say(text)               -> dict

新增一类 bot：继承 Adapter，实现 build_action()，在 ADAPTERS 里注册 kind。
"""

import json
import urllib.error
import urllib.request

# 手机端 bot 桥是单线程处理动作的：30s 超时会让浏览器 6 条连接全被一个卡住的请求占死，
# 前端表现就是「一直连接中」。8s 足够正常动作往返，卡住也能迅速放开连接。
TIMEOUT = 8.0

# 只读动作：协议 bot 的原生动作名，直接透传 {"type": verb}，不改变世界/角色状态。
# 仅收"查询/读取"类；任何移动、挖掘、攻击、放置、仓库操作都不在此列。
# 实测校准（2026-10-18）：真 bot 没有 pos / where，坐标在 state 里。
RAW_READONLY = ("players", "inv_list", "inv_detail", "armor_status",
                "list_waystones", "scan_area", "ws_blocktypes", "help",
                "map_slice")

# 本机 bot 一律直连：绕过系统/环境变量里的 HTTP 代理，否则 127.0.0.1 会被代理返回 502
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _http(url, payload=None, token=None):
    """极简 JSON 请求。返回 (ok, data)。不抛异常，失败也返回结构化结果。"""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-AI-Token"] = token
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        req = urllib.request.Request(url, data=data, headers=headers,
                                     method="POST" if data else "GET")
        with _OPENER.open(req, timeout=TIMEOUT) as r:
            raw = r.read().decode("utf-8", "replace")
        try:
            return True, json.loads(raw)
        except json.JSONDecodeError:
            return True, {"raw": raw[:2000]}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:500]
        return False, {"error": f"HTTP {e.code}", "body": body}
    except Exception as e:  # 连接失败/超时/解析异常统一收敛
        return False, {"error": f"{type(e).__name__}: {e}"}


class Adapter:
    kind = "base"

    def __init__(self, bot):
        self.bot = bot
        self.base = (bot.get("base") or "").rstrip("/")
        self.token = bot.get("token") or ""

    # --- 子类必须实现 ---
    def build_action(self, verb, args):
        raise NotImplementedError

    def state_path(self):
        return "/state"

    # --- 通用实现 ---
    def state(self):
        return _http(self.base + self.state_path(), None, self.token)

    def act(self, verb, **args):
        payload = self.build_action(verb, args)
        if payload is None:
            return False, {"error": f"{self.kind} 不支持动作 {verb}"}
        path = self.bot.get("act_path", "")
        return _http(self.base + path, payload, self.token)

    def say(self, text):
        return self.act("say", text=text)


class ProtocolAdapter(Adapter):
    """协议 bot：文档实证的 HTTP 决策桥（默认 127.0.0.1:8801）。

    端点（依据《协议bot复刻指南》§6.2）：
        GET  /state
        POST {type:"say",text} / {type:"cmd",text}
        POST {type:"goto",x,z,range}
        POST {type:"goto_block",match,maxDist}
        POST {type:"work",mode:"log|stone|patrol|stop"}
        POST {type:"follow",player}
        POST {type:"dig"} / {type:"eat"} / {type:"inv"} / {type:"stop"}
    """
    kind = "protocol"

    def build_action(self, verb, a):
        if verb == "move_to":
            return {"type": "goto", "x": a["x"], "z": a["z"],
                    "range": a.get("range", 2)}
        if verb == "dig":
            if a.get("block"):
                return {"type": "goto_block", "match": a["block"],
                        "maxDist": a.get("maxDist", 32)}
            return {"type": "dig"}
        if verb == "work":
            return {"type": "work", "mode": a.get("mode", "stop")}
        if verb == "follow":
            return {"type": "follow", "player": a["player"]}
        if verb == "say":
            # 实测（2026-10-18）：profileKeys 注入后签名聊天生效，公屏可以真发。
            # 老版本被 TrChat 丢弃时用 /me 兜底，所以保留模式切换。
            mode = a.get("mode") or self.bot.get("say_mode", "say")
            if mode == "say":
                return {"type": "say", "text": a["text"]}
            return {"type": "cmd", "text": "/me " + a["text"]}
        if verb in ("stop", "eat", "inv"):
            return {"type": verb}
        if verb == "equip":
            p = {"type": "equip"}
            if a.get("slot") not in (None, ""):
                p["slot"] = a["slot"]
            if a.get("name"):
                p["name"] = a["name"]
            if a.get("destination"):
                p["destination"] = a["destination"]
            return p
        if verb == "move_slot":
            return {"type": "move_slot", "from": a.get("from"), "to": a.get("to")}
        if verb == "use_item":
            return {"type": "use_item", "offhand": bool(a.get("offhand"))}
        if verb == "chat_cmd":
            return {"type": "cmd", "text": a["text"]}
        if verb == "waystone":
            return {"type": "waystone", "name": a.get("name") or ""}
        if verb == "warp_to":
            return {"type": "warp_to", "name": a.get("name") or ""}
        if verb == "list_waystones":
            return {"type": "list_waystones"}
        if verb in RAW_READONLY:            # 只读动作原样透传
            return {"type": verb}
        return None


class ClientAdapter(Adapter):
    """已装 aiplayer 模组的客户端 bot（默认 127.0.0.1:8780）。

    注意：mod 控制面的请求体形状未见源码（仓库只有 README/文档），
    这里按 `{"type":"mc_act","action":...,"args":{...}}` 实现，
    并用 bot 配置里的 `payload_style` 可切换：
        style_a: {"type":"mc_act","action":"goto","args":{...}}
        style_b: {"action":"mc_act","argv":{"type":"goto", ...}}
    拿到 mod 的 /act 文档或实机一次抓包后，只改这一个函数。
    """
    kind = "client"

    def state_path(self):
        return "/state"

    def build_action(self, verb, a):
        inner = self._inner(verb, a)
        if inner is None:
            return None
        if self.bot.get("payload_style", "style_a") == "style_b":
            return {"action": "mc_act", "argv": inner}
        return {"type": "mc_act", "action": inner["type"], "args": inner}

    def _inner(self, verb, a):
        if verb == "move_to":
            return {"type": "goto", "x": a["x"], "z": a["z"]}
        if verb == "dig":
            return {"type": "dig"}
        if verb == "work":
            return {"type": "work", "mode": a.get("mode", "stop")}
        if verb == "follow":
            return {"type": "follow", "player": a["player"]}
        if verb == "say":
            return {"type": "chat", "text": a["text"]}
        if verb in ("stop", "eat"):
            return {"type": verb}
        if verb == "chat_cmd":
            return {"type": "chat", "text": a["text"]}
        return None


ADAPTERS = {
    ProtocolAdapter.kind: ProtocolAdapter,
    ClientAdapter.kind: ClientAdapter,
}


def make(bot):
    cls = ADAPTERS.get(bot.get("kind"))
    if not cls:
        raise ValueError(f"未知 bot 类型：{bot.get('kind')}")
    return cls(bot)
