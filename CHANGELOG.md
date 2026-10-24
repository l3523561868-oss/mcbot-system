# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
- `docs/09` 手动上传指南 · `SECURITY.md` 脱敏清单与安全模型

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

[1.0.0]: https://github.com/l3523561868-oss/mcbot-system/releases/tag/v1.0.0
