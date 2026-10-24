#!/usr/bin/env node
/**
 * channels.mjs — 通道表工具（离线、不联网、不读取任何凭证）
 *
 * 只处理你本地已有的 JSON 文件：校验 / 对比 / 合并 / 生成版本表骨架。
 * 不做抓包、不连接服务器、不发任何请求。
 *
 * 用法：
 *   node channels.mjs validate <capture.json> [--spec <channel-specs.json>]
 *   node channels.mjs diff     <a.json> <b.json>
 *   node channels.mjs merge    <a.json> <b.json> [-o out.json]
 *   node channels.mjs spec     <capture.json> [-o channel-specs.json]
 *
 * 退出码：0 = 通过；1 = 有问题
 */
import fs from "fs";
import path from "path";

const PROTO_OK = new Set(["PLAY", "CONFIGURATION", null, undefined]);
const FLOW_OK = new Set(["CLIENTBOUND", "SERVERBOUND", null, undefined]);
const SAMPLE_THRESHOLD = 100;

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function die(msg) {
  console.error(C.red("[x] ") + msg);
  process.exit(1);
}

function readJson(p) {
  if (!fs.existsSync(p)) die(`找不到文件：${p}`);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    die(`解析失败 ${p}: ${e.message}`);
  }
}

const keyOf = (e) => `${e.proto || "?"}|${e.id}`;

function validate(capturePath, specPath) {
  const data = readJson(capturePath);
  if (!Array.isArray(data)) die("通道表必须是 JSON 数组");

  const issues = [];
  const seen = new Map();
  let dup = 0;

  data.forEach((e, i) => {
    const at = `#${i + 1}`;
    if (!e || typeof e !== "object") return issues.push(`${at} 不是对象`);
    if (typeof e.id !== "string" || !e.id.includes(":")) {
      issues.push(`${at} id 非法（应为 命名空间:路径）：${JSON.stringify(e.id)}`);
    }
    if (!PROTO_OK.has(e.proto)) issues.push(`${at} proto 非法：${e.proto}（应为 PLAY / CONFIGURATION）`);
    if (!FLOW_OK.has(e.flow)) issues.push(`${at} flow 非法：${e.flow}（应为 CLIENTBOUND / SERVERBOUND / null）`);
    if (e.version != null && typeof e.version !== "string") issues.push(`${at} version 应为字符串或 null`);
    if (e.optional != null && typeof e.optional !== "boolean") issues.push(`${at} optional 应为布尔值`);

    const k = keyOf(e);
    if (seen.has(k)) dup++;
    else seen.set(k, i);
  });

  const ns = new Set(data.map((e) => String(e.id || "").split(":")[0]).filter(Boolean));
  const byProto = data.reduce((m, e) => ((m[e.proto || "null"] = (m[e.proto || "null"] || 0) + 1), m), {});
  const byFlow = data.reduce((m, e) => ((m[e.flow || "null"] = (m[e.flow || "null"] || 0) + 1), m), {});

  console.log(`文件: ${capturePath}`);
  console.log(`条数: ${data.length}   命名空间: ${ns.size}   重复: ${dup}`);
  console.log(`阶段: ${Object.entries(byProto).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`方向: ${Object.entries(byFlow).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  if (specPath) {
    const spec = readJson(specPath);
    if (typeof spec !== "object" || Array.isArray(spec)) die("版本表应为 { 通道名: {v,f} } 对象");
    const miss = data.filter((e) => e.id && !(e.id in spec)).length;
    console.log(`版本表: ${Object.keys(spec).length} 条，未覆盖 ${miss} 个通道`);
    if (miss > data.length * 0.5) {
      console.log(C.yellow("  ! 版本表覆盖率低于 50%，通道版本会退回默认值，可能协商失败"));
    }
  }

  if (data.length < SAMPLE_THRESHOLD) {
    console.log(C.yellow(`  ! 只有 ${data.length} 条（< ${SAMPLE_THRESHOLD}），很可能是示意样本，连真服会被踢`));
  }
  if (dup) console.log(C.yellow(`  ! 存在 ${dup} 条重复（proto+id 相同）`));

  if (issues.length) {
    console.log(C.red(`\n发现 ${issues.length} 处问题：`));
    issues.slice(0, 20).forEach((s) => console.log("  - " + s));
    if (issues.length > 20) console.log(`  … 其余 ${issues.length - 20} 条省略`);
    return 1;
  }
  console.log(C.green("\n结构校验通过"));
  return 0;
}

function diff(aPath, bPath) {
  const a = readJson(aPath), b = readJson(bPath);
  if (!Array.isArray(a) || !Array.isArray(b)) die("两个文件都必须是 JSON 数组");
  const ka = new Set(a.map(keyOf)), kb = new Set(b.map(keyOf));
  const onlyA = [...ka].filter((k) => !kb.has(k));
  const onlyB = [...kb].filter((k) => !ka.has(k));
  const both = [...ka].filter((k) => kb.has(k));

  console.log(`A: ${aPath}  (${ka.size})`);
  console.log(`B: ${bPath}  (${kb.size})`);
  console.log(`共同: ${both.length}`);
  console.log(C.green(`仅 A 有: ${onlyA.length}`));
  onlyA.slice(0, 15).forEach((k) => console.log("  - " + k));
  if (onlyA.length > 15) console.log(`  … 其余 ${onlyA.length - 15} 条`);
  console.log(C.yellow(`仅 B 有: ${onlyB.length}`));
  onlyB.slice(0, 15).forEach((k) => console.log("  + " + k));
  if (onlyB.length > 15) console.log(`  … 其余 ${onlyB.length - 15} 条`);

  console.log("\n换服后「仅 B 有」的条目通常就要补进你的抓包；「仅 A 有」可能是需要删除的旧通道。");
  return 0;
}

function merge(aPath, bPath, out) {
  const a = readJson(aPath), b = readJson(bPath);
  if (!Array.isArray(a) || !Array.isArray(b)) die("两个文件都必须是 JSON 数组");
  const map = new Map();
  for (const e of [...a, ...b]) {
    const k = keyOf(e);
    if (!map.has(k)) map.set(k, e);
  }
  const merged = [...map.values()];
  fs.writeFileSync(out, JSON.stringify(merged), "utf8");
  console.log(`合并完成：${merged.length} 条（A ${a.length} + B ${b.length}）→ ${out}`);
  console.log("注意：合并结果仍需实际握手验证，顺序可能与服务端期望不一致。");
  return 0;
}

function spec(capturePath, out) {
  const data = readJson(capturePath);
  if (!Array.isArray(data)) die("通道表必须是 JSON 数组");
  const obj = {};
  for (const e of data) {
    if (!e || typeof e.id !== "string") continue;
    obj[e.id] = { v: e.version || "1", f: e.flow === "SERVERBOUND" ? 0 : e.flow === "CLIENTBOUND" ? 1 : null };
  }
  fs.writeFileSync(out, JSON.stringify(obj, null, 1), "utf8");
  console.log(`已生成版本表骨架：${Object.keys(obj).length} 条 → ${out}`);
  console.log("版本号为占位的 \"1\" 时可能协商失败，请用真实版本覆盖。");
  return 0;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name, def) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : def;
  };
  const pos = rest.filter((x, i) => !x.startsWith("-") && rest[i - 1] !== "--spec" && rest[i - 1] !== "-o");

  switch (cmd) {
    case "validate":
      if (!pos[0]) die("用法：channels.mjs validate <capture.json> [--spec <channel-specs.json>]");
      return validate(pos[0], arg("--spec"));
    case "diff":
      if (pos.length < 2) die("用法：channels.mjs diff <a.json> <b.json>");
      return diff(pos[0], pos[1]);
    case "merge":
      if (pos.length < 2) die("用法：channels.mjs merge <a.json> <b.json> [-o out.json]");
      return merge(pos[0], pos[1], arg("-o", "channel-capture.merged.json"));
    case "spec":
      if (!pos[0]) die("用法：channels.mjs spec <capture.json> [-o channel-specs.json]");
      return spec(pos[0], arg("-o", "channel-specs.json"));
    default:
      console.log(`channels.mjs — 通道表离线工具

  node channels.mjs validate <capture.json> [--spec <channel-specs.json>]
  node channels.mjs diff     <a.json> <b.json>
  node channels.mjs merge    <a.json> <b.json> [-o out.json]
  node channels.mjs spec     <capture.json> [-o channel-specs.json]

只读写本地文件，不联网、不接触账号凭证。`);
      return cmd ? 1 : 0;
  }
}

process.exit(main());
