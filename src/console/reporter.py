"""反向接入器：给「在 NAT 后面、无法被直连」的 bot 用。

原理：它主动连控制台，不需要你开端口、不需要公网 IP、不需要隧道。
  1) 每 N 秒把本地 bot 的 state + 新增聊天 POST 给控制台
  2) 每 N 秒向控制台领一次指令，翻译成本地 bot 的请求体发出去，再回结果

前提：本地 bot 自己要有一个 HTTP 接口（协议 bot 的 8801、客户端 bot 的 8780 都行）。
      如果你只有一个会跑的 bot 进程、没有 HTTP 口，就把它包一层（或告诉我它的接口）。

用法：
    python reporter.py --console http://<控制台地址>:8900 \
        --id alice-bot --name 爱丽丝bot \
        --local http://127.0.0.1:8801 --kind protocol

需要同目录的 adapters.py（一起发过去即可）。
"""

import argparse
import time

import adapters


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--console", required=True, help="控制台地址，如 http://1.2.3.4:8900")
    ap.add_argument("--id", required=True, help="在控制台里显示的唯一 ID")
    ap.add_argument("--name", default=None, help="显示名，同时也是 @ 指令里的名字")
    ap.add_argument("--local", required=True, help="本地 bot 的 HTTP 地址")
    ap.add_argument("--kind", default="protocol", choices=["protocol", "client"])
    ap.add_argument("--interval", type=float, default=2.0)
    ap.add_argument("--token", default="", help="控制台开启鉴权时必填")
    a = ap.parse_args()

    console = a.console.rstrip("/")

    def cu(path):
        if not a.token:
            return console + path
        return console + path + ("&" if "?" in path else "?") + "t=" + a.token

    bot = {"id": a.id, "name": a.name or a.id, "kind": a.kind, "base": a.local}
    seen = set()
    print(f"[reporter] {a.id} → {console}  (local={a.local}, kind={a.kind})", flush=True)

    while True:
        # 1) 上报状态与新增聊天
        ok, st = adapters.make(bot).state()
        chat = []
        for m in (st.get("chat") if ok else None) or []:
            k = (m.get("ts"), m.get("text"))
            if k in seen:
                continue
            seen.add(k)
            chat.append({"ts": m.get("ts"), "who": m.get("who"), "text": m.get("text")})
        if len(seen) > 3000:
            seen.clear()
        adapters._http(cu("/api/report"), {
            "bot": {"id": a.id, "name": bot["name"], "kind": a.kind},
            "state": st if ok else {"online": False},
            "chat": chat,
        })

        # 2) 领指令并执行
        ok2, inbox = adapters._http(cu(f"/api/inbox?bot={a.id}"))
        for cmd in (inbox.get("cmds") or []) if ok2 else []:
            ok3, res = adapters.make(bot).act(cmd.get("verb"), **(cmd.get("args") or {}))
            adapters._http(cu("/api/result"), {
                "bot": a.id, "id": cmd.get("id"), "ok": ok3, "result": res,
            })
            print(f"[reporter] 执行 {cmd.get('verb')} {cmd.get('args')} -> {ok3}", flush=True)

        time.sleep(a.interval)


if __name__ == "__main__":
    main()
