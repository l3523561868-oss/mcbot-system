"""探路导航：每次迈步前先检查前方地面有没有断崖，有就绕行。

用法：
    python safe_nav.py --x -133 --z 9 --y 91
        （y 是"到达后要右键的方块高度"，可选；只用于最后的开界面判定）

逻辑：
  1. 取 map_slice（半径 32），知道周围每列的地表高度
  2. 朝目标方向找"最远的连续安全点"（直线上任何一处的地表
     比 bot 当前脚下低超过 max_drop 就算断崖）
  3. 只走到那个安全点，到了重新取切片再决策
  4. 若直线全断 → 依次尝试 ±30°/±60°/±90° 的绕行方向
  5. 距目标 < 4.5 且 y 达标 → 停下，供上层做右键交互
"""

import argparse
import json
import math
import time
import urllib.error
import urllib.request

OP = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 本机直连
BRIDGE = "http://127.0.0.1:8801"


def call(payload, timeout=25):
    req = urllib.request.Request(BRIDGE, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(OP.open(req, timeout=timeout).read().decode())


def state():
    req = urllib.request.Request(BRIDGE + "/state")
    return json.loads(OP.open(req, timeout=8).read().decode())


def cur():
    d = state()
    p = d["position"]
    return p["x"], p["y"], p["z"]


def dist(x1, z1, x2, z2):
    return math.hypot(x1 - x2, z1 - z2)


def get_slice(radius=32):
    r = call({"type": "map_slice", "radius": radius})
    return r if r.get("ok") else None


def cell(m, x, z):
    dx = int(round(x - m["origin"]["x"])) + m["r"]
    dz = int(round(z - m["origin"]["z"])) + m["r"]
    g = m["grid"]
    if 0 <= dz < len(g) and 0 <= dx < len(g[0]):
        return g[dz][dx]
    return None


def line_safe(m, x1, z1, x2, z2, bot_y, max_drop=4):
    """沿直线采样，任何一处地表比 bot 脚下低超过 max_drop → 断崖，不安全。"""
    steps = max(2, int(max(abs(x2 - x1), abs(z2 - z1)) // 2))
    for i in range(1, steps + 1):
        t = i / steps
        x = x1 + (x2 - x1) * t
        z = z1 + (z2 - z1) * t
        c = cell(m, x, z)
        if c is None:
            continue                       # 无数据（未加载），不判危险，但记一下
        gy = c[1]
        if gy < bot_y - max_drop:
            return False, (round(x), gy, round(z))
    return True, None


def pick_target(m, bx, bz, tx, tz, bot_y, max_drop):
    """从近到远尝试直线；若断，试绕行角度。返回 (x, z, note)。"""
    d = dist(bx, bz, tx, tz)
    if d <= 12:
        return tx, tz, "已很近，直走"
    best = None
    for frac in (0.25, 0.45, 0.65, 0.85, 1.0):
        px = bx + (tx - bx) * frac
        pz = bz + (tz - bz) * frac
        ok, bad = line_safe(m, bx, bz, px, pz, bot_y, max_drop)
        if ok:
            return px, pz, f"直线安全到 frac={frac}"
        if best is None:
            best = (px, pz)               # 记住第一个断点前的位置
        if bad:
            print(f"    断崖 @{bad[0]},{bad[2]} y={bad[1]}（低 {bot_y-bad[1]} 格）")
    # 直线有断崖 → 绕行
    base = math.atan2(tz - bz, tx - bx)
    for deg in (35, -35, 60, -60, 90, -90):
        ang = base + math.radians(deg)
        px = bx + math.cos(ang) * min(18, d)
        pz = bz + math.sin(ang) * min(18, d)
        ok, _ = line_safe(m, bx, bz, px, pz, bot_y, max_drop)
        if ok:
            return px, pz, f"绕行 {deg}°"
    if best:
        return best[0], best[1], "全是断崖，只走最近的一段"
    return tx, tz, "无数据，直走试试"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--x", type=float, required=True)
    ap.add_argument("--z", type=float, required=True)
    ap.add_argument("--y", type=float, default=0, help="目标方块高度（到位后用于右键判定）")
    ap.add_argument("--max-drop", type=int, default=4)
    ap.add_argument("--timeout", type=int, default=420)
    ap.add_argument("--reach-y", type=int, default=84,
                    help="y 达到该值且水平距离 <5 时认为可以右键")
    a = ap.parse_args()

    print(f"[nav] 目标 ({a.x:.0f},{a.z:.0f})  max_drop={a.max_drop}", flush=True)
    t0 = time.time()
    fired = False
    last = None

    while time.time() - t0 < a.timeout:
        bx, by, bz = cur()
        d = dist(bx, bz, a.x, a.z)
        if d <= 4 and (not a.y or by >= a.reach_y):
            print(f"[nav] 到位：({bx:.0f},{by},{bz:.0f}) 距 {d:.0f}，可以右键", flush=True)
            return 0
        if fired:
            time.sleep(1)
            continue

        m = get_slice(32)
        if not m:
            print("[nav] 拿不到地图，重试", flush=True)
            time.sleep(2)
            continue

        tx, tz, note = pick_target(m, bx, bz, a.x, a.z, by, a.max_drop)
        step_d = dist(bx, bz, tx, tz)
        print(f"[nav] bot=({bx:.0f},{by},{bz:.0f}) → 中途点 ({tx:.0f},{tz:.0f}) "
              f"走 {step_d:.0f} 格（{note}） ｜ 距最终目标 {d:.0f}", flush=True)
        if step_d < 2:
            time.sleep(2)
            continue

        call({"type": "goto", "x": tx, "y": by, "z": tz, "range": 1})

        # 等它走到中途点（最多 step_d/3 + 8 秒）
        wait = min(40, max(8, step_d * 1.2))
        wt0 = time.time()
        while time.time() - wt0 < wait:
            time.sleep(2)
            nx, ny, nz = cur()
            if dist(nx, nz, tx, tz) <= 2.5 or abs(ny - by) > 6:
                break
            if nx == last and nz == last:
                pass
            last = (nx, nz)
        last = None

    print("[nav] 超时", flush=True)
    return 1


if __name__ == "__main__":
    sys_exit = main()
