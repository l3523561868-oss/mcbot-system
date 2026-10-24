# src/deploy — Termux 部署包与 PC 打包器

## 手机端脚本

| 脚本 | 触发 | 作用 |
|---|---|---|
| `setup.sh` | 手动（一次） | 拷文件到 `~/termux_deploy` → 加可执行位 → 资源自检 → 打补丁 → 写 `.bashrc` 自启 |
| `start_session.sh` | `~/.bashrc` | 会话模式：开 Termux 起、关 Termux 停；心跳轮询守进程 |
| `start.sh` | 手动 | 24h 常开（detach） |
| `restart.sh` | 手动 | 杀干净 → 打补丁 → 起 4 服务 → 90s 握手自检 → 起看门狗 |
| `stop.sh` | 手动 | 停全部 |
| `update.sh` | 手动 | 从 PC 拉 zip → 解压 → `setup.sh` → `restart.sh` |
| `check.sh` | 手动 | 一次输出进程/HTTP/断连原因/日志行数 |
| `watchdog.sh` | `restart.sh` | 8900 连续 2 次失败 → 重启 `console.py` |
| `termux-widget/start-console.sh` | 桌面挂件 | `setsid` 脱离会话启动 |

## PC 端打包器

```bash
python make_deploy.py            # 同步 src/console + src/bot → termux_deploy/ → 打 zip
python make_deploy.py --serve    # 再起 http.server 供手机下载（端口被占自动顺延）
python make_deploy.py --serve --ip 192.168.137.1 --port 8001
```

它会：

1. 探测本机 LAN IP（`--ip auto`），写 `pc_ip.txt` / `pc_port.txt`（用 `\n`，不用 `\r\n`）；
2. 从 `../console` 与 `../bot` 同步 11 个文件 + 3 个目录；
3. 打包 `termux_deploy.zip` 并打印大小与 md5；
4. `--serve` 时起下载服务，端口占用则顺延 8000→8009。

> 部署包里的 `*.sh` 是**手工维护**的源文件；`make_deploy.py` 只同步 Python 与 Node 代码，
> 不动 shell 脚本。所以改脚本请直接改本目录。

## 手机端最终目录

```
~/termux_deploy/
├── console.py brain.py adapters.py providers.py scenarios.py index.html
├── forge-live.mjs channel-specs.json package*.json apply-patches.mjs
├── capture/ patches/ item_icons/ termux-widget/
├── bots.json brain.json providers.json usage.json pc_ip.txt pc_port.txt
└── setup.sh start.sh start_session.sh restart.sh stop.sh update.sh check.sh watchdog.sh
```

部署流程见 [../../docs/01-部署流程/02-Termux安卓部署.md](../../docs/01-部署流程/02-Termux安卓部署.md)。
