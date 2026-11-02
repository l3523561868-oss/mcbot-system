/**
 * behavior/actions.mjs — 行为层动作（与提示词同层：动作 + 它用的提示词放在一起）
 *
 * 与 addons/ 的区别：
 *   - behavior/ 是**产品自带行为**（随仓库发布、默认加载、受保护）；
 *   - addons/ 是**可插拔扩展**（第三方/临时功能，失败只影响自己）。
 *
 * 协议层（forge-live.mjs）只负责把未知动作转给这里，不关心具体做什么。
 */
import { prompt, hasPrompt } from "./prompts.mjs";

export default function setup(ctx) {
  // 让 bot 用 LLM 生成一句话发出去；提示词未配置时明确拒绝，不假装成功
  ctx.registerAction("ai_say", async (args) => {
    const llm = ctx.service("llm");
    const bot = ctx.service("bot");
    if (!llm || !bot || !bot.isOnline()) return { ok: false, error: "bot 未在线或缺少 llm 服务" };

    const tpl = prompt("ai.say", { text: String(args.text || "").slice(0, 200) });
    if (!tpl) {
      return { ok: false, error: "未配置提示词 ai.say（behavior/prompts.local.mjs 或 PROMPT_AI_SAY）" };
    }
    const reply = await llm.ask(tpl);
    if (!reply) return { ok: false, error: "LLM 无响应" };
    const clean = String(reply).replace(/[\r\n]+/g, " ").trim().slice(0, 120);
    if (clean) bot.say(clean);
    return { ok: true, sent: clean };
  });

  // 自检：提示词配置了哪些、行为层是否就绪
  ctx.registerAction("behavior_status", async () => ({
    ok: true,
    prompts: {
      "llm.system": hasPrompt("llm.system"),
      "chat.reply": hasPrompt("chat.reply"),
      "ai.say": hasPrompt("ai.say"),
    },
  }));

  ctx.contributeState("behavior", () => ({
    chatReply: hasPrompt("chat.reply"),
    aiSay: hasPrompt("ai.say"),
  }));

  ctx.log("[behavior] 动作已注册：ai_say · behavior_status");
}
