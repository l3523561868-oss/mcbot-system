# 配置目录

**这里只有模板，真实配置不进仓库。** 复制成真文件后填自己的值：

```bash
# 控制台读的 bot 注册表
cp bots.example.json ../src/console/bots.json

# 大脑（不接 LLM 可跳过；缺文件时 brain.py 只做规则解析）
cp brain.example.json ../src/console/brain.json

# 多提供商（控制台「⚙ API 提供商」页也能力编辑）
mkdir -p ../src/console/data
cp providers.example.json ../src/console/data/providers.json
```

bot 的 AuthMe 口令有两种放法，选一：

| 方式 | 位置 | 适合 |
|---|---|---|
| 环境变量 | 启动命令里 `BOT_PW=...` | 手动/bat 启动 |
| `.env` | `src/bot/.env` | 长期运行；已被 `.gitignore` 排除 |

## 字段说明

### `bots.json`

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 控制台内部唯一 ID |
| `name` | ✅ | 显示名，也是游戏内 `@名字` 的目标 |
| `kind` | ✅ | `protocol` / `client` / `reporter` |
| `base` | ✅ | bot 的 HTTP 地址 |
| `bridge_port` | 建议 | 用于判断进程是否在跑 |
| `say_mode` | 可选 | `say`（公屏）/ `me`（`/me` 动作，绕过部分聊天插件） |
| `account` / `password` | 可选 | 仅 GUI/`--manage` 拉起进程时使用 |

### `brain.json`

| 字段 | 说明 |
|---|---|
| `mode` | `llm`（推荐）/ `agent`（实测不可用，见文件内 note） |
| `llm.url` | OpenAI 兼容 chat completions 端点 |
| `llm.key` | API Key |
| `llm.model` | 模型名 |
| `llm.max_tokens` | 回复长度上限（控制台场景建议 ≤200） |

### `providers.json`

支持多提供商，控制台可切换默认、统计用量、查余额（内置适配常见开放端点；
官方 OpenAI/Anthropic 的普通 key 查不了余额，需手动填 `balance_url`）。
