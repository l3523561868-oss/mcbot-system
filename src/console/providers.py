"""providers.py — API 提供商管理（存储 + 余额查询适配 + Token 用量统计）。

数据文件（同目录）：
  providers.json  { "default": id, "providers": [ {id,name,protocol,base_url,api_key,model,enabled,balance_url} ] }
  usage.json      { "<provider_id>": { "calls", "input_tokens", "output_tokens" } }

协议：
  protocol = "openai"     → POST {base_url}，Authorization: Bearer <key>，resp.usage{prompt_tokens,completion_tokens}
  protocol = "anthropic"  → POST {base_url}，x-api-key: <key> + anthropic-version，resp.usage{input_tokens,output_tokens}

余额查询（碎片化，见 query_balance 注释）：
  内置适配 DeepSeek / 硅基流动 / Kimi 的开放余额端点；官方 OpenAI/Anthropic 普通 key 查不了；
  其余靠手动 balance_url 兜底。
"""
import json
import os
import shutil
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
if getattr(sys, "frozen", False):
    # 打包后：用户数据放 exe 上一级的 data/，重打包不会覆盖
    DATA_DIR = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(sys.executable))), "data")
else:
    DATA_DIR = HERE
os.makedirs(DATA_DIR, exist_ok=True)

PROVIDERS_PATH = os.path.join(DATA_DIR, "providers.json")
USAGE_PATH = os.path.join(DATA_DIR, "usage.json")

# 兼容旧版：数据曾在 _internal/ 下，首次启动迁移过来
for _f in ("providers.json", "usage.json"):
    _old = os.path.join(HERE, _f)
    _new = os.path.join(DATA_DIR, _f)
    if not os.path.exists(_new) and os.path.exists(_old) and os.path.abspath(_old) != os.path.abspath(_new):
        try:
            shutil.copy2(_old, _new)
        except Exception:
            pass

# 本机回环绕代理
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

_LOCK = __import__("threading").RLock()


# ---------------- 存储 ----------------

def load_providers():
    try:
        with open(PROVIDERS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"default": "", "providers": []}


def save_providers(data):
    with open(PROVIDERS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_usage():
    try:
        with open(USAGE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_usage(data):
    with open(USAGE_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ---------------- 用量 ----------------

def add_usage(pid, input_tokens, output_tokens):
    with _LOCK:
        u = load_usage()
        e = u.setdefault(pid, {"calls": 0, "input_tokens": 0, "output_tokens": 0})
        e["calls"] += 1
        e["input_tokens"] += int(input_tokens or 0)
        e["output_tokens"] += int(output_tokens or 0)
        save_usage(u)


def usage_snapshot():
    return load_usage()


# ---------------- CRUD ----------------

def list_providers(enabled_only=False, mask=True):
    d = load_providers()
    ps = d.get("providers", [])
    if enabled_only:
        ps = [p for p in ps if p.get("enabled", True)]
    u = load_usage()
    for p in ps:
        p["usage"] = u.get(p["id"], {"calls": 0, "input_tokens": 0, "output_tokens": 0})
        if mask and p.get("api_key"):
            p["api_key"] = mask_key(p["api_key"])
    return ps, d.get("default", "")


def mask_key(k):
    """密钥脱敏：sk-****abcd。"""
    k = (k or "").strip()
    if not k:
        return ""
    if len(k) <= 10:
        return "****"
    return k[:3] + "****" + k[-4:]


def upsert(p):
    """新增或编辑（按 id 匹配）。返回 (ok, err)。"""
    p = dict(p)
    if not p.get("id") or not p.get("name"):
        return False, "id 和 name 必填"
    d = load_providers()
    _old = next((x for x in d.get("providers", []) if x.get("id") == p.get("id")), None)
    _key = (p.get("api_key") or "").strip()
    # 前端拿到的是脱敏值（含 ****）或空 → 沿用原密钥，不被覆盖
    if "****" in _key or not _key:
        p["api_key"] = (_old or {}).get("api_key", "")
    if not p.get("base_url") or not p.get("api_key"):
        return False, "base_url 和 api_key 必填"
    p.setdefault("protocol", "openai")
    p.setdefault("model", "")
    p.setdefault("enabled", True)
    p.setdefault("balance_url", "")
    p.setdefault("reasoning_effort", "")      # 思考程度："" | low | medium | high
    p.setdefault("context_window", 1000000)   # 上下文窗口，默认 1M
    try:
        p["context_window"] = int(p["context_window"] or 1000000)
    except Exception:
        p["context_window"] = 1000000
    ps = d.setdefault("providers", [])
    for i, old in enumerate(ps):
        if old.get("id") == p["id"]:
            ps[i] = p
            break
    else:
        ps.append(p)
    if not d.get("default") and p.get("enabled", True):
        d["default"] = p["id"]
    save_providers(d)
    return True, ""


def remove(pid):
    d = load_providers()
    d["providers"] = [p for p in d.get("providers", []) if p.get("id") != pid]
    if d.get("default") == pid:
        d["default"] = (d["providers"][0]["id"] if d["providers"] else "")
    save_providers(d)
    return True


def set_default(pid):
    d = load_providers()
    if any(p.get("id") == pid for p in d.get("providers", [])):
        d["default"] = pid
        save_providers(d)
        return True, ""
    return False, "提供商不存在"


def default_provider():
    """返回启用的默认提供商（无则第一个启用项）。密钥不解敏，供内部调用。"""
    ps, dft = list_providers(enabled_only=True, mask=False)
    for p in ps:
        if p["id"] == dft:
            return p
    return ps[0] if ps else None


# ---------------- 余额查询 ----------------

def _get(url, key_header):
    req = urllib.request.Request(url, headers=key_header)
    with _OPENER.open(req, timeout=15) as r:
        return r.status, json.loads(r.read().decode("utf-8", "replace"))


def models_url(base_url):
    """从完整 chat 端点推导 /models 端点。"""
    b = (base_url or "").strip().rstrip("/")
    for suf in ("/chat/completions", "/messages", "/completions"):
        if b.endswith(suf):
            b = b[: -len(suf)]
            break
    return b + "/models"


def fetch_models(provider):
    """从上游拉模型列表。返回 (ok, {models:[...], note}) 。"""
    key = (provider.get("api_key") or "").strip()
    base = (provider.get("base_url") or "").strip()
    if not base:
        return False, {"note": "先填 API 端点", "models": []}
    if not key:
        return False, {"note": "先填 API Key", "models": []}
    proto = provider.get("protocol") or "openai"
    headers = {}
    if proto == "anthropic":
        headers["x-api-key"] = key
        headers["anthropic-version"] = "2023-06-01"
    else:
        headers["Authorization"] = "Bearer " + key
    url = models_url(base)
    try:
        status, data = _get(url, headers)
    except Exception as e:
        return False, {"note": f"{type(e).__name__}: {e}", "models": [], "url": url}
    models = []
    if isinstance(data, dict):
        for m in (data.get("data") or data.get("models") or []):
            if isinstance(m, dict):
                mid = m.get("id") or m.get("name") or m.get("model")
                if mid:
                    models.append({"id": mid, "name": m.get("display_name") or m.get("name") or mid})
            elif isinstance(m, str):
                models.append({"id": m, "name": m})
    models.sort(key=lambda x: x["id"])
    return bool(models), {"models": models, "url": url,
                          "note": "" if models else "已返回但未识别到模型列表"}


def query_balance(p):
    """查余额。返回 (ok, data)。data = {balance, currency, raw, note}。

    官方 OpenAI/Anthropic 的普通 API key 无余额接口（需 dashboard/org 权限），
    故只适配有开放余额端点的第三方；其余靠手动 balance_url。
    """
    key = (p.get("api_key") or "").strip()
    if not key:
        return False, {"note": "未填 api_key"}
    base = (p.get("base_url") or "").strip()
    bal_url = (p.get("balance_url") or "").strip()
    headers = {}

    if bal_url:
        url = bal_url
        if "anthropic" in (p.get("protocol") or "") and "anthropic" in bal_url:
            headers["x-api-key"] = key
        else:
            headers["Authorization"] = "Bearer " + key
    elif "deepseek.com" in base:
        url = "https://api.deepseek.com/user/balance"
        headers["Authorization"] = "Bearer " + key
    elif "siliconflow" in base:
        url = "https://api.siliconflow.cn/v1/user/info"
        headers["Authorization"] = "Bearer " + key
    elif "moonshot" in base:
        url = "https://api.moonshot.cn/v1/users/me/balance"
        headers["Authorization"] = "Bearer " + key
    elif "openai.com" in base:
        return False, {"note": "OpenAI 官方普通 key 无余额接口（需 dashboard 权限）"}
    elif "anthropic.com" in base:
        return False, {"note": "Anthropic 无开放余额端点，用量请走官方 cost_report"}
    else:
        return False, {"note": "该提供商无内置余额适配，可在编辑里手动填「余额端点」"}

    try:
        status, data = _get(url, headers)
    except Exception as e:
        return False, {"note": f"余额请求失败: {type(e).__name__}: {e}"}

    # 提取常见字段
    balance = currency = None
    def pick(d, *keys):
        for k in keys:
            if isinstance(d, dict) and k in d:
                return d[k]
        return None
    bi = None
    if isinstance(data, dict):
        bi = (data.get("balance_infos") or [{}])
        bi = bi[0] if bi else {}
        balance = pick(bi, "total_balance", "balance")
        currency = pick(bi, "currency")
        if balance is None:
            balance = pick(data, "balance", "total_balance")
        if balance is None and isinstance(data.get("data"), dict):
            balance = pick(data["data"], "balance", "total_balance")
            currency = pick(data["data"], "currency")
    return True, {"balance": balance, "currency": currency,
                  "raw": data, "note": "" if balance is not None else "已返回但未识别到余额字段"}
