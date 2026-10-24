# 07 · 排错 FAQ

> 用法：先按 §1 查症状，再跳到对应小节。
> 涉及根因的深度解释在 [05-经验总结.md](05-经验总结.md)（编号 K01–K27）。

---

## 1. 症状索引

| 症状 | 最可能原因 | 去看 |
|---|---|---|
| 控制台打不开（8900 拒绝连接） | console.py 没起 / 端口被占 / 缺 `scenarios.py` | §2.1 |
| 控制台能开但 bot 显示离线 | bot 未进服 / 握手失败 / 补丁没打 | §2.2 |
| bot 在线但派动作没反应 | bot 实际离线 / 动作名不在白名单 | §2.3 |
| bot 一直重连 | AuthMe 未登录 / 缺通道表 / 被限流 | §2.2 / §4 |
| bot 能说话一次，之后不行 | `authed` 未置真（重连后） | K17 |
| 首屏十几秒 / 图标一直转 | 图标无负缓存 / 固定取 bots[0] | K26 |
| 日志刷 BrokenPipeError | 客户端提前断开，不是崩溃 | K25 |
| 手机下载包失败 | PC 侧 `--serve` 没跑 / IP 变了 | §3 |
| `WinError 10049` / `10048` | IP 失效 / 端口被占 | K15 |
| 手机粘命令报 SyntaxError | 终端软折行 | K20 |
| `No such file` 找不到脚本 | 双层目录 / storage 没挂 | K21 / K22 |
| 手机 bot 半夜全没了 | Android 回收 Termux | §3.3 |
| 传送无效 | 没先开石碑界面 / 颜色网络不对 | K08 |
| 背包拖不动 / 主手不对 | 主手是热栏镜像，不是独立存储 | 03 §6 |

---

## 2. 三类服务的排错

### 2.1 控制台（8900）

```bash
curl --noproxy '*' -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8900/
```

| 结果 | 判读 |
|---|---|
| `200` | 控制台正常，问题在别处 |
| `000` / 拒绝连接 | 进程没起或崩了 → 看日志最后几行 |
| `401` | 服务正常，但开了 token 且没带 |

进程没起的常见原因（按概率）：

1. **缺 `scenarios.py`** —— `console.py` 顶层 `import scenarios`，缺了直接崩；
2. 端口 8900 被上次的实例占着 → `netstat -ano | findstr :8900`；
3. 手机端：僵尸 node 让启动脚本提前 `exit 0`（K19）。

### 2.2 bot（8801 / 8802）

```bash
curl --noproxy '*' http://127.0.0.1:8801/state
```

| 字段 | 期望 | 不满足说明什么 |
|---|---|---|
| `online` | `true` | 没进服 / 掉线 |
| `position` | 非 null | 还在登录或卡在 configuration |
| `authed` | `true` | 未过 AuthMe，**能连但不能操作/发言** |

再查日志关键行：

```bash
grep -E "neoforge:register|协商成功|problem inflating|/login|kicked|end" bot-8801.log | tail -20
```

| 日志特征 | 结论 | 处理 |
|---|---|---|
| 没有 `neoforge:register（N 通道）` | 缺通道表 | 补 `capture/channel-capture.json`（K14） |
| 有 `problem inflating chunk` | 补丁丢了 | `node apply-patches.mjs`（K23） |
| 反复 `>> /login` | AuthMe 守卫在补发；口令可能不对 | 核对 `BOT_PW`（K27） |
| 有 `kicked` | 看被踢原因原文 | 对照 K14 / 限流 |

### 2.3 派了动作没反应

1. 先读 `state` 确认 `online:true`（**别盲派**）；
2. 看控制台「操作日志」有没有 `ACT <verb> → ok/err`；
3. `err` 且提示"不在白名单" → 当前是只读模式；
4. `ok` 但人没动 → 动作异步 + 被挡（墙/水/无路径）；用回读坐标判断，别信返回值。

---

## 3. 手机端排错

### 3.1 三条命令走完

```sh
ls ~/termux_deploy/capture/channel-capture.json   # 通道表在不在
node ~/termux_deploy/apply-patches.mjs            # 补丁恢复（应输出 5 个）
sh ~/termux_deploy/check.sh                       # 进程 / HTTP / 断连原因
```

### 3.2 一条命令重来

```sh
sh ~/termux_deploy/restart.sh
```

看末尾三条判据：`bot1 握手` / `bot2 握手` / `控制台 HTTP`。
不是全绿就照脚本自动 `tail` 出来的日志看。

### 3.3 半夜 bot 全没了

Android 把 Termux 回收了。按顺序做：

1. 确认 `termux-wake-lock` 生效（脚本已自动申请）；
2. 设置 → 应用 → Termux → 电池 → **不受限制**；
3. 概览键下拉锁定；
4. 插电；
5. 仍频繁 → 换旧手机专机专用。

**这是概率问题，不是 bug**，只能压低不能根除。

### 3.4 更新相关

| 现象 | 处理 |
|---|---|
| `update.sh` 下载失败 | PC 上 `make_deploy.py --serve` 在跑？IP 对不对？ |
| 更新后 bot 离线 | 补丁被 npm 还原 → `node apply-patches.mjs`，或直接 `restart.sh`（会自动打） |
| 手机目录两层 | `cd ~/termux_deploy && mv termux_deploy/* . && rmdir termux_deploy` |

---

## 4. 服务器侧

| 现象 | 说明 | 处理 |
|---|---|---|
| `Connection throttled` | 同 IP 短时间多连接 | 两个 bot 启动间隔 ≥12 秒（`restart.sh` 已处理） |
| `multiplayer.disconnect.incompatible` | 通道表不对/为空 | 补 `capture/`（K14） |
| 被要求 `/login` 但口令对 | 登录包丢了 | 守卫会补发 3 次；仍不行看 K27 |
| 公屏提示"请不要刷屏" | 发言频率过高 | 降低频率；服务器会警告甚至禁言 |
| 打开 GUI 就断线 | 模组包解析失败 | 已知未根治（06 §6） |

---

## 5. 几个被反复问的判断

**Q：用 Cloudflare / ngrok 绑定域名，能解决"控制台打不开"吗？**
不能。隧道只是代理，本地 `console.py` 没起来就是代理到死端口。
隧道唯一价值是异地访问，且必须先设 `CONSOLE_TOKEN`。

**Q：能不能让两台机器（我 + 朋友）互相控制对方的 bot？**
不能"接管"，只能"接入"。对方的 bot 跑在他自己机器上，桥只监听 `127.0.0.1`。
可行的是：对方跑 `reporter.py` 反向接入你的控制台，或都装 Tailscale 直连。
本地复刻得到的是**新账号新玩家**，不是他那一个。

**Q：手机能不能既跑服务又当遥控器？**
能，且推荐（形态②）。但关掉 Termux 就全停；要 24h 必须插电 + 电池白名单。

**Q：为什么不用真游戏客户端 + JsMacros？**
客户端要 4–6 GB 内存、要显卡，手机跑不动，且无法无头常驻。
协议 bot 约 150 MB、无渲染，代价是拿不到部分 GUI 交互（见 06 §6）。

**Q：bot 被杀了会怎样？**
自动重生，但**掉落背包**。高等级 bot 死亡损失大 → 接第三方时先用 `--readonly`。

**Q：能跑几个 bot？**
取决于内存与服务器限流。手机 6 GB 实测 2 个稳定；PC 上每 bot 约 150 MB。
同 IP 多开要注意错峰与服务器规则。
