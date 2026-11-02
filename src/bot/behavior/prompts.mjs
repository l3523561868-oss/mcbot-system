/**
 * behavior/prompts.mjs — 提示词层（行为层的一半：**动作 + 提示词同层**）
 *
 * 设计要点：
 *   1. 代码里**不内置任何提示词**（默认全空），需要时再写；
 *   2. 三个来源，优先级从高到低：环境变量 → prompts.local.mjs（本地、不入库）→ 内置默认（空）；
 *   3. 纯函数：给定名字和变量，返回最终字符串；不含 IO、不含状态。
 *
 * 用法：
 *   prompt("chat.reply", { user, speaker, content, ctx })   → "" 表示该功能未启用
 *
 * 想启用：在同目录建 prompts.local.mjs（已 gitignore）
 *   export default {
 *     "llm.system": "你是……",
 *     "chat.reply": "玩家 {speaker} 说：{content}，请用一句话回答。",
 *   }
 * 或用环境变量 PROMPT_LLM_SYSTEM / PROMPT_CHAT_REPLY。
 */

/** 内置默认一律为空：不预设任何"人设/语气/禁忌" */
export const DEFAULTS = Object.freeze({
  "llm.system": "",
  "chat.reply": "",
  "ai.say": "",
});

let local = {};
try {
  // 可选文件：不存在时忽略（动态 import 失败不影响核心）
  const mod = await import("./prompts.local.mjs");
  local = (mod && (mod.default || mod.PROMPTS)) || {};
} catch { /* 没有本地覆盖，正常 */ }

const envKey = (name) => "PROMPT_" + String(name).toUpperCase().replace(/[.\-]/g, "_");

function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
}

/**
 * @param {string} name 提示词名（如 "chat.reply"）
 * @param {object} [vars] 占位符变量，模板里写 {speaker} 这种
 * @returns {string} 最终提示词；空串表示未配置
 */
export function prompt(name, vars = {}) {
  const raw = process.env[envKey(name)] ?? local[name] ?? DEFAULTS[name] ?? "";
  return fill(raw, vars).trim();
}

export function hasPrompt(name) {
  return prompt(name) !== "";
}

export function promptNames() {
  return [...new Set([...Object.keys(DEFAULTS), ...Object.keys(local)])];
}
