# Windows 启动脚本

| 脚本 | 作用 | 前置 |
|---|---|---|
| `启动控制台.bat` | 只起控制台 8900 并打开浏览器 | `src/console/bots.json` 存在 |
| `启动大脑.bat` | 只起大脑 8902 | `brain.json` 可留空（不接 LLM 也能跑规则解析） |
| `启动全部.bat` | bot1 + bot2 + 控制台 + 大脑 | 环境变量见下 |
| `启动_手机模式.bat` | 控制台绑 `0.0.0.0`，供手机访问 | 公网暴露必须设 `CONSOLE_TOKEN` |
| `启动_演示模式.bat` | 2 个 mock bot + 控制台，不需要真服务器 | 无 |

`启动全部.bat` 读取的环境变量（在系统里设，或直接改脚本）：

| 变量 | 示例 | 说明 |
|---|---|---|
| `MC_HOST` | `mc.example.com` | 服务器地址 |
| `MC_PORT` | `25565` | 服务器端口 |
| `BOT1_USER` / `BOT2_USER` | `bot_one` / `bot_two` | 账号名 |

`BOT_PW`（AuthMe 口令）请写在 `src/bot/.env` 或你的启动环境里，**不要写进仓库**。

> 本目录的 bat 只是便捷入口。正式部署推荐 `src/console/gui.py` 打包出的 `MC-Bot-GUI.exe`：
> 开窗口全起、关窗口强制全停。
