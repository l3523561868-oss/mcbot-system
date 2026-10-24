# capture/ — 通道抓包（**仓库内为示意样本**）

这个目录放的是"从真实客户端抓到的协议协商数据"。**它不是可选项**：
NeoForge 服务端在 `configuration` 阶段要求客户端上报自己的通道表，缺了会被踢
（提示"服务器装了 NeoForge 但你没装"）。

## 仓库里的文件是样本，不是真数据

| 文件 | 作用 | 仓库内状态 |
|---|---|---|
| `channel-capture.json` | 通道表本体（`proto / id / version / flow / optional`） | **12 条示意样本**（`examplemod:*` / `samplelib:*` / `anothermod:*`） |
| `channel-specs.json`（上层目录） | 通道名 → 版本号映射 | **8 条示意样本** |
| `known-packs-real.json` | known packs 协商用 | 仅原版 `minecraft:core 1.21.1`，无隐私 |
| `packet-seq-real.json` | 登录阶段的包顺序参考 | 已裁剪为通用包序，不含模组特征 |

样本能让读者看懂**结构**与**处理方式**，但**无法用于连接任何真实服务器**：
真实的 NeoForge 整合服通常有上千条通道，且名字与版本因包而异。

`forge-live.mjs` 启动时会**直接拦截并退出**（不再只是警告）：

```
[!] 通道表只有 12 条，判定为仓库自带的“示意样本”。
    直接连任何真实 NeoForge 服务器都会被踢（服务端会提示你没装 NeoForge）。
    解决：按 docs/01-部署流程/05-获取整合包与抓包.md 生成真实通道表，
          或用 MC_CAPTURE=/path/to/channel-capture.json 指向已抓好的文件。
    只做本地链路演示：设 ALLOW_SAMPLE=1 可跳过本检查。
```

`MIN_CHANNELS`（默认 100）可调阈值；仅做本地链路演示时才用 `ALLOW_SAMPLE=1`。

## 怎么生成自己的抓包

1. **准备真实客户端**：与目标服务器**完全一致**的整合包（同版本 NeoForge + 同模组）。
2. **进服并抓包**：在客户端侧记录 `configuration` 阶段客户端发出的
   `neoforge:register`（或 `minecraft:register`）自定义负载，解出其中每条
   `(命名空间:通道名, 版本号, 方向, 是否可选)`。
   - 参考实现：`src/tools/probe_forge.mjs` 展示了如何主动发/收这类包；
   - 也可用代理抓包（如 mitm 类工具 / 模组自带 debug）记录原始字节再解析。
3. **按本目录格式落盘**：

```json
[{ "proto": "PLAY", "id": "yourmod:your_channel", "version": "1.0.0",
   "flow": "CLIENTBOUND", "optional": false }]
```

4. **补版本映射**（可留空，代码会退回 `"1"`）：`channel-specs.json`
   `{ "yourmod:your_channel": { "v": "1.0.0", "f": 1 } }`（`f`：0=上行 1=下行 null=未知）。
5. **验证**：启动后日志应出现

```
>> C->S neoforge:register（N 通道）      ← N 与你文件条数一致
✅ 协商成功
```

6. 也可用环境变量指向别的抓包文件：`MC_CAPTURE=/path/to/capture.json node forge-live.mjs ...`

> 换服务器 / 换整合包 = 必须重新抓。抓包属于客户端侧数据，注意不要把自己服务器的
> 地址、账号、聊天记录一起提交到公开仓库。
