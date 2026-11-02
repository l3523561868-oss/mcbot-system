/**
 * behavior/chat-reply.mjs — 聊天接话（行为层，原 core 内实现迁入）
 *
 * 与提示词同层：判定"该不该接话"的策略 + 提示词模板都在 behavior/ 下；
 * 协议层只提供原语（bot.say / chat.recent / llm.ask），不关心说什么。
 *
 * 关闭：CHAT_MONITOR_OFF=1（手机端默认关，会定时调 LLM）。
 * 未配置提示词（prompts.mjs 的 "chat.reply" 为空）时：只回答经验/位置这类事实问题，不做 LLM 接话。
 */
import { prompt } from "./prompts.mjs";

const INTERVAL = 12000;          // 每 12 秒扫描一次
const GLOBAL_CD = 30000;         // 全局冷却
const PLAYER_CD = 45000;         // 同玩家冷却
const NAME_RE = /(^|\s)(bot|机器人|ai)\b/i;
const XP_RE = /经验|等级|级别|xp|几级|多少级|level/i;
const LOC_RE = /在哪|位置|坐标|你在哪|哪里|位于/i;
const Q_RE = /[?？]|吗|呢|怎么|什么|多少|几$|几点|谁/i;
const SYS_HINTS = ["joined the game", "left the game", "made the advancement", "[玩家系统]",
  "清理", "垃圾桶", "Tempus fugit", "is now sleeping", "welcome", "欢迎"];

export default function setup(ctx) {
  if (process.env.CHAT_MONITOR_OFF === "1") {
    ctx.log("[behavior:chat] 已关闭（CHAT_MONITOR_OFF=1）");
    return;
  }
  const bot = ctx.service("bot");
  const chat = ctx.service("chat");
  const llm = ctx.service("llm");
  if (!bot || !chat) { ctx.log("[behavior:chat] 缺少 chat/bot 服务，未启用"); return; }

  const me = String(bot.user ? bot.user() : "").toLowerCase();
  let cursor = chat.lastSeq ? chat.lastSeq() : 0;
  let lastGlobal = 0;
  const lastByPlayer = {};
  let warnedNoPrompt = false;

  function reply(text, who, kind) {
    try { bot.say("@".repeat(0) + text); } catch (e) { ctx.log("[behavior:chat] 发送失败：" + e.message); }
    ctx.log(`[chat] 回应 ${who}（${kind}）`);
  }

  function respond(kind, speaker, content, recent) {
    const b = bot.get();
    if (kind === "xp") {
      const xp = (b && b.experience) || {};
      const lvl = xp.level != null ? xp.level : 0;
      const prog = Math.round((xp.progress || 0) * 100);
      reply(`@${speaker} 我当前经验等级 Lv.${lvl}（本级进度 ${prog}%）`, speaker, "xp");
      return;
    }
    if (kind === "loc") {
      const p = b.entity.position;
      reply(`@${speaker} 我在 ${Math.round(p.x)}, ${Math.round(p.z)}（Y ${Math.round(p.y)}）`, speaker, "loc");
      return;
    }

    // name / 问句 → LLM 接话（提示词未配置则跳过）
    const tpl = prompt("chat.reply", {
      user: me,
      speaker,
      content,
      ctx: recent.filter((r) => /<\w+>/.test(r.text || "")).slice(-5).map((r) => r.text).join("\n"),
    });
    if (!tpl) {
      if (!warnedNoPrompt) {
        warnedNoPrompt = true;
        ctx.log("[behavior:chat] 未配置提示词 chat.reply，仅回答经验/位置类问题（可在 behavior/prompts.local.mjs 添加）");
      }
      return;
    }
    if (!llm) return;
    Promise.resolve(llm.ask(tpl)).then((text) => {
      if (!text) return;
      const clean = String(text).replace(/[\r\n]+/g, " ").trim().slice(0, 80);
      if (clean) setTimeout(() => { if (bot.isOnline()) bot.say(clean); }, 600);
    }).catch((e) => ctx.log("[behavior:chat] LLM 失败：" + e.message));
  }

  function tick() {
    if (!bot.isOnline() || !bot.isAuthed()) return;
    const now = Date.now();
    if (now - lastGlobal < GLOBAL_CD) return;

    const fresh = chat.recent(50).filter((c) => (c.seq || 0) > cursor);
    cursor = chat.lastSeq ? chat.lastSeq() : cursor;
    if (!fresh.length) return;

    for (const c of fresh) {
      const text = c.text || "";
      if (!text) continue;
      if (new RegExp("<" + (me || "____") + ">").test(text)) continue;   // 自己说的
      if (SYS_HINTS.some((h) => text.includes(h))) continue;             // 系统消息
      if (/bot[_-]?one|bot[_-]?two/i.test(text)) continue;
      const m = text.match(/<(\w+)>[:：]?\s*(.*)/);
      if (!m) continue;
      const speaker = m[1];
      const content = (m[2] || "").trim();
      if (!content || speaker.toLowerCase() === (me || "")) continue;
      if (now - (lastByPlayer[speaker] || 0) < PLAYER_CD) continue;

      let kind = null;
      if (XP_RE.test(content)) kind = "xp";
      else if (LOC_RE.test(content)) kind = "loc";
      else if (NAME_RE.test(content)) kind = "name";
      else if (Q_RE.test(content) && /你(?!们)/.test(content)) kind = "q";
      if (!kind) continue;

      lastByPlayer[speaker] = now;
      lastGlobal = now;
      respond(kind, speaker, content, fresh);
      break;
    }
  }

  const timer = setInterval(tick, INTERVAL);
  timer.unref?.();
  ctx.log(`[behavior:chat] 启动（每 ${INTERVAL / 1000}s 扫描；提示词 ${prompt("chat.reply") ? "已配置" : "未配置"}）`);
}
