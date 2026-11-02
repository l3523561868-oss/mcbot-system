/**
 * addons/example-gamemode.mjs — 示例附加模块
 *
 * 作用：进服（spawn）后自动切一次游戏模式。
 * 开关：环境变量 ADDON_GAMEMODE=creative|survival|spectator|adventure，未设置则不生效。
 *
 * 这个文件演示"附加功能如何不动核心就接入"：
 *   - 只依赖 core/contract.mjs 暴露的 ctx，不 import forge-live.mjs；
 *   - 出错被 contract 隔离，不会把核心带崩。
 */
const ALLOWED = new Set(["creative", "survival", "spectator", "adventure"]);
let lastAt = 0;

export default function setup(ctx) {
  const mode = String(ctx.config.mode || process.env.ADDON_GAMEMODE || "").toLowerCase();
  if (!ALLOWED.has(mode)) {
    ctx.log("[addon:gamemode] 未开启（设 ADDON_GAMEMODE=creative 启用）");
    return;
  }

  ctx.on("spawn", ({ bot }) => {
    // 防止短时间内重复执行（重连风暴时 spawn 会连续触发）
    if (Date.now() - lastAt < 15000) return;
    lastAt = Date.now();
    try {
      bot.chat(`/gamemode ${mode}`);
      ctx.log(`[addon:gamemode] 已请求 /gamemode ${mode}`);
    } catch (e) {
      ctx.log(`[addon:gamemode] 发送失败：${e.message}`);
    }
  }, { priority: 10 });

  ctx.registerAction("addon_gamemode", async (args) => {
    const m = String(args.mode || mode).toLowerCase();
    if (!ALLOWED.has(m)) return { ok: false, error: "mode 取值：creative/survival/spectator/adventure" };
    ctx.bot().chat(`/gamemode ${m}`);
    return { ok: true, mode: m };
  });
}
