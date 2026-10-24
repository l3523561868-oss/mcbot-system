# 06 · 协议层与 NeoForge 协商（本项目的技术核心）

> 这一篇解释"为什么一个不带游戏客户端的 Node 进程能进 NeoForge 服务器"，
> 以及迁移到别的服务器时必须重做哪些事。

---

## 1. 服务端特征（实测结论）

| 项 | 结论 | 证据来源 |
|---|---|---|
| 版本 | MC 1.21.1（协议 767） | 探针握手 |
| 模组加载器 | **NeoForge 21.1.251**（外层 Youer） | `modded_network_setup_failed` 载荷原文含 `"NeoForge 21.1.251"` |
| 正版验证 | **离线模式**（登录直接 success） | probe_connect：无正版校验流程 |
| 二次认证 | **AuthMe**（进服后需 `/login <服内密码>`） | 聊天提示 `[玩家系统] 请输入"/login <密码>"以登录` |
| 多入口 | 多个域名/IP 指向**同一后端** | 三个入口在线数与 MOTD 完全一致 |

推论（对使用者的直接影响）：

- 微软账号密码在这里**完全无用**，用户名只是字符串；
- 用户名限制 `[A-Za-z0-9_]{3,16}`，不能带空格；
- 进服后必须再输一次**服务器内注册的口令**，这是两套认证。

---

## 2. 卡点在哪：configuration 阶段

朴素离线连接（只发 login_start / login_acknowledged）的表现：

```
连接=true 登录=true 末态=configuration 被踢=false（20s 内既不进 PLAY 也不被踢）
入站只收到 3 个 custom_payload，之后无响应
```

主动回一个**空通道表**：

```
0.7s 内被踢 multiplayer.disconnect.incompatible
```

### 2.1 服务端在 configuration 阶段下发的三包

| 包 | 长度 | 含义 |
|---|---|---|
| `minecraft:unregister` | 2747 B | 撤销客户端已注册的通道 |
| `minecraft:register` | 133 B | 服务端的监听表 |
| `neoforge:register` | 1 B（`0x00` = 空表） | **要求客户端上报自己的 1305 个通道** |

客户端不回 `neoforge:register`（或回空表）→ 服务端判定"你没装 NeoForge"→ 踢。

被踢时服务端还会**逐条列出缺失的通道**（约 987 B 载荷），这是可以迭代收敛的输入源
（`src/tools/probe_dump.mjs` 会把它落盘成 `setup_failed.bin`）。

---

## 3. 三个关键资源文件

| 文件 | 大小 | 缺了会怎样 |
|---|---|---|
| `capture/channel-capture.json` | 143 KB / **1305 条** | **致命**：`capturedGroups()` 返回 null → 静默不回 register → 被踢 |
| `channel-specs.json` | 90 KB / 1218 条 | 非致命：通道版本号退回 `"1"`，可能触发 `modded_network_setup_failed` |
| `capture/known-packs-real.json` + `packet-seq-real.json` | 小 | 影响 known packs 协商与包序对齐 |

**最容易踩的地方**：这些文件缺失时**不报错、不崩**，只是静默降级，然后在服务端被踢。
所以排错时必须主动 grep 日志里有没有：

```
>> C->S neoforge:register（1305 通道）
✅ 协商成功
```

没有这两行，就说明握手没完成，别去怀疑别的地方。

### 3.1 怎么重新抓一份（换服必做）

1. 用**真实游戏客户端**（装了对应 NeoForge 与模组）连进目标服务器；
2. 在客户端侧对 `neoforge:register` 相关网络包抓包（或用带日志的代理）；
3. 解析出"通道名 → 注册顺序/版本"，按本项目 `channel-capture.json` 的结构落盘；
4. 用 `probe_forge.mjs` 验证：不再收到 `incompatible`，而是进入 PLAY。

> 这一步没有捷径。没有通道表，"协议 bot 进 NeoForge 服"这件事不成立。

---

## 4. node_modules 的 5 个补丁（为什么必须打）

`npm install` 后 `node_modules` 会还原成上游原版，必须 `node apply-patches.mjs`
（补丁是**完整文件覆盖**，不是 diff）。

| 补丁文件 | 解决什么 |
|---|---|
| `minecraft-protocol/src/client.js` | ① `_hasBundlePacket = false`：禁用 bundle 缓存，否则未闭合的 bundle 无限积压，`keep_alive` 被吞 → 30s 超时踢；② 插入 `packetFilter` Transform，在解压后、反序列化前**丢弃会引发解析错位的超大包**（`window_items` 0x13 / `unlock_recipes` 0x41 / `declare_recipes` 0x77 / `advancements` 0x74） |
| `prismarine-nbt/nbt.js` | `simplify()` 对 null/undefined 返回 null，不再抛 TypeError |
| `prismarine-registry/lib/pc/index.js` | 分派前 `entries.filter(e => e.element != null)`，并打印丢弃数 |
| `prismarine-registry/lib/pc/transforms.js` | `biome.element` 缺失时直接返回，不读 `.category` |
| `mineflayer/lib/plugins/inventory.js` | 物品栏同步容错 |

### 4.1 崩溃链（完整因果，值得记住）

```
服务器登录阶段下发超大包（declare_recipes ~3MB / advancements ~3MB / unlock_recipes ~1.8MB）
  → minecraft-protocol 1.68 的 1.21.1 结构定义与实际格式不匹配 → 读错字节数
  → TCP 流错位（后续所有包从错误偏移开始解析）
  → zlib 解压失败：problem inflating chunk
  → NBT 解析拿到的不是 NBT
  → prismarine-nbt / prismarine-registry 无空值保护 → TypeError
  → 进程退出 → 控制台显示「离线」
```

所以补丁做两件事：**保持 TCP 流对齐**（丢弃无法正确解析的包）+ **空值保护**（丢条目但不崩链）。

### 4.2 判断补丁生效的两种方法

1. 功能判据：日志有 `✅ 协商成功`，且不再出现 `problem inflating chunk`；
2. 行号判据：`diff node_modules/<file> patches/<file>` —— 同版本不可能差十几行。
   **diff 前先 `tr -d '\r'`**，补丁文件是 CRLF。

### 4.3 一个实现细节（改补丁时会踩）

Transform 的 `transform` 必须用**普通函数**（`this.push` 要指向 Transform 实例），
用箭头函数会报 `this.push is not a function`。

---

## 5. 代价：丢了多少注册表

`filter(e => e.element != null)` 会丢掉解析失败的条目，实测保留率：

| 注册表 | 保留率 |
|---|---|
| `damage_type` | ~38% |
| `enchantment` | ~63% |
| 物品 / 方块 / 维度 | **完整** |

关键表完整 → 进服、背包、护甲、玩家列表、寻路全部正常；少数伤害类型/附魔元数据不准，不影响主要功能。

---

## 6. 当前协议层的边界（哪些做得到、哪些做不到）

| 能力 | 状态 | 说明 |
|---|---|---|
| 进服 / 移动 / 挖掘 / 聊天 | ✅ | 主链路稳定 |
| 背包读取与装备切换 | ✅ | `inv_list` + `equip` 已实测 |
| Waystones 传送 | ✅ | 必须先 `ws_open2` 开界面再选点 |
| 打开模组 GUI（部分容器 / 尸体） | ❌ | 开界面即断线：0x11 / 0x58 / 0x5b 包解析失败 |
| 饰品栏（Curios） | ❌ | 协议层读不到，仅 UI 占位 |
| 正版验证服务器 | ❌ | 无会话密钥，离线协议无法通过 |
| 内螺纹式"发包即生效"的复杂 GUI 操作 | ⚠️ | 依赖具体模组，需逐个验证 |

**已知未根治**：模组 GUI 断线。定位方向是上述三类包的结构定义，需要按服抓包补齐。

---

## 7. 探针工具（排障第一站）

```bash
node src/tools/probe.mjs <host> <port> <name>
```

两阶段自动跑，输出结论 + 落盘三件：

| 阶段 | 做什么 | 典型结果 |
|---|---|---|
| A 静默 | 只登录，不回应协商 | 卡在 `configuration`，不被踢 |
| B 回应空表 | 主动发空 `neoforge:register` | 0.7s 内被踢，载荷 987 B 落盘 |

| 产出 | 内容 |
|---|---|
| 控制台 | 每阶段连接/登录/末态/被踢、入站包统计、解出的通道名、结论 |
| `probe-report.json` | 结构化结果，便于对比不同时间点 |
| `setup_failed.bin` | 服务端失败载荷原件 |

单阶段脚本：`probe_connect.mjs`（看卡在哪）、`probe_forge.mjs`（看被踢原因）、
`probe_dump.mjs`（解载荷）。

**一个坑**：1.21.1 进 `configuration` 之后不再可靠地发 `login` 事件。
登录成功要用 `meta.state === 'login' && meta.name === 'success'` 判定，
否则会误报"没登录"，其实已经进 configuration 了。

---

## 8. 换服务器的检查清单

- [ ] `probe.mjs` 跑通，确认版本 / 是否离线模式 / 是否 NeoForge
- [ ] 若是 NeoForge：重新抓 `channel-capture.json` 与 `channel-specs.json`
- [ ] 若需 AuthMe：设 `BOT_PW`，确认登录守卫在日志里打了 `>> /login`
- [ ] 若是正版验证：放弃协议 bot 路线（改用真客户端 + 模组 / JsMacros 类方案）
- [ ] `nodes` 依赖版本按新服协议对齐，重打补丁并验证 `problem inflating chunk` 不出现
- [ ] 用 `move_to` + 回读坐标做一次端到端验证
