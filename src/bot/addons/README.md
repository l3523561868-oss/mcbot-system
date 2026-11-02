# addons/ — 附加模块（扩展区）

**三层分工**：

| 层 | 位置 | 性质 | 改动要求 |
|---|---|---|---|
| 协议层 | `forge-live.mjs` | 握手 / 注册表 / 桥 —— 只提供原语 | `core-guard --update` |
| 行为层 | `behavior/` | 产品自带行为（动作 + 提示词同层） | `core-guard --update` |
| 扩展层 | `addons/`（本目录） | 可插拔功能，失败只影响自己 | 随便加 |

**规则：核心（`forge-live.mjs` / `core/`）只提供契约，新功能一律写在这里。**

## 怎么写

```js
// addons/my-feature.mjs
export default function setup(ctx) {
  ctx.on("spawn", ({ bot }) => { /* 进服时做点什么 */ });
  ctx.on("chat",  ({ text }) => { /* 收到聊天 */ });
  ctx.on("tick",  () => { /* 每秒一次，注意轻量 */ });

  ctx.registerAction("my_action", async (args) => {
    return { ok: true, echo: args };
  });

  ctx.log("[my-feature] 已加载");
}
```

加载后即可通过桥调用：

```bash
curl -X POST -d '{"type":"my_action","foo":1}' http://127.0.0.1:8801/
```

## ctx 提供什么

| 成员 | 说明 |
|---|---|
| `on(event, fn, {priority, once})` | 订阅 `spawn` / `death` / `disconnect` / `chat` / `tick` |
| `registerAction(name, fn)` | 注册桥动作（同名不允许覆盖，除非传 `{replace:true}`） |
| `ctx.bot()` | **函数**，返回当前 bot 实例（重连后会换，不要缓存） |
| `ctx.log(msg)` | 带前缀的输出 |
| `ctx.config` | 本文件导出的 `export const config = {...}` |
| `ctx.contractVersion` | 契约版本，便于做兼容判断 |
| `ctx.service(name)` | 取核心能力服务：`bot`（get/goto/say/isAuthed/isOnline）、`items`（findXp/useXp）、`config`（xpSpot/xpLowLevel/version） |
| `ctx.contributeState(key, fn)` | 往 `/state` 加字段，页面/控制台可直接读 |

## 硬性约束（`core-guard` 会检查）

1. ❌ 不要 `import "../forge-live.mjs"` —— 那是核心，内部函数不保证稳定；
2. ❌ 不要直接改 `core/` 下的文件（改了 `core-guard` 会失败，必须显式 `--update` 并说明原因）；
3. ✅ 需要新能力，先在 `core/contract.mjs` 加事件/字段并 **bump `CONTRACT_VERSION`**，再写 addon；
4. ✅ 单个 addon 抛错只会被记录，不会影响其他 addon 与核心（`emit` 内 try/catch 隔离）。

## 生命周期

- 启动时按文件名顺序加载 `addons/*.mjs`（跳过 `_` 开头）；
- 每个文件导出一个函数（默认导出或 `setup`）；
- 加载失败只打印 `[addon] xxx 加载失败（已隔离）`，其余照常运行。

## 现有示例

| 文件 | 作用 | 开关 |
|---|---|---|
| `example-gamemode.mjs` | 进服后自动 `/gamemode <mode>`，并注册 `addon_gamemode` 动作 | `ADDON_GAMEMODE=creative` |
| `xp-guard.mjs` | 经验守护（原核心功能迁入）：低等级用经验物品，否则去淋浴间吸经验球；注册 `xpguard` 动作，并向 `/state` 贡献 `xpguard` 字段 | `XP_GUARD=0` 关闭，`XP_LOW_LEVEL` 调阈值 |
