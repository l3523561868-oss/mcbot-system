"""互测场景：判定一律看 state 变化，不看接口返回值。

每个场景签名 fn(dispatch, get_bot, bots) -> dict(ok=bool, note=str, steps=list)。
bots 由 console 传入，避免 import console 造成模块双份实例。
"""

import math
import time

import adapters


def _pos(bot):
    ok, data = adapters.make(bot).state()
    if not ok:
        return None
    p = data.get("position") or {}
    if p.get("x") is None:
        return None
    return (float(p["x"]), float(p["z"]))


def _mode(bot):
    ok, data = adapters.make(bot).state()
    return data.get("mode") if ok else None


def _near(bot, x, z, tol=3.0):
    p = _pos(bot)
    return bool(p) and math.hypot(p[0] - x, p[1] - z) < tol


def _wait(pred, timeout=25.0, step=0.8):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred():
            return True, round(time.time() - t0, 1)
        time.sleep(step)
    return False, round(time.time() - t0, 1)


def _pair(bots):
    live = [b for b in bots if b.get("enabled", True)]
    if len(live) < 2:
        return None, {"ok": False, "note": "至少需要 2 个启用的 bot", "steps": []}
    return (live[0], live[1]), None


def sc_meet(dispatch, get_bot, bots):
    pair, err = _pair(bots)
    if err:
        return err
    a, b = pair
    steps = []
    tx, tz = 12.0, 12.0
    dispatch(a, "move_to", {"x": tx, "z": tz})
    ok, dt = _wait(lambda: _near(a, tx, tz))
    steps.append(f"{a['name']} 到达 {tx},{tz}: {'✓' if ok else '✗'} ({dt}s)")
    if not ok:
        return {"ok": False, "note": "A 未到达集结点", "steps": steps}
    pa = _pos(a)
    dispatch(b, "move_to", {"x": pa[0], "z": pa[1]})
    ok2, dt2 = _wait(lambda: _near(b, pa[0], pa[1]))
    steps.append(f"{b['name']} 会合到 A: {'✓' if ok2 else '✗'} ({dt2}s)")
    return {"ok": ok2, "note": "会合完成" if ok2 else "B 未会合", "steps": steps}


def sc_language(dispatch, get_bot, bots):
    """核心验证：A 用游戏内文本 @B 下指令，控制台解析后路由给 B。"""
    pair, err = _pair(bots)
    if err:
        return err
    a, b = pair
    before = _pos(b)
    if not before:
        return {"ok": False, "note": "B 无坐标，可能离线", "steps": []}
    tx, tz = before[0] + 8.0, before[1] + 8.0
    line = f"@{b['name']} move_to {tx:.0f} {tz:.0f}"
    dispatch(a, "say", {"text": line})
    ok, dt = _wait(lambda: _near(b, tx, tz, tol=4.0), timeout=30)
    steps = [f"{a['name']} 发言「{line}」",
             f"{b['name']} 响应并抵达: {'✓' if ok else '✗'} ({dt}s)"]
    return {"ok": ok, "note": "语言指挥闭环成立" if ok else "B 未响应指令", "steps": steps}


def sc_relay(dispatch, get_bot, bots):
    pair, err = _pair(bots)
    if err:
        return err
    a, b = pair
    dispatch(a, "work", {"mode": "log"})
    dispatch(b, "follow", {"player": a.get("name", "A")})
    ok, dt = _wait(lambda: _mode(a) == "log")
    steps = [f"{a['name']} work=log: {'✓' if ok else '✗'} ({dt}s)",
             f"{b['name']} follow 已下发"]
    return {"ok": ok, "note": "接力就位" if ok else "A 未进入工作模式", "steps": steps}


def sc_conflict(dispatch, get_bot, bots):
    """租约验证：两个 bot 抢同一坐标，第二个必须被拒。"""
    pair, err = _pair(bots)
    if err:
        return err
    a, b = pair
    ok1, r1 = dispatch(a, "move_to", {"x": -30.0, "z": -30.0})
    ok2, r2 = dispatch(b, "move_to", {"x": -30.0, "z": -30.0})
    steps = [f"{a['name']} 抢目标: {'ok' if ok1 else '拒绝 ' + str(r1.get('error'))}",
             f"{b['name']} 抢同一目标: {'ok（异常）' if ok2 else '被拒 ✓ ' + str(r2.get('error', ''))}"]
    good = ok1 and not ok2
    return {"ok": good, "note": "租约生效" if good else "租约未生效", "steps": steps}


REGISTRY = {
    "meet": {"desc": "会合：A 走到集合点，B 再走到 A 旁边", "fn": sc_meet},
    "language": {"desc": "语言指挥：A 用「@B move_to x z」在游戏内命令 B", "fn": sc_language},
    "relay": {"desc": "接力：A 开始采集，B 跟随待命", "fn": sc_relay},
    "conflict": {"desc": "冲突：两个 bot 抢同一坐标，第二个应被租约拒绝", "fn": sc_conflict},
}


def catalog():
    return [{"name": k, "desc": v["desc"]} for k, v in REGISTRY.items()]


def run(name, dispatch, get_bot, bots):
    item = REGISTRY.get(name)
    if not item:
        return {"ok": False, "note": f"未知场景 {name}", "steps": []}
    try:
        return item["fn"](dispatch, get_bot, bots)
    except Exception as e:
        return {"ok": False, "note": f"异常 {type(e).__name__}: {e}", "steps": []}
