# 02 · 安卓 Termux 部署（一部手机 = 服务器 + 遥控器）

> 目标：把整套后端从 PC 搬到安卓手机，**PC 全程关机也能跑**。
> 实测状态：2026-10-20 关闭 PC 下载服务后，手机侧 bot2 成功拿到坐标 `253.5, 77.0, -1157.5`。

---

## 1. 手机能不能扛住（先看这张表）

| 项 | 真实情况 |
|---|---|
| 显卡 | 不需要。协议 bot 不渲染画面，只吃 CPU / 内存 / 网络 |
| CPU | 平时很轻；A* 寻路（走动、挖矿）时短时升高，手机微温属正常 |
| 内存 | 2 个 bot 的 Node 约 200–500 MB + 两个 Python 服务 50–100 MB + 浏览器 50–150 MB → 建议 ≥6 GB |
| 存储 | 装完约 1 GB 出头（主要是 arm 版 `node_modules`），留 2 GB 余量 |
| 电量 | **不插电几小时见底**。持续网络 + CPU 阻止深度休眠，24h 运行必须插电 |
| 最低门槛 | Android 7+ / 4 GB RAM（跑 1 个 bot 更稳）/ 能长期插电 |

**最佳方案：一台闲置旧手机专机专用**——插电、不装别的 App、锁后台，最稳。
用日常手机也行，但关闭 Termux 或重启手机时 bot 会停。

---

## 2. 手机端目录约定

```
~/termux_deploy/
├── console.py  brain.py  providers.py  adapters.py  scenarios.py
├── index.html                 控制台前端（单文件）
├── bot 侧：forge-live.mjs  channel-specs.json  package.json  package-lock.json
├──          capture/  patches/  apply-patches.mjs
├── 脚本：setup.sh  start.sh  start_session.sh  restart.sh  stop.sh  update.sh  check.sh  watchdog.sh
├── 配置：bots.json  brain.json  providers.json  usage.json  pc_ip.txt  pc_port.txt
└── termux-widget/start-console.sh
```

端口与 PC 端一致：控制台 8900、大脑 8902、bot 桥 8801 / 8802。
PID 全在 `$HOME`，Termux 无 root、沙箱 UID，`pkill` 只作用于自己。

---

## 3. 安装步骤

### 3.1 装 Termux（必须 F-Droid 版）

Google Play 上的 Termux 已停止维护，不要用。

1. 从 <https://f-droid.org/packages/com.termux/> 安装 Termux（可选装 Termux:Widget）。
2. 升级基础包并装运行时：

```sh
pkg update && pkg upgrade -y
pkg install -y nodejs-lts python git unzip curl
```

### 3.2 把包放进手机（三种方式）

| 方式 | 步骤 | 适合 |
|---|---|---|
| **A. PC 中转（最省事）** | PC 上 `python make_deploy.py --serve` → 手机 `sh ~/termux_deploy/update.sh` | 已装过一次 |
| **B. 直接下载 zip** | 浏览器下载 → ZArchiver 解压 → `cp -r /storage/emulated/0/Download/termux_deploy ~/` | 首次 |
| **C. git 克隆** | `git clone <repo> ~/termux_deploy` | 想长期跟版本 |

首次用 B 或 C，之后日常用 A。**不要从 PC 拷 `node_modules`**（x64 版，手机是 arm），
手机上首次启动会自动 `npm install`。

### 3.3 一键安装

```sh
termux-setup-storage          # 必须答 y，否则 /storage/emulated/0 不存在
cp -r /storage/emulated/0/Download/termux_deploy ~/termux_deploy
chmod +x ~/termux_deploy/*.sh
sh ~/termux_deploy/setup.sh
```

`setup.sh` 做四件事：

1. 把文件规整到 `~/termux_deploy` 并加可执行位；
2. **关键资源自检**：`capture/channel-capture.json`、`channel-specs.json`、`scenarios.py`、
   `forge-live.mjs`、`patches/prismarine-nbt/nbt.js`、`apply-patches.mjs` —— 缺一个都会报出来；
3. 打 node_modules 补丁；
4. 往 `~/.bashrc` 写自启（只写一次）。

> ⚠️ 手机上**永远不要粘贴超长命令**。终端按屏宽软折行，几百字符的 `python -c "…"` 会被插进换行
> 报 `SyntaxError`，base64 载荷也会被搞坏（`zlib.error -3`）。所有长操作都走脚本文件。

---

## 4. 三种运行模式（二选一，别同时开）

| 模式 | 启动 | 关闭 Termux | 适合 |
|---|---|---|---|
| **会话自启（默认）** | `~/.bashrc` → `start_session.sh` | 一起停 | 日常挂机、最省电 |
| **24h 常开** | `bash start.sh` | **继续跑**（detach） | 旧手机专机托管 |
| 桌面小部件 | `termux-widget/start-console.sh` | 不停 | 想常驻又不想挂着 Termux |

### 4.1 会话自启（推荐）

```sh
# 装完 setup.sh 已配好，直接：
# 关掉 Termux 全部窗口 → 重新打开 → bot 自动起
# 划掉 Termux → bot 全停
```

不想要自启：

```sh
touch ~/termux_deploy/NO_AUTOSTART     # 加开关（推荐，不动 .bashrc）
rm ~/termux_deploy/NO_AUTOSTART        # 恢复
```

### 4.2 24h 常开

```sh
cd ~/termux_deploy
npm install            # 首次，arm 版依赖，几分钟
bash start.sh          # 起 4 个服务并 detach
bash stop.sh           # 停
```

同时用两种模式会端口打架：务必把 `~/.bashrc` 里 `start_session.sh` 那几行注释掉。

---

## 5. 出问题就一条命令

```sh
sh ~/termux_deploy/restart.sh
```

它按 5 步走并逐步打印：

1. `pkill` 掉 `start_session.sh` / `forge-live.mjs` / `console.py` / `brain.py`（先 TERM 再 KILL）；
2. 统计剩余进程数（正常应为 0，非 0 会列出残留）；
3. `node apply-patches.mjs` 恢复补丁；
4. 起 4 个服务：等 bot1 出现"协商成功"后再空 15 秒才起 bot2（同 IP 错峰）；
5. 轮询最多 90 秒等握手，然后**真实自检控制台**（`curl` 到 200 才算通），失败时自动 `tail` 日志；
6. 最后拉起 `watchdog.sh`（8900 连续两次不通就重启 `console.py`）。

成功判据只有三条：

```
  bot1 握手: 成功
  bot2 握手: 成功
  控制台   : http://127.0.0.1:8900 （HTTP 200）
```

> 只跑一只 bot：`SINGLE_BOT=1 sh ~/termux_deploy/restart.sh`（省资源 / 被限流时用）。

---

## 6. 24h 不掉线（照做）

- **全程插电**（最重要）。
- 设置 → 应用 → Termux → 电池 → **不受限制**。
- 概览键把 Termux **下拉锁定**，防误划。
- 脚本已自动 `termux-wake-lock`；会话模式也申请，避免 Android 在锁屏时回收。
- 开机自启可选：Termux:Boot 插件，或系统"场景"里开机执行 `bash ~/termux_deploy/start.sh`。

即便如此，Android 仍可能回收 —— wake-lock + 白名单只能**压低概率，无法根除**。
接受这一点，或者用旧手机专跑。

---

## 7. 手机当遥控器

1. 浏览器打开 `http://127.0.0.1:8900` —— 和电脑上完全一样。
2. 菜单「添加到主屏幕」，得到类 App 图标（PWA 体验）。
3. 想做成独立 App：见 [04-移动端控制台.md](../04-移动端控制台.md) 的 WebView APK 工程。

跨设备遥控（另一台手机 / 平板）：

```sh
ip addr show tun0        # Tailscale 给的是 100.x.x.x
# 控制端浏览器开 http://100.x.x.x:8900
```

同 WiFi 也可，把 IP 换成局域网地址；跨网络必须 Tailscale。

---

## 8. 手机端资源与约束

| 项 | 值 |
|---|---|
| 终端可视行宽 | **约 44 字符**，超过即软折行 → 命令一律短行或走脚本 |
| 命令路径 | 一律绝对路径（`sh /data/data/com.termux/files/home/termux_deploy/setup.sh`） |
| `termux-setup-storage` | 必须答 y |
| 双 bot 登录间隔 | ≥12 秒（`restart.sh` 自动处理） |
| 首次 `npm install` | 几百 MB，WiFi 下几分钟 |
| 更新一次 | 会断线重连一次，属正常 |

---

## 9. 首次部署检查清单

- [ ] Termux 来自 F-Droid，`pkg install -y nodejs-lts python git unzip curl` 完成
- [ ] `termux-setup-storage` 已答 y
- [ ] `~/termux_deploy/` 下没有嵌套的第二层 `termux_deploy/`（ZArchiver 二次解压常见）
- [ ] `sh setup.sh` 输出「关键资源齐全」
- [ ] `node apply-patches.mjs` 输出「完成：恢复 5 个补丁文件」
- [ ] `sh restart.sh` 三个成功判据全绿
- [ ] 浏览器 `127.0.0.1:8900` 能开，bot 显示在线
- [ ] 关掉 Termux 再打开，bot 自动回来
