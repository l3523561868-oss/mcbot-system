#!/usr/bin/env node
/**
 * capture-relay.mjs — 中转抓包：真客户端 → 本地中转 → 真实服务器，顺手录下客户端的通道表
 *
 * 为什么要中转：NeoForge 客户端必须先连上一个"真是 NeoForge"的服务端才会发出自己的
 * neoforge:register。本脚本把真实连接原样转发，只在客户端→服务端方向解析出那一包，
 * 其余字节完全不动，因此客户端能正常进服（不会被踢）。
 *
 * 用法：
 *   node capture-relay.mjs --listen 25581 --target frp-fun.com:30177
 *   # 游戏里连 127.0.0.1:25581（与直连朋友世界等价）
 *
 * 产物：capture/capture-from-client.json（与 capture-client.mjs 相同格式）
 */
import fs from "fs";
import net from "net";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const LISTEN = Number(argOf("--listen", "25581"));
const TARGET = argOf("--target", "");
const OUT = argOf("-o", path.join(HERE, "capture", "capture-from-client.json"));

if (!TARGET.includes(":")) {
  console.error("[relay] 用法：node capture-relay.mjs --listen 25581 --target host:port");
  process.exit(1);
}
const [THOST, TPORT] = [TARGET.slice(0, TARGET.lastIndexOf(":")), Number(TARGET.slice(TARGET.lastIndexOf(":") + 1))];

// ---------- 协议工具 ----------
function readVarInt(buf, off) {
  let num = 0, len = 0, b;
  do {
    b = buf[off + len];
    if (b === undefined) return null;
    num |= (b & 0x7f) << (7 * len);
    len++;
  } while (b & 0x80);
  return [num, off + len];
}
const readUtf = (buf, off) => {
  const r = readVarInt(buf, off);
  if (!r) return null;
  const [len, o] = r;
  return [buf.slice(o, o + len).toString("utf8"), o + len];
};

/** 解析 neoforge:register 载荷 */
function decodeRegister(data) {
  const out = [];
  let off = 0;
  let r = readVarInt(data, off);
  if (!r) return out;
  const [groups, o1] = r;
  off = o1;
  const phase = (g) => (g === 4 ? "CONFIGURATION" : g === 1 ? "PLAY" : String(g));
  for (let g = 0; g < groups; g++) {
    let chId, count;
    r = readVarInt(data, off); if (!r) break; [chId, off] = r;
    r = readVarInt(data, off); if (!r) break; [count, off] = r;
    for (let i = 0; i < count; i++) {
      const a = readUtf(data, off); if (!a) return out; const [id, oa] = a; off = oa;
      const b = readUtf(data, off); if (!b) return out; const [ver, ob] = b; off = ob;
      const hasFlow = data[off] === 1; off++;
      let flow = null;
      if (hasFlow) { const c = readVarInt(data, off); if (!c) return out; const [f, oc] = c; off = oc; flow = f === 0 ? "SERVERBOUND" : "CLIENTBOUND"; }
      const optional = data[off] === 1; off++;
      out.push({ proto: phase(chId), id, version: ver || null, flow, optional });
    }
  }
  return out;
}

/** 从任意字节流里找 neoforge:register 的自定义负载，返回其后的 register 数据 */
function extractRegister(buf) {
  const needle = Buffer.from("neoforge:register", "utf8");
  let at = buf.indexOf(needle);
  if (at < 0) return null;
  const after = at + needle.length;
  // 后面就是 register 数据：varint 组数（通常 1 或 2），且长度合理
  const r = readVarInt(buf, after);
  if (!r) return null;
  const [groups] = r;
  if (groups < 1 || groups > 4) return null;
  return buf.slice(after);
}

let saved = false;
function trySave(payload, from) {
  if (saved) return;
  const list = decodeRegister(payload);
  if (list.length < 20) return;          // 太少，多半不是真的通道表
  saved = true;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(list), "utf8");
  console.log(`\n[relay] ✅ 从客户端抓到 ${list.length} 条通道（来源 ${from}），已写入：\n        ${OUT}`);
  console.log(`[relay] 下一步：copy "${OUT}" capture\\private-channel-capture.json\n`);
}

// ---------- 帧解析（客户端 → 服务端） ----------
let cbuf = Buffer.alloc(0);

function feed(chunk, tag) {
  cbuf = Buffer.concat([cbuf, chunk]);
  for (;;) {
    const r = readVarInt(cbuf, 0);
    if (!r) return;
    const [len, o] = r;
    if (cbuf.length < o + len) return;
    let body = cbuf.slice(o, o + len);
    cbuf = cbuf.slice(o + len);

    // 帧可能带压缩：同时尝试"原始"与"解压后"两种解释，谁能解出通道表就用谁
    const cands = [body];
    const r2 = readVarInt(body, 0);
    if (r2) {
      const [dlen, o2] = r2;
      const rest = body.slice(o2);
      if (dlen === 0 && rest.length) cands.push(rest);
      else { try { cands.push(zlib.inflateSync(rest)); } catch {} }
    }
    for (const c of cands) {
      const hit = extractRegister(c);
      if (hit) { trySave(hit, tag); break; }
    }
  }
}

const server = net.createServer((sock) => {
  const peer = net.connect({ host: THOST, port: TPORT });
  console.log(`[relay] 客户端接入 → 转发到 ${THOST}:${TPORT}`);

  sock.on("data", (d) => { feed(d, "client"); peer.write(d); });
  peer.on("data", (d) => sock.write(d));

  sock.on("error", () => peer.destroy());
  peer.on("error", () => sock.destroy());
  sock.on("close", () => peer.destroy());
  peer.on("close", () => sock.destroy());
});

server.listen(LISTEN, "127.0.0.1", () => {
  console.log(`[relay] 监听 127.0.0.1:${LISTEN}  →  ${THOST}:${TPORT}`);
  console.log(`[relay] 游戏里请连 127.0.0.1:${LISTEN}`);
  console.log(`[relay] 抓到后写入：${OUT}\n`);
});
