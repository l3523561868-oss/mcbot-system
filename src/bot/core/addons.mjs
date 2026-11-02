/**
 * core/addons.mjs — 附加模块加载器（**受保护**）
 *
 * 约定：src/bot/addons/*.mjs，每个文件导出一个 setup(ctx)（默认导出或具名导出均可）。
 * ctx 提供：on / registerAction / log / bot() / config / contractVersion
 *
 * 隔离原则：
 *   - 单个 addon 加载失败只打印，不影响其他 addon，更不影响核心；
 *   - addon 不得 import forge-live.mjs（core-guard 会检查）；
 *   - ctx.bot() 拿到的是当前 bot 实例（重连后会变，所以必须是函数而不是对象）。
 */
import fs from "fs";
import path from "path";
import { on, registerAction, CONTRACT_VERSION } from "./contract.mjs";

export async function loadAddons({ dir, ctx, log = console.log }) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.startsWith("_")).sort();
  const loaded = [];

  for (const file of files) {
    const full = path.join(dir, file);
    const label = file.replace(/\.mjs$/, "");
    try {
      const mod = await import(urlOf(full));
      const setup = mod.default || mod.setup;
      if (typeof setup !== "function") {
        log(`[addon] ${label}: 未导出 setup()，跳过`);
        continue;
      }
      await setup({
        ...ctx,
        on: (event, fn, opts = {}) => on(event, fn, { ...opts, label }),
        registerAction: (name, fn, opts = {}) => registerAction(name, fn, { ...opts, label }),
        config: mod.config || {},
        contractVersion: CONTRACT_VERSION,
      });
      loaded.push(label);
      log(`[addon] 已加载 ${label}`);
    } catch (e) {
      log(`[addon] ${label} 加载失败（已隔离）：${e && e.message ? e.message : e}`);
    }
  }
  return loaded;
}

function urlOf(p) {
  // Windows 盘符路径要转成 file:// URL，否则 import() 会当成裸模块名
  const abs = path.resolve(p).replace(/\\/g, "/");
  return abs.startsWith("/") ? `file://${abs}` : `file:///${abs}`;
}
