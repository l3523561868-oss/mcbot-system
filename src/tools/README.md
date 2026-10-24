# src/tools — 探针与运维工具

| 文件 | 用途 |
|---|---|
| `probe.mjs` | **一条命令诊断**：两阶段（静默 / 回空通道表）自动跑，输出结论 + `probe-report.json` + `setup_failed.bin` |
| `probe_connect.mjs` | 只做静默连接，看卡在哪一步 |
| `probe_forge.mjs` | 主动回空通道表，看被踢原因 |
| `probe_dump.mjs` | 抓 `modded_network_setup_failed` 原始载荷并尝试解码 |
| `watchdog.py` | 通用 HTTP 探活 + 自动重启（防抖动、防自杀） |
| `safe_nav.py` | 分段验路防坠落导航 |

## 探针

```bash
node probe.mjs <host> <port> <username>
```

判读要点：

| 结果 | 含义 |
|---|---|
| 卡在 `configuration` 20s 不被踢 | 服务端在等 `neoforge:register`，客户端没回 |
| 0.7s 内被踢 `incompatible` | 回了空通道表 → 缺通道定义 |
| 直接进 PLAY | 该服不要求 NeoForge 协商 |

## 看门狗

```bash
python watchdog.py --url http://127.0.0.1:8801/state --expect online \
  --cwd ../bot --cmd 'node forge-live.mjs <host> <port> <user>' \
  --kill-match forge-live.mjs --cooldown 120
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--interval` | 10 | 探活间隔（秒） |
| `--fail-threshold` | 3 | 连续失败几次才重启 |
| `--cooldown` | 120 | 重启后静默期（协议 bot 进服要 60–100s） |
| `--max-restarts` | 5 | 上限，用完停下等人 |
| `--dry-run` / `--once` | 关 | 只报告 / 查一次就退出（给计划任务用） |

> `--kill-match` 的字符串会出现在看门狗**自己的命令行**里，`find_pids()` 已排除自身与父进程。
> 自己写类似工具时必须防这个（见 05 · K24）。

## 安全导航

`safe_nav.py` 把长距离移动拆成小段，每段验证脚下是否有支撑，避免 pathfinder 直冲悬崖。
