/**
 * addons/xp-guard.mjs — 经验守护（原 core 内实现，现为附加模块）
 *
 * 策略：等级低于阈值 → 先用背包里的经验物品；没有就走到「淋浴间」附近等经验球。
 * 原语全部来自核心服务（ctx.service），本文件不 import forge-live.mjs、不碰协议。
 *
 * 开关：XP_GUARD=0 关闭；阈值 XP_LOW_LEVEL（默认 50）；坐标默认取核心 config 服务的 xpSpot。
 */
export const config = {
  lowLevel: Number(process.env.XP_LOW_LEVEL || 0) || undefined,
};

export default function setup(ctx) {
  const cfg = ctx.service("config") || {};
  const spot = cfg.xpSpot || { x: 262, y: 78, z: -1147, name: "淋浴间" };
  const lowLevel = Number(config.lowLevel || cfg.xpLowLevel || 50);
  const nearRange = 8;

  let enabled = process.env.XP_GUARD !== "0";
  let moving = false;
  let using = false;
  let lastReport = 0;

  const bots = ctx.service("bot");
  const items = ctx.service("items");
  if (!bots) {
    ctx.log("[addon:xp-guard] 缺少 bot 服务，未启用");
    return;
  }

  function check() {
    try {
      if (!enabled) return;
      if (!bots.isOnline() || !bots.isAuthed()) return;
      const bot = bots.get();
      const exp = bot && bot.experience;
      if (!exp || typeof exp.level !== "number") return;   // 经验包还没同步
      if (exp.level >= lowLevel) { moving = false; return; }

      // 1) 优先用背包里的经验瓶/经验颗粒
      if (items && items.findXp()) {
        if (!using) {
          using = true;
          Promise.resolve(items.useXp(64)).then((n) => {
            using = false;
            if (n > 0) bots.say(`[经验] 使用了 ${n} 个经验物品补充经验（当前等级 ${bot?.experience?.level ?? "?"}）`);
          }).catch(() => { using = false; });
        }
        return;
      }

      // 2) 去淋浴间等经验球
      const p = bot.entity.position;
      const dist = Math.hypot(p.x - spot.x, p.z - spot.z);
      if (dist <= nearRange) {
        if (moving) { moving = false; ctx.log("[xp-guard] 已到淋浴间附近，等待吸收经验球"); }
        return;
      }
      if (moving) return;

      moving = true;
      const now = Date.now();
      if (now - lastReport > 60000) {
        lastReport = now;
        bots.say(`[经验] 等级 ${exp.level} 低于 ${lowLevel}，前往淋浴间补充经验（${Math.round(dist)} 格）`);
      }
      ctx.log(`[xp-guard] level=${exp.level} < ${lowLevel}，前往淋浴间 @${spot.x},${spot.z}`);
      bots.goto(spot.x, spot.y, spot.z, 4);

      setTimeout(() => {
        try {
          if (!bots.isOnline()) { moving = false; return; }
          const q = bots.get().entity.position;
          const d2 = Math.hypot(q.x - spot.x, q.z - spot.z);
          if (d2 > nearRange) {
            moving = false;
            ctx.log(`[xp-guard] 尚未到位（剩 ${d2.toFixed(0)} 格），下次检查继续`);
          }
        } catch { moving = false; }
      }, 30000);
    } catch (e) {
      ctx.log("[xp-guard] 失败：" + e.message);
    }
  }

  const timer = setInterval(check, 15000);
  timer.unref?.();

  // 桥动作：兼容原 "xpguard"（查询/开关）
  ctx.registerAction("xpguard", async (args) => {
    if (typeof args.enabled === "boolean") {
      enabled = args.enabled;
      if (!enabled) moving = false;
      ctx.log("[xp-guard] 开关 → " + (enabled ? "开启" : "关闭"));
    }
    const bot = bots.get();
    return {
      ok: true,
      action: "xpguard",
      enabled,
      lowLevel,
      spot,
      level: bot?.experience?.level ?? null,
      moving,
    };
  });

  // /state 里补一份摘要，页面不用额外请求
  ctx.contributeState("xpguard", () => ({ enabled, lowLevel, level: bots.get()?.experience?.level ?? null, moving }));

  ctx.log(`[addon:xp-guard] 已启用（阈值 ${lowLevel}，点 ${spot.x},${spot.z}）`);
}
