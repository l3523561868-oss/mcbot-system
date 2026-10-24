# src/console — 控制台（Python，零第三方依赖）

| 文件 | 职责 |
|---|---|
| `console.py` | HTTP 服务、bot 轮询、统一语义翻译、目标租约、语言解析、鉴权、只读闸门 |
| `index.html` | 单页前端（内联 CSS/JS，无构建） |
| `adapters.py` | `protocol` / `client` / `reporter` 三类适配器 |
| `brain.py` | LLM 中转：自然语言 → `{reply, actions[]}` |
| `providers.py` | 多提供商、用量统计、余额查询 |
| `scenarios.py` | 互测场景（会合/接力/冲突/语言指挥） |
| `reporter.py` | 反向接入客户端（给 NAT 后的第三方 bot 用） |
| `mock_bot.py` | 假协议 bot，无服务器也能跑通全链路 |
| `ping_mc.py` | 服务器状态探测（不需账号） |
| `gui.py` | pywebview 原生窗口（开窗全起 / 关窗全停） |
| `launcher.py` | 无窗口启动器（备用） |
| `build_gui.py` | PyInstaller onedir 打包脚本 |
| `icon.ico` | GUI 图标 |

## 跑起来

```bash
# 需要 bots.json（从 config/ 复制）
python console.py --port 8900 [--host 0.0.0.0] [--token X] [--readonly] [--manage]
python brain.py    --port 8902
```

演示（无需真 bot）：

```bash
python mock_bot.py --port 8801 --name Bot-A &
python mock_bot.py --port 8802 --name Bot-B &
python console.py --port 8900
```

## 依赖

Python 标准库。只有 `gui.py` 需要额外装：

```bash
pip install pywebview pyinstaller
```

## 路径约定

- `bots.json` 默认与 `console.py` 同目录，可用 `--bots` 指定；
- `--manage` 拉起 bot 时用 `MC_BOT_DIR`（默认 `<repo>/src/bot`）、
  `MC_SERVER_HOST`、`MC_SERVER_PORT`、`MC_BOT_NODE` 环境变量；
- 前端通过 `/icons/<name>` 取物品图标，缺图标时返回 404（有负缓存）。

详细设计见 [../../docs/03-PC端控制台.md](../../docs/03-PC端控制台.md)。
