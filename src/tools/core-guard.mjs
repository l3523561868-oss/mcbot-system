#!/usr/bin/env node
/**
 * core-guard.mjs — 核心保护闸门
 *
 * 三件事：
 *   1) 指纹校验：核心文件被改动 → 失败，必须显式 `--update -m "原因"` 重新签入；
 *   2) 依赖方向检查：core 不得依赖业务/插件，addon 不得 import 核心业务文件；
 *   3) 体积守卫：核心文件相对上次签入增长 > 阈值时告警（防"顺手加功能"导致核心膨胀）。
 *
 * 用法：
 *   node src/tools/core-guard.mjs                        # 校验（CI / 提交前跑）
 *   node src/tools/core-guard.mjs --update -m "原因"     # 显式放行并记录原因
 *   node src/tools/core-guard.mjs --json                 # 机器可读
 *
 * 退出码：0 通过；1 失败。
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const LOCK = path.join(ROOT, "src", "bot", "core", "CORE.lock");
const GROWTH_LIMIT = 1.05;   // 核心文件增长超过 5% 告警

/** tier=core：改动必须 --update；tier=stable：同样需签入，但允许合理演进 */
const FIXED = [
  { path: "src/bot/capture/channel-capture.json", tier: "core" },
  { path: "src/bot/capture/known-packs-real.json", tier: "core" },
  { path: "src/bot/channel-specs.json", tier: "core" },
  { path: "src/bot/forge-live.mjs", tier: "stable" },
  { path: "src/console/console.py", tier: "stable" },
  { path: "src/console/adapters.py", tier: "stable" },
  { path: "src/console/index.html", tier: "stable" },
];

// core/ 下所有 .mjs 自动纳入保护：新增核心文件不会因为"忘了登记"而漏保护
const CORE_DIR = path.join(ROOT, "src", "bot", "core");
const AUTO = (fs.existsSync(CORE_DIR) ? fs.readdirSync(CORE_DIR) : [])
  .filter((f) => f.endsWith(".mjs"))
  .sort()
  .map((f) => ({ path: `src/bot/core/${f}`, tier: "core" }));

const PROTECTED = [...AUTO, ...FIXED];

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const update = args.includes("--update");
const reason = (() => {
  const i = args.indexOf("-m");
  return i >= 0 && args[i + 1] ? args[i + 1] : "";
})();

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const lines = (p) => fs.readFileSync(p, "utf8").split("\n").length;

function loadLock() {
  try { return JSON.parse(fs.readFileSync(LOCK, "utf8")); } catch { return { version: 1, files: {} }; }
}

const lock = loadLock();
const report = { ok: true, changed: [], missing: [], added: [], grown: [], lint: [] };

for (const item of PROTECTED) {
  const abs = path.join(ROOT, item.path);
  if (!fs.existsSync(abs)) { report.missing.push(item.path); report.ok = false; continue; }
  const h = sha(abs);
  const prev = lock.files[item.path];

  if (!prev) { report.added.push({ path: item.path, tier: item.tier, sha256: h, lines: lines(abs) }); continue; }
  if (prev.sha256 !== h) {
    const grow = prev.lines ? lines(abs) / prev.lines : 1;
    report.changed.push({ path: item.path, tier: item.tier, from: prev.lines, to: lines(abs),
      delta: lines(abs) - (prev.lines || 0), sha256: h });
    if (grow > GROWTH_LIMIT) report.grown.push({ path: item.path, ratio: grow, tier: item.tier });
  }
}

// ---- 依赖方向检查 ----
function scanImports(rel, rules) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  const src = fs.readFileSync(abs, "utf8");
  const imports = [...src.matchAll(/^\s*import\s+[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  for (const imp of imports) {
    for (const [re, msg] of rules) {
      if (re.test(imp)) report.lint.push({ file: rel, import: imp, message: msg });
    }
  }
}

const coreDir = path.join(ROOT, "src", "bot", "core");
for (const f of fs.existsSync(coreDir) ? fs.readdirSync(coreDir).filter((x) => x.endsWith(".mjs")) : []) {
  scanImports(`src/bot/core/${f}`, [
    [/forge-live/, "core 不得依赖业务主文件 forge-live.mjs"],
    [/\/addons\//, "core 不得依赖 addons/"],
    [/^node:/, "core 应保持零依赖（避免使用 node: 前缀内置模块）"],
  ]);
}
const addonDir = path.join(ROOT, "src", "bot", "addons");
for (const f of fs.existsSync(addonDir) ? fs.readdirSync(addonDir).filter((x) => x.endsWith(".mjs")) : []) {
  scanImports(`src/bot/addons/${f}`, [
    [/forge-live/, "addon 不得直接 import 核心业务文件，应通过 ctx 契约"],
  ]);
}
for (const it of report.lint) report.ok = false;

// ---- --update：重新签入 ----
if (update) {
  if (!reason) {
    console.error("[guard] --update 必须带 -m \"原因\"，用于在 CORE.lock 里记录为什么动核心");
    process.exit(1);
  }
  const files = {};
  for (const item of PROTECTED) {
    const abs = path.join(ROOT, item.path);
    if (!fs.existsSync(abs)) continue;
    files[item.path] = { tier: item.tier, sha256: sha(abs), lines: lines(abs) };
  }
  const out = {
    version: 1,
    updatedAt: new Date().toISOString(),
    reason,
    growthLimit: GROWTH_LIMIT,
    files,
  };
  fs.writeFileSync(LOCK, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`[guard] 已签入 ${Object.keys(files).length} 个受保护文件\n        原因：${reason}`);
  process.exit(0);
}

// ---- 输出 ----
const problems = [...report.missing, ...report.changed.map((c) => c.path), ...report.lint.map((l) => `${l.file}: ${l.import}`)];

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("[guard] 核心保护检查");
  if (report.missing.length) {
    console.log("  ✗ 缺失受保护文件：");
    report.missing.forEach((p) => console.log("      " + p));
  }
  if (report.added.length) {
    console.log("  · 未签入的新文件（首次运行正常）：");
    report.added.forEach((a) => console.log(`      ${a.path} (${a.tier}, ${a.lines} 行)`));
  }
  if (report.changed.length) {
    console.log("  ✗ 核心文件被改动（需 --update -m \"原因\"）：");
    report.changed.forEach((c) => console.log(`      ${c.path}  ${c.from}→${c.to} 行 (${c.delta >= 0 ? "+" : ""}${c.delta}, ${c.tier})`));
  }
  if (report.grown.length) {
    console.log("  ! 核心文件明显变胖（顺手加功能的信号）：");
    report.grown.forEach((g) => console.log(`      ${g.path}  ×${g.ratio.toFixed(2)}`));
  }
  if (report.lint.length) {
    console.log("  ✗ 依赖方向违规：");
    report.lint.forEach((l) => console.log(`      ${l.file} → ${l.import}：${l.message}`));
  }
  console.log(report.ok && !report.changed.length && !report.added.length
    ? "  ✓ 通过：核心与上次签入一致"
    : (report.ok ? "  · 有新文件待签入" : "  ✗ 未通过"));
}

process.exit(report.ok && report.changed.length === 0 && report.added.length === 0 ? 0 : 1);
