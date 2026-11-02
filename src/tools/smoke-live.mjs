#!/usr/bin/env node
/**
 * smoke-live.mjs — 真服回归（最后一道验证）
 *
 * 起一只临时 bot，连到真实服务器，断言四件事后退出：
 *   1) 握手    ✅ 协商成功（且没有 modded_network_setup_failed）
 *   2) 注册表  [registry] minecraft:item …注入/修正 N
 *   3) 在线    GET /state → online:true
 *   4) 附加模块 [addon] 共加载 N 个
 *
 * 用法：
 *   node src/tools/smoke-live.mjs frp-fun.com:30177            # 默认用户名 smoke_test
 *   node src/tools/smoke-live.mjs 192.168.1.20:54815 bot_probe --timeout 120
 *
 * 退出码：0 通过；1 失败（会打印缺失项与最后若干行日志）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const BOT_DIR = path.join(ROOT, "src", "bot");

const argv = process.argv.slice(2);
const target = argv.find((a) => a.includes(":") && !a.startsWith("-"));
const timeoutArg = argv.indexOf("--timeout");
const TIMEOUT_S = timeoutArg >= 0 ? Number(argv[timeoutArg + 1] || 120) : 120;
const nameArg = argv.find((a) => !a.includes(":") && !a.startsWith("-") && !/^\d+$/.test(a));

if (!target) {
  console.error("[smoke] 用法：node src/tools/smoke-live.mjs <host:port> [name] [--timeout 秒]");
  process.exit(1);
}
const [HOST, PORT] = [target.slice(0, target.lastIndexOf(":")), Number(target.slice(target.lastIndexOf(":") + 1))];
const USER = nameArg || "smoke_test";

// ---- 通道表：优先私有抓包 ----
const privateCap = path.join(BOT_DIR, "capture", "private-channel-capture.json");
const sampleCap = path.join(BOT_DIR, "capture", "channel-capture.json");
const capPath = fs.existsSync(privateCap) ? privateCap : sampleCap;
const capCount = (() => { try { return JSON.parse(fs.readFileSync(capPath, "utf8")).length; } catch { return 0; } })();
if (capCount < 100) {
  console.error(`[smoke] 通道表只有 ${capCount} 条（${path.basename(capPath)}），是样本，先抓真实的：见 docs/01-部署流程/05`);
  process.exit(1);
}

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const bridge = await freePort();
  console.log(`[smoke] 目标 ${HOST}:${PORT}  用户 ${USER}`);
  console.log(`[smoke] 通道表 ${path.relative(ROOT, capPath)}（${capCount} 条）  桥端口 ${bridge}`);

  const env = {
    ...process.env,
    MC_CAPTURE: capPath,
    BRIDGE_PORT: String(bridge),
    BOT_PW: "",
    COMBAT_OFF: "1",
    XP_GUARD: "0",
    CHAT_MONITOR_OFF: "1",
  };
  delete env.ADDON_GAMEMODE;

  const child = spawn(process.execPath, ["forge-live.mjs", HOST, String(PORT), USER], {
    cwd: BOT_DIR, env, stdio: ["ignore", "pipe", "pipe"],
  });

  const lines = [];
  const marks = { handshake: false, registry: false, addon: false, failed: false };
  let online = false;

  const onLine = (buf) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > 400) lines.shift();
      if (line.includes("✅ 协商成功")) marks.handshake = true;
      if (line.includes("❌ 协商失败") || line.includes("modded_network_setup_failed")) marks.failed = true;
      if (line.includes("[registry] minecraft:item") && line.includes("注入/修正")) marks.registry = true;
      if (line.includes("[addon] 共加载")) marks.addon = true;
      console.log("  " + line);
    }
  };
  child.stdout.on("data", onLine);
  child.stderr.on("data", onLine);

  const started = Date.now();
  const deadline = started + TIMEOUT_S * 1000;

  while (Date.now() < deadline) {
    await sleep(2000);
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${bridge}/state`);
      const st = await r.json();
      if (st && st.online) { online = true; break; }
    } catch { /* 桥还没起来 */ }
  }

  await sleep(2500);   // 让注册表注入日志落地

  const checks = [
    ["握手（协商成功，无 setup_failed）", marks.handshake && !marks.failed],
    ["注册表（minecraft:item 注入/修正）", marks.registry],
    ["在线（/state online=true）", online],
    ["附加模块加载", marks.addon],
  ];

  console.log("\n[smoke] 结果：");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "✓" : "✗"} ${label}`);
    if (!pass) ok = false;
  }

  try { child.kill(); } catch {}
  await sleep(500);
  if (child.exitCode === null && process.platform === "win32") {
    try { spawn("taskkill", ["/F", "/PID", String(child.pid)], { stdio: "ignore" }); } catch {}
  }

  if (!ok) {
    console.log("\n[smoke] 最后 12 行日志：");
    lines.slice(-12).forEach((l) => console.log("  " + l));
  } else {
    console.log(`\n[smoke] ✅ 通过（耗时 ${Math.round((Date.now() - started) / 1000)}s）`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke] 异常：" + e.message);
  process.exit(1);
});
