#!/usr/bin/env node
/**
 * selftest.mjs — 核心自检（零依赖，20 秒内跑完）
 *
 * 覆盖：线格式纯函数、注册表解析/注入、契约层隔离与分发、addon 装载、核心守卫。
 * 用途：改核心 / 加 addon / 提交前跑一遍，避免"看起来没改坏、实际已坏"。
 *
 * 用法：node src/tools/selftest.mjs [-v]
 * 退出码：0 全通过；1 有失败
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { readVarInt, readUtf, writeVarInt, writeUtf, decodeRegistryPayload } from "../bot/core/codec.mjs";
import { RegistryStore, injectIntoPrismarine, shortName } from "../bot/core/registry.mjs";
import * as contract from "../bot/core/contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const VERBOSE = process.argv.includes("-v");

const results = [];
function test(name, fn) {
  try { fn(); results.push({ ok: true, name }); }
  catch (e) { results.push({ ok: false, name, err: e.message }); }
}
async function testAsync(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (e) { results.push({ ok: false, name, err: e.message }); }
}

// ---------- 1. 线格式 ----------
test("varint 往返（0 / 1 / 127 / 128 / 25565 / 2^21）", () => {
  for (const n of [0, 1, 127, 128, 300, 25565, 2097152]) {
    const [v, off] = readVarInt(writeVarInt(n), 0);
    assert.equal(v, n);
    assert.equal(off, writeVarInt(n).length);
  }
});

test("varint 截断输入返回 null（不抛）", () => {
  assert.equal(readVarInt(Buffer.from([0x80]), 0), null);      // 只有续位
  assert.equal(readVarInt(Buffer.from([]), 0), null);
});

test("utf 往返（中文/空串/长串）", () => {
  for (const s of ["", "abc", "淋浴间", "a".repeat(300)]) {
    const [v] = readUtf(writeUtf(s), 0);
    assert.equal(v, s);
  }
});

test("utf 长度越界返回 null", () => {
  assert.equal(readUtf(Buffer.from([10, 65]), 0), null);
});

// ---------- 2. 注册表载荷 ----------
function buildRegistryPayload(registryId, entries) {
  const parts = [writeUtf(registryId), writeVarInt(entries.length)];
  for (const [id, name] of entries) parts.push(writeVarInt(id), writeUtf(name));
  return Buffer.concat(parts);
}

test("decodeRegistryPayload：正常载荷", () => {
  const buf = buildRegistryPayload("minecraft:item", [[0, "minecraft:stone"], [1, "create:cogwheel"]]);
  const r = decodeRegistryPayload(buf);
  assert.equal(r.registryId, "minecraft:item");
  assert.equal(r.count, 2);
  assert.equal(r.names[0], "minecraft:stone");
  assert.equal(r.names[1], "create:cogwheel");
  assert.equal(r.bytes, buf.length);
});

test("decodeRegistryPayload：非注册表名 / 空载荷返回 null", () => {
  assert.equal(decodeRegistryPayload(buildRegistryPayload("badname", [[0, "x"]])), null);
  assert.equal(decodeRegistryPayload(Buffer.alloc(0)), null);
});

test("decodeRegistryPayload：截断载荷返回 null（不崩）", () => {
  const full = buildRegistryPayload("minecraft:block", [[0, "minecraft:stone"]]);
  assert.equal(decodeRegistryPayload(full.slice(0, full.length - 3)), null);
});

// ---------- 3. 注册表存储与注入 ----------
test("RegistryStore：set/get/ids/toObject/itemMap", () => {
  const s = new RegistryStore();
  s.set("minecraft:item", ["minecraft:stone", "mod:thing"]);
  s.set("minecraft:block", ["minecraft:stone"]);
  assert.equal(s.get("minecraft:item").length, 2);
  assert.deepEqual(s.ids().sort(), ["minecraft:block", "minecraft:item"]);
  assert.equal(s.toObject()["minecraft:block"].length, 1);
  assert.equal(s.itemMap[1], "mod:thing");
  assert.equal(s.accepted, 2);
});

test("injectIntoPrismarine：保留原版项、补模组项", () => {
  const reg = {
    items: [{ id: 0, name: "stone", displayName: "Stone" }],
    itemsByName: { stone: { id: 0, name: "stone" } },
  };
  const r = injectIntoPrismarine(reg, "minecraft:item", ["minecraft:stone", "create:cogwheel"]);
  assert.equal(r.injected, true);
  assert.equal(r.modded, 1);
  assert.equal(r.fixed, 1);                       // 原版项不动，只补模组项
  assert.equal(reg.items[0].displayName, "Stone"); // 原对象保留
  assert.equal(reg.items[1].name, "create:cogwheel");
  assert.equal(reg.itemsByName["create:cogwheel"].id, 1);
  assert.equal(reg.items[1].stackSize, 64);
});

test("injectIntoPrismarine：无对应表时安全返回", () => {
  const r = injectIntoPrismarine({}, "minecraft:item", ["a:b"]);
  assert.equal(r.injected, false);
  assert.equal(r.fixed, 0);
});

test("shortName 规范化", () => {
  assert.equal(shortName("minecraft:stone"), "stone");
  assert.equal(shortName("create:cogwheel"), "create:cogwheel");
});

// ---------- 3.5 真实 prismarine 注册表注入 ----------
await testAsync("注入真实 prismarine-registry（1.21.1）", async () => {
  const require_ = createRequire(import.meta.url);
  let createRegistry;
  try { createRegistry = require_("prismarine-registry"); }
  catch { console.log("  · 跳过：未安装 prismarine-registry"); return; }

  const reg = createRegistry("1.21.1");
  assert.equal(reg.items[0].name, "air");

  const r = injectIntoPrismarine(reg, "minecraft:item",
    ["minecraft:stone", "minecraft:diamond", "create:cogwheel"]);
  assert.equal(r.injected, true);
  assert.equal(r.modded, 1);
  assert.equal(reg.items[1].name, "stone");              // 原版项保持
  assert.equal(reg.items[2].name, "diamond");
  assert.equal(reg.itemsByName["create:cogwheel"], undefined); // 模组项 id 由载荷决定，这里载荷只有 3 项
});

// ---------- 4. 契约层 ----------
test("契约版本与导出冻结", () => {
  assert.match(contract.CONTRACT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(Object.isFrozen(contract.EVENTS));
});

test("emit：订阅者抛错被隔离，其他订阅者仍执行", () => {
  const seen = [];
  contract.on("chat", () => { throw new Error("boom"); }, { label: "bad" });
  contract.on("chat", () => seen.push("b"));
  contract.on("chat", () => seen.push("a"), { priority: 10 });
  contract.emit("chat", {});
  assert.deepEqual(seen, ["a", "b"]);            // priority 高的先跑
  assert.ok(contract.contractStatus().errors >= 1);
});

test("emit：once 只触发一次", () => {
  let n = 0;
  contract.on("tick", () => n++, { once: true });
  contract.emit("tick", {});
  contract.emit("tick", {});
  assert.equal(n, 1);
});

await testAsync("dispatchAction：已注册返回结果，未注册返回 undefined", async () => {
  contract.registerAction("t_echo", async (a) => ({ ok: true, got: a.x }));
  assert.deepEqual(await contract.dispatchAction("t_echo", { x: 7 }), { ok: true, got: 7 });
  assert.equal(await contract.dispatchAction("t_missing", {}), undefined);
});

test("registerAction：同名不覆盖", () => {
  contract.registerAction("t_dup", () => "first");
  assert.equal(contract.registerAction("t_dup", () => "second"), false);
  assert.ok(contract.actionNames().includes("t_dup"));
});

test("service：已注册服务只读，重复注册被拒", () => {
  contract.registerService("t_svc", { ping: () => "pong" });
  const s = contract.getService("t_svc");
  assert.equal(s.ping(), "pong");
  assert.ok(Object.isFrozen(s));
  assert.equal(contract.registerService("t_svc", { ping: () => "x" }), false);
});

test("contributeState：单个字段抛错不影响其他字段", () => {
  contract.contributeState("t_ok", () => 1);
  contract.contributeState("t_bad", () => { throw new Error("bad field"); });
  const st = contract.collectState();
  assert.equal(st.t_ok, 1);
  assert.equal("t_bad" in st, false);
});

// ---------- 5. addon 装载 ----------
await testAsync("addons：xp-guard 可装载并注册 xpguard 动作", async () => {
  contract.registerService("bot", {
    get: () => null, goto() {}, say() {}, isAuthed: () => false, isOnline: () => false,
  });
  contract.registerService("items", { findXp: () => null, useXp: async () => 0 });
  contract.registerService("config", { xpSpot: { x: 1, y: 2, z: 3 }, xpLowLevel: 50 });

  const { loadAddons } = await import("../bot/core/addons.mjs");
  const loaded = await loadAddons({
    dir: path.join(ROOT, "src", "bot", "addons"),
    ctx: { bot: () => null, log: () => {} },
  });
  assert.ok(loaded.includes("xp-guard"), "xp-guard 未加载：" + loaded.join(","));
  assert.ok(contract.actionNames().includes("xpguard"));
  assert.ok("xpguard" in contract.collectState());
});

// ---------- 6. 核心守卫 ----------
test("core-guard：当前核心与签入一致", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "src", "tools", "core-guard.mjs"), "--json"],
    { encoding: "utf8" });
  const report = JSON.parse(r.stdout || "{}");
  assert.equal(r.status, 0, "guard 未通过：" + JSON.stringify(report.changed || report.lint));
});

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (!r.ok) console.log(`  ✗ ${r.name}\n      ${r.err}`);
  else if (VERBOSE) console.log(`  ✓ ${r.name}`);
}
console.log(`\n[selftest] ${results.length - failed.length}/${results.length} 通过` +
  (failed.length ? `，${failed.length} 失败` : ""));
process.exit(failed.length ? 1 : 0);
