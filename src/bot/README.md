# src/bot — 协议 bot 客户端（Node）

不启动游戏客户端，用 `minecraft-protocol` + `mineflayer` 直接与服务端握手。

| 文件 | 说明 |
|---|---|
| `forge-live.mjs` | 主程序：NeoForge 握手伪造层、通道注册、AuthMe 守卫、寻路/工作/背包/传送、HTTP 决策桥（104 动作） |
| `capture/channel-capture.json` | **致命依赖**：NeoForge 通道表（仓库内为 12 条示意样本） |
| `capture/known-packs-real.json` / `packet-seq-real.json` | known packs 与包序对齐 |
| `channel-specs.json` | 通道版本号映射（仓库内为 8 条示意样本） |
| `patches/` | 5 个 node_modules 完整替换文件 |
| `apply-patches.mjs` | 补丁恢复器 |

## 安装

```bash
npm install
node apply-patches.mjs      # 必须！输出「完成：恢复 5 个补丁文件」
```

## 启动

```bash
BOT_PW='<AuthMe口令>' BOT_REG=0 COMBAT_OFF=1 XP_LOW_LEVEL=0 BRIDGE_PORT=8801 \
  node forge-live.mjs <host> <port> <username>
```

| 环境变量 | 建议 | 说明 |
|---|---|---|
| `BOT_PW` | 必填 | AuthMe 口令；为空会显式报错 |
| `BOT_REG` | `0` | `1` = 首次注册 |
| `COMBAT_OFF` | `1` | 关自动战斗（新号必开） |
| `XP_LOW_LEVEL` | `0` | 关低等级长途赶路 |
| `BRIDGE_PORT` | `8801` | 决策桥端口 |
| `RECONNECT_STAGGER` | 毫秒 | 多实例重连错峰 |
| `CHAT_MONITOR_OFF` / `WAYSTONE_EYE_OFF` | `1` | 关对应的周期性动作 |

## 决策桥

- `GET /state` → 在线状态、坐标、血量、饥饿、等级、Ping、背包摘要、聊天缓冲、48 格实体
- `POST /` → `{"type": "<动作名>", ...}`，共 104 个动作

`say` 允许离线入队，登录后自动补发。

## 验收

日志必须出现：

```
>> C->S neoforge:register（N 通道）
✅ 协商成功
```

协议细节与补丁原理见 [../../docs/06-协议层与NeoForge协商.md](../../docs/06-协议层与NeoForge协商.md)。
