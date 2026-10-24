# Windows 启动脚本

| 脚本 | 作用 | 前置 |
|---|---|---|
| `doctor.py` | **环境体检**：版本/依赖/补丁哈希/通道条数/端口/在线态 | 无（随时可跑） |
| `体检.bat` | 双击运行 `doctor.py` 的包装 | 无 |
| `install.ps1` | **Windows 一键安装**：查运行时 → npm install → 打补丁 → 复制配置模板 → 体检 | Node/Python 已装 |
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

## 一键安装（Windows）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1          # 安装
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Check   # 只检查
```

行为边界（有意收紧）：

- 只装 `src/bot` 的 npm 依赖、恢复 5 个补丁、从 `config/*.example.json` 复制配置；
- **不覆盖**任何已存在的配置；不删文件；不改系统 PATH / 执行策略；不需要管理员；
- 不下载任何脚本，只访问 npm registry。

> `-ExecutionPolicy Bypass` 只对本次调用生效，不改系统设置。
> 脚本文件本身带 UTF-8 BOM（Windows PowerShell 5.1 读中文必需），编辑时别存成无 BOM。

## 体检脚本

```bash
python scripts/doctor.py            # 人读：逐项 PASS/WARN/FAIL + 下一步
python scripts/doctor.py --verify   # 追加运行校验（控制台 200 / bot 在线）
python scripts/doctor.py --json     # 机器读：给 AI 或 CI 用
```

退出码：`0` 通过（允许警告）｜`1` 有 FAIL｜`2` `--strict` 且有 WARN。

> 本目录的 bat 只是便捷入口。正式部署推荐 `src/console/gui.py` 打包出的 `MC-Bot-GUI.exe`：
> 开窗口全起、关窗口强制全停。
