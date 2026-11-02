#!/usr/bin/env node
/**
 * capture-client.mjs — 用真实客户端抓一份 NeoForge 通道表（离线、本地）
 *
 * 原理：起一个"假服务端"，只完成登录，然后向客户端索要它的通道表，
 *       把客户端上报的 neoforge:register 原样解析成 channel-capture.json。
 *       不连接任何外部服务器、不读取账号凭证（离线模式，用户名随便填）。
 *
 * 用法：
 *   node capture-client.mjs                            # 监听 25580，等待 300 秒
 *   node capture-client.mjs --port 25581 --wait 600
 *   node src/tools/capture-client.mjs -o my-capture.json
 *
 * 然后：游戏客户端 → 多人游戏 → 添加服务器 → 127.0.0.1:25580 → 连接
 *       等它自己断开即可，控制台会打印抓到多少条通道。
 *
 * 注意：客户端必须是与该目标服务器**完全一致**的整合包（同 MC 版本 + 同 NeoForge + 同模组）。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mc from "minecraft-protocol";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = Number(argOf("--port", "25580"));
const OUT = argOf("-o", path.join(HERE, "..", "bot", "capture", "capture-from-client.json"));
const VERSION = argOf("--version", "1.21.1");
const WAIT_SEC = Number(argOf("--wait", "300"));   // 秒

// ---------- 协议工具 ----------
const varint = (n) => {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
};

function readVarInt(buf, off) {
  let num = 0, len = 0, b;
  do {
    b = buf[off + len];
    if (b === undefined) throw new Error("varint 越界");
    num |= (b & 0x7f) << (7 * len);
    len++;
  } while (b & 0x80);
  return [num, off + len];
}

function readUtf(buf, off) {
  const [len, o] = readVarInt(buf, off);
  return [buf.slice(o, o + len).toString("utf8"), o + len];
}

/** 解析 neoforge:register 载荷 → [{proto,id,version,flow,optional}] */
function decodeRegister(data) {
  const out = [];
  let off = 0;
  const [groupCount, o1] = readVarInt(data, off);
  off = o1;
  const phaseOf = (gid) => (gid === 4 ? "CONFIGURATION" : gid === 1 ? "PLAY" : String(gid));

  for (let g = 0; g < groupCount; g++) {
    let chId, count;
    [chId, off] = readVarInt(data, off);
    [count, off] = readVarInt(data, off);
    for (let i = 0; i < count; i++) {
      let id, ver;
      [id, off] = readUtf(data, off);
      [ver, off] = readUtf(data, off);
      const hasFlow = data[off] === 1; off++;
      let flow = null;
      if (hasFlow) { let f; [f, off] = readVarInt(data, off); flow = f === 0 ? "SERVERBOUND" : "CLIENTBOUND"; }
      const optional = data[off] === 1; off++;
      out.push({
        proto: phaseOf(chId),
        id,
        version: ver || null,
        flow,
        optional,
      });
    }
  }
  return out;
}

// ---------- 假服务端 ----------
let done = false;

const server = mc.createServer({
  "online-mode": false,
  port: PORT,
  version: VERSION,
  motd: "MCBot capture",
  maxPlayers: 1,
});

console.log(`[capture] 监听 127.0.0.1:${PORT}（版本 ${VERSION}）`);
console.log(`[capture] 客户端请连：127.0.0.1:${PORT}`);
console.log(`[capture] 抓到后写入：${OUT}\n`);

server.on("login", (client) => {
  console.log(`[capture] 客户端接入：${client.username}`);

  const prompt = () => {
    try {
      client.write("custom_payload", { channel: "minecraft:brand", data: Buffer.concat([varint(8), Buffer.from("neoforge")]) });
    } catch {}
    try {
      // 空表 = “请把你的通道表发过来”
      client.write("custom_payload", { channel: "neoforge:register", data: Buffer.from([0x00]) });
      console.log("[capture] 已向客户端索要通道表");
    } catch (e) {
      console.log("[capture] 发送请求失败:", e.message);
    }
  };

  // 真客户端加载较慢，单次请求容易发在配置阶段之前被丢掉：周期性重发直到收到
  let tries = 0;
  const timer = setInterval(() => {
    if (done || tries++ > 60) { clearInterval(timer); return; }
    prompt();
  }, 800);

  client.on("custom_payload", (p) => {
    if (p.channel !== "neoforge:register") {
      const n = Buffer.isBuffer(p.data) ? p.data.length : (p.data || []).length;
      console.log(`[capture] 入站 ${p.channel} ${n}B`);
      return;
    }
    if (done) return;
    const buf = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data || []);
    if (buf.length < 4) return;

    let list;
    try {
      list = decodeRegister(buf);
    } catch (e) {
      console.log("[capture] 解析失败:", e.message);
      return;
    }
    if (!list.length) return;

    done = true;
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(list), "utf8");
    console.log(`\n[capture] ✅ 收到 ${list.length} 条通道，已写入：${OUT}`);
    console.log(`[capture] 覆盖到 bot：copy "${OUT}" src\\bot\\capture\\channel-capture.json`);
    console.log("[capture] 校验：node src/tools/channels.mjs validate <文件>\n");
    setTimeout(() => process.exit(0), 300);
  });

  client.on("end", () => {
    if (!done) console.log("[capture] 客户端断开（未收到通道表，可重试）");
  });
});

server.on("error", (e) => {
  console.error("[capture] 服务端错误:", e.message);
  process.exit(1);
});

setTimeout(() => {
  if (!done) {
    console.log(`\n[capture] ${WAIT_SEC} 秒内没收到通道表，退出。`);
    process.exit(2);
  }
}, WAIT_SEC * 1000);
