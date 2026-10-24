"""极简 MC 服务器列表 ping（纯标准库，不依赖 minecraft-protocol）。

用途：探测节点是否可达、协议版本、MOTD、在线人数、延迟，判断三个入口是不是同一个服。
不需要账号，不需要进世界。

用法：
    python ping_mc.py mc.example.com:25565
    python ping_mc.py 8.162.24.212:23688 --host mc.example.com
"""

import argparse
import json
import socket
import struct
import time


def varint(n):
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def read_varint(sock):
    num = 0
    for i in range(5):
        b = sock.recv(1)
        if not b:
            raise ConnectionError("连接被对端关闭")
        num |= (b[0] & 0x7F) << (7 * i)
        if not b[0] & 0x80:
            return num
    raise ValueError("varint 过长")


def read_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("连接被对端关闭")
        buf += chunk
    return buf


def string(s):
    b = s.encode("utf-8")
    return varint(len(b)) + b


def ping(addr, host_override=None, timeout=6.0, proto=767):
    host, _, port = addr.rpartition(":")
    port = int(port)
    vhost = host_override or host
    t0 = time.time()
    with socket.create_connection((host, port), timeout=timeout) as s:
        # handshake: id=0x00, protocol, host, port, next_state=1(status)
        body = varint(0x00) + varint(proto) + string(vhost) + struct.pack(">H", port) + varint(1)
        s.sendall(varint(len(body)) + body)
        s.sendall(varint(1) + varint(0x00))          # status request
        length = read_varint(s)
        pid = read_varint(s)
        slen = read_varint(s)
        raw = read_exact(s, slen)
        rtt = round((time.time() - t0) * 1000)
    data = json.loads(raw.decode("utf-8", "replace"))
    return {"rtt_ms": rtt, "data": data}


def summarize(r):
    d = r["data"]
    ver = d.get("version") or {}
    players = d.get("players") or {}
    motd = d.get("description")
    if isinstance(motd, dict):
        motd = json.dumps(motd, ensure_ascii=False)
    return {
        "rtt_ms": r["rtt_ms"],
        "version": ver.get("name"),
        "protocol": ver.get("protocol"),
        "players": f"{players.get('online')}/{players.get('max')}",
        "motd": (motd or "")[:160],
        "favicon": bool(d.get("favicon")),
        "modinfo": (d.get("modinfo") or {}).get("type"),
        "forge_mods": len((d.get("modinfo") or {}).get("modList") or []),
    }


NODES = [
    # 换成你自己的服务器入口；同一后端的多个入口可以都列上做延迟对比
    ("mc.example.com:25565", None),
]

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("addr", nargs="?")
    ap.add_argument("--host", help="handshake 里用的虚拟主机名（代理网络常需要）")
    ap.add_argument("--proto", type=int, default=767)
    a = ap.parse_args()
    targets = [(a.addr, a.host)] if a.addr else NODES
    for addr, host in targets:
        for attempt in ([host] if host else [None, "mc.example.com"]):
            try:
                r = ping(addr, attempt, proto=a.proto)
                s = summarize(r)
                tag = f" (vhost={attempt})" if attempt else ""
                print(f"{addr}{tag}  OK  {s['rtt_ms']}ms  ver={s['version']} "
                      f"proto={s['protocol']} 在线={s['players']} mods={s['forge_mods']}")
                print(f"    MOTD: {s['motd']}")
                break
            except Exception as e:
                if attempt == a.host or (host and attempt == host):
                    print(f"{addr}  FAIL  {type(e).__name__}: {e}")
