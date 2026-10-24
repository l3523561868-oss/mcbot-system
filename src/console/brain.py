"""brain.py — MC 多 bot 的「大脑」服务（标准库，零依赖）。

把 bot 的 askLLM 接到一个可切换的后端，一个端口对外，两种协议兼容：
  POST /v1/chat/completions   （OpenAI 兼容）
  POST /api/chat              （Ollama 兼容）

后端按 brain.json 的 mode 切换：
  mode = "llm"    → 转发到任意 OpenAI/Ollama 兼容端点（DeepSeek / 通义 / Ollama）
  mode = "agent"  → 调用本机 agent CLI（codebuddy -p），让「我」来思考，
                    并通过 8900 控制台派动作给 bot（读状态 / 下指令）

接入方式：把 proto_bot_local/server-bot/ai_config.json 的 url 指到本服务即可，
bot 5 秒内自动读取（无需改 forge-live.mjs）。

启动：python brain.py [--port 8902]
"""
import argparse
import json
import os
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import providers

HERE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(HERE, "brain.json")
CONSOLE = "http://127.0.0.1:8900"      # 控制台，agent 模式用它读状态/派动作
BOT_ID = "yuan-bot"

# 本机回环一律绕代理（环境常驻 HTTP_PROXY，否则 127.0.0.1 被代理返回 502）
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

_cfg = None
_cfg_at = 0


def cfg():
    global _cfg, _cfg_at
    if _cfg is not None and time.time() - _cfg_at < 5:
        return _cfg
    try:
        with open(CFG_PATH, encoding="utf-8") as f:
            _cfg = json.load(f)
    except Exception:
        _cfg = {}
    _cfg_at = time.time()
    return _cfg


def _http_json(url, payload, headers=None, timeout=60):
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers=h, method="POST")
    with _OPENER.open(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


# ---------------- 后端 ----------------

def run_openai(up, messages):
    """OpenAI 兼容协议。返回 (文本, usage dict)。"""
    url = str(up["base_url"]).rstrip("/")
    body = {
        "model": up.get("model"),
        "messages": messages,
        "stream": False,
        "max_tokens": up.get("max_tokens", 500),   # 太小会把 JSON 截断（指挥模式需完整 JSON）
    }
    headers = {"Authorization": "Bearer " + (up.get("api_key") or "")}
    eff = (up.get("reasoning_effort") or "").strip()
    if eff:
        body["reasoning_effort"] = eff      # 支持该参数的上游会用到（不支持的可能忽略/报错）
    data = _http_json(url, body, headers)
    txt = ((data.get("choices") or [{}])[0].get("message", {}).get("content")
           or "").strip()
    return txt, data.get("usage") or {}


def run_anthropic(up, messages):
    """Anthropic Messages 协议。返回 (文本, usage dict)。"""
    system, msgs = "", []
    for m in messages:
        if m.get("role") == "system":
            system += m.get("content", "") + "\n"
        else:
            msgs.append({"role": m.get("role", "user"),
                         "content": m.get("content", "")})
    body = {"model": up.get("model"), "max_tokens": up.get("max_tokens", 500),
            "messages": msgs}
    if system.strip():
        body["system"] = system.strip()
    headers = {"x-api-key": up.get("api_key") or "",
               "anthropic-version": "2023-06-01"}
    eff = (up.get("reasoning_effort") or "").strip()
    if eff:
        budget = {"low": 1024, "medium": 4096, "high": 8192}.get(eff, 4096)
        body["thinking"] = {"type": "enabled", "budget_tokens": budget}
        body["max_tokens"] = max(int(body.get("max_tokens", 500)), budget + 512)
    data = _http_json(str(up["base_url"]).rstrip("/"), body, headers)
    txt = "".join(b.get("text", "") for b in (data.get("content") or [])).strip()
    return txt, data.get("usage") or {}


AGENT_SYSTEM = (
    "你是 Minecraft 服务器里的 AI 玩家「bot_one」。玩家在公屏 @ 你，你要像真人一样回复。\n"
    "你可以控制自己：\n"
    "  - GET  {console}/api/state   读自己和其他 bot 的实时状态\n"
    "  - POST {console}/api/act     body {{bot:\"{bot}\", verb, args}} 下指令\n"
    "      动词：move_to(x,z) / dig / work(mode) / follow(player) / say(text) / stop / eat\n"
    "  - POST {console}/api/say     body {{bot:\"{bot}\", text}} 直接说话\n"
    "规则：能直接回答就直接回答；确实要做事（如走到某处、挖东西）才派动作。\n"
    "最终只输出一句给玩家的中文回复，不超过 40 字，口语化，不要暴露自己是程序。"
).format(console=CONSOLE, bot=BOT_ID)


def run_agent(messages, cli_path):
    """调用本机 agent CLI（codebuddy -p）思考。返回文本，失败返回 None。"""
    # 取 system + 最近几条 user 拼成 prompt
    prompt = AGENT_SYSTEM + "\n"
    for m in messages[-4:]:
        if m.get("role") == "user":
            prompt += "\n玩家: " + m.get("content", "")
    # 去掉本会话的 MCP/代理/服务代理变量，避免 CLI 的 axios 在 setProxy 崩
    env = dict(os.environ)
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
              "ALL_PROXY", "all_proxy", "CODEBUDDY_MCP_CONFIG",
              "CODEBUDDY_SERVICE_PROXY_URL", "CODEBUDDY_TOOL_CALL_ID"):
        env.pop(k, None)
    env["NO_PROXY"] = env["no_proxy"] = "*"
    try:
        p = subprocess.run(
            [cli_path, "-p", "--output-format", "text", prompt],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=90, env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        out = (p.stdout or "").strip()
        return out or None
    except Exception as e:
        print("[brain] agent 调用失败:", type(e).__name__, e, flush=True)
        return None


def answer(messages):
    """统一入口：agent 模式走本机 CLI；否则走默认提供商（OpenAI/Anthropic）。"""
    c = cfg()
    if c.get("mode") == "agent":
        cli = c.get("agent", {}).get("cli")
        if cli and os.path.exists(cli):
            return run_agent(messages, cli)
        print("[brain] agent 模式但 cli 未配置/不存在，退回 llm", flush=True)
    up = providers.default_provider()
    if not up:
        print("[brain] 无可用提供商（providers.json 未配置）", flush=True)
        return None
    try:
        if up.get("protocol") == "anthropic":
            txt, usage = run_anthropic(up, messages)
        else:
            txt, usage = run_openai(up, messages)
        inp = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
        out = usage.get("completion_tokens") or usage.get("output_tokens") or 0
        if inp or out:
            providers.add_usage(up["id"], inp, out)
        return txt
    except Exception as e:
        print("[brain] 调用失败:", type(e).__name__, e, flush=True)
        return None


# ---------------- HTTP ----------------

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

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_POST(self):
        try:
            body = self._body()
        except Exception:
            return self._send({"error": "bad json"}, 400)
        messages = body.get("messages") or []
        if not messages:
            messages = [{"role": "user", "content": body.get("prompt") or ""}]
        txt = answer(messages)
        if not txt:
            txt = "（脑子还没接上，稍后再试）"
        # 同时回 Ollama 与 OpenAI 两种形状，bot 的 askLLM 都能解析
        self._send({"message": {"role": "assistant", "content": txt},
                    "choices": [{"message": {"role": "assistant", "content": txt}}]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8902)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    print(f"[brain] http://{a.host}:{a.port}/  mode={cfg().get('mode','llm')}", flush=True)
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
