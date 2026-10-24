# node_modules 补丁说明

本目录存放对 `node_modules` 内第三方库的手动修改备份。依赖重装（`npm install`）后这些改动会丢失，运行 `node apply-patches.mjs` 一键恢复。

## 补丁清单

### 1. minecraft-protocol/src/client.js

改动内容（两处）：

1. **`_hasBundlePacket = false`**（补丁1，历史遗留）
   - 位置：构造函数
   - 作用：禁用 bundle 缓存。bundle 缓存未闭合时会无限积压（keep_alive 被吞 → 30s 超时踢）。
   - 效果：所有包（含 bundle_delimiter）直接 emit。

2. **`packetFilter` Transform**（补丁2，2026-10-16 新增）
   - 位置：构造函数 + 4 个 pipe 点（deserializer error 恢复、state setter 的 unpipe/pipe、setCompressionThreshold）
   - 作用：在 decompressor → deserializer 之间插入过滤器，丢弃 play 阶段的 `window_items`(0x13) 包。
   - 原因：Youer 服务器发的 window_items 包 items 数组 count 字段错位（读到 44149143 > 0xffffff 上限），protodef 抛 "array size is abnormally large" → 聊天管道失效 + 30s 超时踢。bot_two 账号不触发（无 speak 权限，服务器不发该包），bot_one 账号必现。
   - 关键实现细节：Transform 的 `transform` 必须用**普通函数**（`this.push` 需要指向 Transform 实例），用 `const self = this` 闭包引用 Client 的 `protocolState`。箭头函数会导致 `this.push is not a function`。

## 恢复方法

```bash
cd server-bot
node apply-patches.mjs
```

## 注意事项

- 补丁文件 = 修改后的**完整文件**（非 diff），恢复时直接覆盖。
- 若升级 minecraft-protocol 版本，需重新确认补丁位置是否有效。
- 崩溃包定位方法：在 client.js 的 packetFilter 里加 `console.log` 打印 chunk[0]（packet id），或在 protodef serializer.js 的 FullPacketParser._transform 的 `cb(e)` 前打印 `chunk.toString('hex')` 抓崩溃包原始字节。

## 3. 手机端「bot 一直离线」的根因（2026-10-20 定位）

**现象**（Termux 上 `bot-8801.log`）：

```
problem inflating chunk
uncompressed length 47627
compressed length 4479
TypeError: Cannot read properties of undefined (reading 'value')
    at Object.simplify (prismarine-nbt/nbt.js:186:25)
    at prismarine-registry/lib/pc/index.js:71:91
    at mineflayer/lib/plugins/game.js:97:18 (loadDimensionCodec)
```

**真实链路**：

1. 目标服务器（NeoForge 1.21.1）登录阶段下发三个超大包：
   `unlock_recipes`(0x41, ~1.8MB)、`declare_recipes`(0x77, ~3MB)、`advancements`(0x74, ~3MB)
2. minecraft-protocol 1.68 的 1.21.1 结构定义与服务器实际格式不匹配 → **解析读错字节数**
3. → **TCP 流错位**，后续所有包都从错误偏移开始解析
4. → zlib 解压失败（`problem inflating chunk`）→ NBT 解析拿到的不是 NBT
5. → `prismarine-nbt` / `prismarine-registry` 没有空值保护 → 抛 TypeError → **进程退出**
6. → 控制台显示「离线」

**所以补丁做了两件事**：

| 补丁 | 作用 |
|---|---|
| `minecraft-protocol/src/client.js` | ① `_hasBundlePacket = false`（防 keep_alive 被吞→30s 超时踢）<br>② 插入 `packetFilter`，在 play 阶段**直接丢弃 0x41 / 0x77 / 0x74**，让 TCP 流保持对齐 |
| `prismarine-nbt/nbt.js`、`prismarine-registry/lib/pc/{index,transforms}.js` | 加空值保护，个别条目解析不出来时跳过而不是整条链崩 |

**判断补丁是否生效**：日志里必须能 `grep` 到 `✅ 协商成功`，且不再出现 `problem inflating chunk`。

> ⚠️ `npm install` / `npm ci` 会把这些文件还原成上游原版，**必须重新执行 `node apply-patches.mjs`**。
