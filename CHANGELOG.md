# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 新增

- 接入本地局域网世界：三个 Termux 启动脚本与 GUI/启动器统一读 `MC_HOST` / `MC_PORT`
  （默认 `mc.example.com:25565`），同一整合包可复用同一份通道表，控制台无需改动。
- `docs/01-部署流程/06` 新增「同一份整合包，同时连服务器与局域网」：切换目标、并行双目标、两条边界。
- `scripts/connect-lan.bat`：双击输入主机 + LAN 端口即可连本地世界（ASCII + CRLF，避免 cmd 解析乱码）。
- `src/bot/capture-relay.mjs`：中转抓包（真客户端 → 本地中转 → 真实服务器），
  解决真客户端拒绝"非 NeoForge 假服务端"的问题。
- `src/bot/capture-client.mjs`：用**真实客户端**抓通道表——起一个只做登录的假服务端，
  索要 `neoforge:register` 并解码成 `channel-capture.json`（离线、不联网、不碰凭证）。
- `docs/01-部署流程/06` 新增「跨网络：用内网穿透（樱花 frp 等）连接朋友的存档」：三步配置、四个坑、更稳的替代。

### 新增（架构）

- 核心契约层 `src/bot/core/contract.mjs`：事件总线（spawn/death/disconnect/chat/tick/action）+ 动作注册表，
  零依赖、错误隔离（插件抛错只计数，不影响核心）。
- 附加模块机制 `src/bot/core/addons.mjs` + `src/bot/addons/`：新功能通过 `setup(ctx)` 接入，
  核心只在 6 个固定位置 emit，桥的未知动作先交 addon。
- 核心守卫 `src/tools/core-guard.mjs`：SHA-256 指纹 + 依赖方向 + 体积增长检查；
  改核心必须 `--update -m "原因"`，原因记录在 `src/bot/core/CORE.lock`。
- `docs/11-架构与核心保护.md`：分层、依赖矩阵、8 条耦合风险（含实测证据）、R1–R6 边界规则、迁移路线。

### 新增（控制台）

- 每只 bot 卡片可填 **`host:port` 一键切换服务器**：进程在跑则自动重启，未跑则保存到
  `bots.json` 的 `target` 字段；启动时自动带 `XP_GUARD=0` 与私有通道表（`MC_CAPTURE`）。
- 接口 `POST /api/target`；仅 `--manage` 模式可用。
- 右上角「**停止全部**」：逐个结束本控制台拉起的 bot 后自行退出（`POST /api/shutdown`，需 `confirm=yes`）。

### 修复

- **flow 编码**：抓包中 `flow` 为空（`0x00` = 未指定）时不再强行补成 `CLIENTBOUND`，
  只在 `channel-specs.json` 明确给出方向时使用。此前会导致 `negotiation.failure.flow.server.missing`。
- **frozen_registry 解析**：调试转储改为 `DEBUG_DUMP=1` 才写盘，且目录缺失不再中断解析
  （此前新克隆环境必现 `payload-dump\frozen-registry.log` ENOENT，注册表整段失效）。
- `scripts/connect-lan.bat` 用 `XP_GUARD=0`（`XP_LOW_LEVEL` 是阈值不是开关）。
- `src/deploy/start.sh` 的 `BOT1_PW` / `BOT2_PW` 占位符未加引号（`<...>` 被 shell 当成重定向，
  直接 `syntax error`），现改为 `'<...>'`；8 个 shell 脚本已全部过 `sh -n`。

## [1.1.0] - 2026-10-24

把"能看懂"补成"能一把装起来"：加体检、加一键安装、加通道表工具、加两份关键文档。

### 新增

- `scripts/doctor.py`：环境体检与运行校验（Python/Node/npm/git、必要文件、node_modules 补丁 md5、
  通道表条数、`bots.json`、端口占用、控制台 HTTP、`/state` 在线态），支持 `--verify` / `--json` / `--strict`，
  退出码 `0/1/2`；配套 `scripts/体检.bat`。
- `scripts/install.ps1`：Windows 一键安装（查运行时 → `npm install` → 打补丁 → 复制配置模板 → 体检），
  `-Check` 只检查；不覆盖已有配置、不改系统设置、不需要管理员。
- `src/tools/channels.mjs`：通道表离线工具（`validate` / `diff` / `merge` / `spec`），只读写本地文件，不联网。
- `docs/01-部署流程/05-获取整合包与抓包.md`：整合包三条件核对、三条获取路径、抓包四要素、校验与失败对照。
- `docs/01-部署流程/06-本地存档与局域网.md`：单人存档 / 对局域网开放 的接入步骤、与公服的差异、限制与故障表。
- 运行时声明：`.nvmrc`（22）、`.python-version`（3.11，兼容 3.10+）。
- 环境变量：`MC_VERSION`（默认 `1.21.1`）、`MC_CAPTURE`、`MIN_CHANNELS`、`ALLOW_SAMPLE`。

### 变更

- **通道表改为硬阻断**：`forge-live.mjs` 检测到通道表少于 `MIN_CHANNELS`（默认 100）时直接 `exit 2`
  并打印解决路径，不再"警告后继续跑"。仅本地演示可用 `ALLOW_SAMPLE=1` 放行。
- `select_known_packs` 与原版版本号改为跟随 `MC_VERSION`，便于接入本地存档与其他 1.21.x 环境。
- 补丁来源路径不再回退到原作者机器的绝对路径，统一走 `capture/` 或 `MC_CAPTURE`。
- 移除 `docs/09-手动上传指南.md`（发布流程属维护者本地资料）；原 `docs/10` 重编号为 `docs/09`。

---

## [1.0.0] - 2026-10-24

首个公开版本。整理自一套已在 Windows 与安卓 Termux 上长期运行的多 Bot 控制系统，
包含完整文档、可运行源码与实测经验。

### 新增

- **协议 bot（免客户端）**：Node + mineflayer，在与服务端一致的通道表支持下可进入 NeoForge 1.21.1 服务器，
  支持寻路、挖掘、工作循环、跟随、聊天、进食、装备、传送等 104 个动作；单实例约 150 MB。
- **多 Bot 网页控制台**：纯 Python 标准库 + 单页前端（零依赖、零构建）。
  - 统一语义层：协议 bot / 客户端 bot / 反向接入 bot 三类适配器
  - 目标租约（60s 独占）避免多 bot 抢同一目标
  - bot 间语言层：游戏内 `@目标 动词 参数`，白名单 + 回执
  - 全服聊天聚合、战术地图、背包拖拽、互测场景、操作日志
  - 只读模式（服务端入口拦截）、Token 鉴权、回环豁免
- **LLM 大脑**：`brain.py` 路由到任意 OpenAI / Anthropic 兼容端点，多提供商管理、用量统计；
  无 Key 时退回关键词规则解析。
- **安卓 Termux 部署**：一套 shell 脚本支持"会话模式（开 Termux 起、关即停）"与"24h 常开"两种形态，
  含资源自检、补丁恢复、90s 握手自检、控制台看门狗、PC→手机一键更新。
- **WebView APK 工程**：Android Studio 可直接编译，把控制台网页套成原生 App 图标。
- **node_modules 补丁机制**：5 个完整文件覆盖 + `apply-patches.mjs`，解决大包解析错位导致的
  `problem inflating chunk` 崩溃与 keep_alive 被吞的 30s 踢出。
- **运维工具**：4 个协议探针（一条命令诊断卡在哪、为何被踢）、HTTP 看门狗、分段验路导航。

### 文档

- `docs/00` 项目总览 · `docs/01` 部署流程（PC / Termux / 同步更新 / 网络与远程访问）
- `docs/02` 操作手册 · `docs/03` PC 端控制台 · `docs/04` 移动端控制台
- `docs/05` 经验总结（27 条实测踩坑，现象/根因/解法）
- `docs/06` 协议层与 NeoForge 协商 · `docs/07` 排错 FAQ · `docs/08` 开发历程
- `SECURITY.md` 脱敏清单与安全模型（上传指南已从仓库移出，仅本地留存）

### 说明

- 仓库内 `src/bot/capture/` 为 **12 条示意样本**，不含任何真实服务器的通道表；
  连接真服前需用与目标服务器一致的整合包自行抓包（步骤见该目录 README）。
- 不含 Minecraft 客户端资源、模组文件或整合包内容；口令、API Key、服务器地址、玩家名均已替换为占位符。
- 以 MIT 许可发布；`src/bot/patches/` 内为若干 MIT 库的修改版文件，版权归上游。

### 已知限制

- 部分模组 GUI（传送石碑、尸体、个别容器）打开即断线：0x11 / 0x58 / 0x5b 包解析失败，未根治。
- 扩展饰品栏（Curios 类）在协议层读不到，界面仅占位。
- 正版验证服务器无法用离线协议 bot 进入。
- 安卓后台仍可能被系统回收，`wake-lock` 与电池白名单只能降低概率。
- `forge-live.mjs` 无单元测试，回归依赖日志与握手自检。

[1.1.0]: https://github.com/l3523561868-oss/mcbot-system/releases/tag/v1.1.0
[1.0.0]: https://github.com/l3523561868-oss/mcbot-system/releases/tag/v1.0.0
