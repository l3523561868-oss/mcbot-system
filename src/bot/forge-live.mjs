// 协议 bot 常驻版：NeoForge 伪造 + 自动重连 + HTTP 决策桥
// 启动：node forge-live.mjs [host] [port] [username]
// 决策：POST http://127.0.0.1:8801 {"type":"say"|"cmd","text":"..."} / {"type":"goto","x":..,"z":..} / {"type":"dig"}
//      GET  http://127.0.0.1:8801/state
global.__pfProbe = true; // [诊断] 启用 packetFilter.transform 内部日志（见 node_modules client.js）
import mf from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
const pathfinder = pathfinderPkg.pathfinder;
const goals = pathfinderPkg.goals;
const Movements = pathfinderPkg.Movements;
import http from "http";
import fs from "fs";
import path from "path";
import url from "url";
import crypto from "crypto";

const [hostArg, portArg, userArg] = process.argv.slice(2);
const HOST = hostArg ?? "mc.example.com";
const PORT = Number(portArg ?? 25565);
const USER = userArg ?? "bot_one";
const PW = process.env.BOT_PW || "";
const BOT_START = Date.now();   // 交接版：口令只从环境变量读取
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8801);   // 多 bot 共存时用环境变量区分

// ---- 运行日志实时落盘 ----
// 用异步写流（绝不用 appendFileSync：packetFilter 里同步磁盘 I/O 会卡事件循环 → keepalive 超时掉线）
// 按天分文件：logs/run-YYYY-MM-DD.log，重启不覆盖历史。
try {
  const LOG_DIR = path.join(HERE, "logs");
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const LOG_FILE = path.join(LOG_DIR, "run-" + new Date().toISOString().slice(0, 10) + ".log");
  const _stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  const _fmt = (a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })());
  const _wrap = (orig) => (...args) => {
    orig(...args);
    try { _stream.write(args.map(_fmt).join(" ") + "\n"); } catch (_) {}
  };
  console.log = _wrap(console.log.bind(console));
  console.error = _wrap(console.error.bind(console));
  console.log("[log] 实时日志 → " + LOG_FILE);
} catch (e) { /* 日志落盘失败不影响主流程 */ }

// ---- NeoForge 通道数据（同 forge-mf.mjs） ----
let CAPTURED = null;
try {
  // 交接包把抓包放在 capture/ 下；原版写死原作者机器的绝对路径，这里优先相对路径、回退旧路径
  const _capLocal = path.join(HERE, "capture", "channel-capture.json");
  const _capLegacy = "D:/AI玩家/AI/channel-capture.json";
  CAPTURED = JSON.parse(fs.readFileSync(fs.existsSync(_capLocal) ? _capLocal : _capLegacy, "utf8"));
} catch (e) { console.log("!! 通道表缺失:", e.message); }

const varint = (n) => {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
};
const utf = (s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([varint(b.length), b]);
};
const SB = 0, CB = 1;
const FLOW_MAP = { SERVERBOUND: SB, CLIENTBOUND: CB };
const NAME_VERSION_NS = ["kiwi", "puzzleslib", "visualworkbench", "illagerinvasion"];

let SPEC = {}, learnedSpecs = {};
try { SPEC = JSON.parse(fs.readFileSync(path.join(HERE, "channel-specs.json"), "utf8")); } catch {}
Object.assign(SPEC, {
  "glitchcore:sync_config": { v: "glitchcore", f: null },
  "neoforge:split": { v: "1", f: null },
  "neoforge:frozen_registry_sync_completed": { v: "1", f: null },
  "create_connected:sync_config": { v: "2.0.0", f: CB },
  "ritchiesprojectilelib:neo_forge_packet": { v: "3.0.0", f: null },
  "paraglider:sync_player_state_map": { v: "3", f: CB },
  "someassemblyrequired:update_ingredients": { v: "1", f: CB },
  "puzzleslib:play/0": { v: "puzzleslib.play", f: null },
});
function getCompSpec(id) {
  const s = SPEC[id], l = learnedSpecs[id];
  const ns = id.split(":")[0];
  return {
    v: s ? s.v : (NAME_VERSION_NS.includes(ns) ? id : (l && l.v ? l.v : "1")),
    f: s ? s.f : (l && l.f !== undefined ? l.f : CB),
  };
}
function component(id, flow, optional, version) {
  const flowPart = flow == null ? Buffer.from([0x00]) : Buffer.concat([Buffer.from([0x01]), varint(flow)]);
  return Buffer.concat([utf(id), utf(version), flowPart, Buffer.from([optional ? 1 : 0])]);
}
function capturedGroups() {
  if (!CAPTURED || !CAPTURED.length) return null;
  const play = [], cfg = [];
  for (const c of CAPTURED) {
    const spec = getCompSpec(c.id);
    const ver = c.version || spec.v;
    const fl = c.flow == null ? spec.f : (FLOW_MAP[c.flow] ?? spec.f);
    const comp = component(c.id, fl, c.optional !== false, ver);
    if (c.proto === "PLAY") play.push(comp); else cfg.push(comp);
  }
  return [[1, play], [4, cfg]];
}
function mcRegisterBuf(channels) {
  const parts = [];
  for (const ch of channels) {
    const b = Buffer.from(ch, "utf8");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    parts.push(len, b, Buffer.from([0]));
  }
  return Buffer.concat(parts);
}
function cRegisterBuf(ids) {
  return Buffer.concat([varint(1), varint(1), varint(ids.length), ...ids.map((id) => utf(id))]);
}

// ---- 通用 NeoForge register 解析（本地/未知版本用）：解析服务器发来的通道表 ----
function readVarIntB(buf, off) {
  let num = 0, len = 0;
  while (len < 5) {
    const b = buf[off + len];
    if (b == null) break;
    num |= (b & 0x7f) << (7 * len);
    len++;
    if ((b & 0x80) === 0) break;
  }
  return [num, len];
}
function readStringB(buf, off) {
  const [len, n] = readVarIntB(buf, off);
  const s = buf.toString("utf8", off + n, off + n + len);
  return [s, n + len];
}
function parseNeoforgeRegister(data) {
  if (!Buffer.isBuffer(data) || data.length < 2) return null;
  try {
    let off = 0;
    const [protoVer, n1] = readVarIntB(data, off); off += n1;
    const [count, n2] = readVarIntB(data, off); off += n2;
    const out = [];
    for (let i = 0; i < count; i++) {
      const [id, n3] = readStringB(data, off); off += n3;
      const [ver, n4] = readStringB(data, off); off += n4;
      out.push({ id, ver });
    }
    return out;
  } catch (e) { console.log("[nf] 解析 register 失败:", e.message); return null; }
}

// ---- bot 生命周期（自动重连） ----
let bot = null, client = null;
let authed = false, reconnects = 0;
// 【修复 2026-10-20】AuthMe 登录：服务器反复提示「请输入"/login <密码>"以登录」= 还没登录成功。
// 原来只在 spawn+3s 发一次 /login，丢一次就永远卡未登录 → 服务端超时踢人 → 无线重连。
let loginTries = 0, lastLoginAt = 0;
const LOGIN_MAX = 3;      // 最多补发 3 次
const LOGIN_GAP = 6000;   // 两次之间至少 6s，别把 AuthMe 惹毛
// 日志节流：这服每秒几十个 custom_payload，整条日志被刷满 → tail/grep 什么都看不出来，手机上写日志也费 CPU
const _skipLogN = {};
// 【修复 2026-10-20】reconnects 原来只增不减，导致退避永久卡在 90s（表现为"重连等很久"）。
// 现在改为：进服后若稳定保持 STABLE_MS 才清零，既恢复快速重连，又不破坏"秒连会被限流"的保护。
const STABLE_MS = 60000;
let stableTimer = null;
let parseErrReconnects = 0; // 连续"解析错位→强制重连"计数，超过阈值则停止重连避免死循环/封禁
let sessionStartAt = 0;     // 本趟进世界的时刻，用于算"在线了多久"（判断是不是定时踢）
let throttledAt = 0;        // 最近一次被代理限流的时间
const chatBuf = []; // 最近 30 条服务器聊天（跨重连保留）
let chatSeq = 0;    // 聊天单调递增序号，供聊天监视游标使用（避免跨午夜时间比较问题）

// ---- littleskin 皮肤拉取（协议 bot 无法应用皮肤，但拉取到 skins/ 备用，供 JsMacros 客户端/皮肤插件复用）----
let skinFetched = false;
async function fetchSkinFromLittleSkin(username) {
  if (skinFetched) return;
  skinFetched = true;
  try {
    const csl = await (await fetch("https://littleskin.cn/csl/" + username + ".json")).json();
    const hash = csl.skins?.slim || csl.skins?.default || csl.skins?.steve;
    if (!hash) { console.log("[skin] " + username + " 无皮肤记录，跳过"); return; }
    const skinRes = await fetch("https://littleskin.cn/textures/" + hash);
    if (!skinRes.ok) { console.log("[skin] 下载失败 HTTP " + skinRes.status); return; }
    const buf = Buffer.from(await skinRes.arrayBuffer());
    const skinDir = path.join(HERE, "skins");
    fs.mkdirSync(skinDir, { recursive: true });
    const outPath = path.join(skinDir, username + ".png");
    fs.writeFileSync(outPath, buf);
    console.log("[skin] 已从 littleskin 拉取 " + username + " 皮肤（" + buf.length + "B）→ skins/" + username + ".png");
  } catch (e) {
    console.log("[skin] 拉取失败:", e.message);
  }
}

// ---- LLM 调用（Ollama 本地模型）----
let _aiCfg = null, _aiCfgAt = 0;
function aiCfg() {
  if (_aiCfg && Date.now() - _aiCfgAt < 5000) return _aiCfg;   // 5 秒缓存
  try { _aiCfg = JSON.parse(fs.readFileSync(path.join(HERE, "ai_config.json"), "utf8")); }
  catch (_) { _aiCfg = null; }
  _aiCfgAt = Date.now();
  return _aiCfg;   // {url, model, key, system} —— 控制台的「AI 接入」面板下发
}
const LLM_MODEL = "qwen2.5:7b";
const LLM_URL = "http://localhost:11434";
const LLM_SYSTEM = "你是 Minecraft 服务器里的 AI 玩家，名叫 " + USER + "。用简短自然的中文回复玩家，像真人玩家一样聊天。不要暴露自己是 AI 程序，不要说「可以指挥我」之类的话，不要罗列功能清单。回答控制在 30 字以内，一句话。";
async function askLLM(prompt) {
  // 控制台的 ai_config.json 优先（url 填完整端点，Ollama/OpenAI 两种协议都兼容）
  const cfg = aiCfg() || {};
  if (cfg.enabled === false) return null;   // 控制台可一键关闭 AI
  const url = String(cfg.url || (LLM_URL + "/api/chat")).replace(/\/+$/, "");
  const model = cfg.model || LLM_MODEL;
  const sys = cfg.system || LLM_SYSTEM;
  try {
    const headers = { "Content-Type": "application/json" };
    if (cfg.key) headers.Authorization = "Bearer " + cfg.key;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: prompt },
        ],
        stream: false,
        options: { temperature: 0.7, num_predict: 80 },
        max_tokens: 120,
      }),
      signal: AbortSignal.timeout(20000), // 20 秒超时，卡住则回退固定应声
    });
    const data = await res.json();
    // Ollama: {message:{content}} ｜ OpenAI: {choices:[{message:{content}}]}
    const txt = (data.message?.content || data.choices?.[0]?.message?.content || data.response || "").trim();
    return txt;
  } catch (e) {
    console.log("[llm] 调用失败:", e.message);
    return null;
  }
}

function startBot() {
  stopWork("重连前清理");
  fetchSkinFromLittleSkin("bot_two"); // 从 littleskin 拉取皮肤到 skins/（异步，不阻塞）
  bot = mf.createBot({
    host: HOST,
    port: PORT,
    username: USER,
    version: "1.21.1",
    auth: "offline",
    brand: "neoforge",
    hideErrors: false, // [诊断] 打开 deserializer 错误日志（原本 true 会把 partialReadError 堆栈全部静音）
    respawn: true, // 死亡自动重生（mineflayer 内置，对标 aiplayer 自主本能）
    // 默认 30s：事件循环一忙（大量模组包/寻路）就会误判 keepalive 超时 → 反复重连
    checkTimeoutInterval: 90000,
  });
  client = bot._client;
  // [PROBE] 在 setSerializer 创建 deserializer 的瞬间接管其 _transform：
  // 之前的探针在 state→play 时才绑定，绑到的可能不是真正被 pipe 的实例（[pf]=0 而 [pf-filter]=1 的矛盾来源）。
  try {
    const _origSetSer = client.setSerializer.bind(client);
    let _dzTotal = 0;
    client.setSerializer = function (st) {
      _origSetSer(st);
      const dz = this.deserializer;
      if (!dz || !dz.parsePacketBuffer) return;
      const _pp = dz.parsePacketBuffer.bind(dz);
      dz._transform = function (chunk, enc, cb) {
        _dzTotal++;
        let p;
        try { p = _pp(chunk); } catch (e) {
          const tag = e.partialReadError ? "PARTIAL" : "FATAL";
          const pid = (chunk && chunk.length) ? chunk[0] : -1;
          if (st === "play") {
            // 【关键修复】splitter 已按包分帧，每个 chunk 就是一个独立包边界：
            // 单包解析失败（模组物品 Slot/NBT 结构与 vanilla 定义不符）不会污染后续包。
            // 因此这里跳过坏包并继续，而不是 cb(e) 触发断线重连（那样进服 4 秒就掉线）。
            _skipLogN[pid] = (_skipLogN[pid] || 0) + 1;
            if (_skipLogN[pid] <= 3 || _skipLogN[pid] % 200 === 0) {
              console.log("[dz-skip] pid=0x" + pid.toString(16) + " len=" + chunk.length + " " + tag
                + " 第" + _skipLogN[pid] + "次 " + String(e.message).slice(0, 90));
            }
            // 包体解析失败但包头仍然可用：手动读出 windowId / stateId / 格数，
            // 供 curios_equip 直接发 window_click（不依赖 mineflayer 的背包模型）。
            if (pid === 0x13) {
              try {
                let o = 1;
                const wid = chunk[o]; o += 1;
                const rdv = () => { let v = 0, s = 0, n; do { n = chunk[o + s]; v += (n & 0x7f) * Math.pow(2, 7 * s); s++; } while (n & 0x80); o += s; return v; };
                const stateId = rdv();
                const count = rdv();
                global.__lastWinItems = { windowId: wid, stateId, count, at: Date.now(), buf: Buffer.from(chunk) };
                console.log("[win-raw] windowId=" + wid + " stateId=" + stateId + " count=" + count);
              } catch (_) {}
            }
            if (pid === 0x13) {
              // 每个窗口分别落盘：便于定位护符在该窗口里的精确槽位
              try {
                fs.mkdirSync(path.join(HERE, "payload-dump"), { recursive: true });
                fs.writeFileSync(path.join(HERE, "payload-dump", "win-" + chunk[1] + "-" + chunk.length + ".hex"), chunk.toString("hex"));
              } catch (_) {}
            }
            if (pid === 0x13 && !global.__winDumped) {
              global.__winDumped = true;
              try { fs.writeFileSync("payload-dump/window_items-fail.hex", chunk.toString("hex")); console.log("[dump] window_items 已存 payload-dump/window_items-fail.hex (" + chunk.length + "B)"); } catch (_) {}
            }
            return cb();
          }
          if (_dzTotal <= 80) console.log("[dzx#" + _dzTotal + "] " + tag + " st=" + st + " len=" + chunk.length + " head=" + chunk.slice(0, 28).toString("hex") + " msg=" + String(e.message).slice(0, 160));
          if (e.partialReadError) return cb();
          return cb(e);
        }
        if (_dzTotal <= 80) console.log("[dzx#" + _dzTotal + "] OK st=" + st + " name=" + (p && p.data && p.data.name) + " size=" + (p && p.metadata && p.metadata.size) + "/" + chunk.length);
        this.push(p);
        cb();
      };
      dz.on("error", (e) => console.log("[dz-err] st=" + st + " msg=" + String(e.message).slice(0, 200)));
      console.log("[dz-new] state=" + st + " patched=" + dz.constructor.name);
    };
  } catch (e) { console.log("[PROBE] setSerializer 接管失败:", e.message); }
  authed = false;
  // 【实验】注入 profileKeys（RSA 密钥对），让聊天走签名路径——攻第二层障碍
  // 真客户端即使离线也生成密钥对签名聊天；mineflayer 离线模式不生成 → unsigned 被 TrChat 丢弃。
  try {
    if (!client.profileKeys) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      client.profileKeys = {
        public: publicKey,
        private: privateKey,
        expiresOn: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        signatureV2: Buffer.alloc(256), // 假 Mojang 签名，离线服可能不验证
      };
      if (!client.cipher) client.cipher = {}; // 伪造，满足 chat session 建立条件
      if (!client.session) client.session = {};
      if (!client.session.selectedProfile) {
        client.session.selectedProfile = { id: (client.uuid || "").replace(/-/g, "") };
      }
      console.log("[实验] profileKeys 注入成功，签名聊天将启用");
    }
  } catch (e) {
    console.log("[实验] profileKeys 注入失败:", e.message);
  }
  // ===== 入站包统计（轻量：只计数，不打印不落盘）=====
  // 供 pkt_names 诊断「某个包到底有没有到」，替代早期的 raw/sock/dc/pf/dz/hb 全套探针。
  let lastPkt = "(none)";
  let _afterFinish = false;
  const pktCount = Object.create(null);
  client.on("raw", (buf, meta) => {
    if (!meta) return;
    const nm = String(meta.state) + ":" + String(meta.name || "?");
    pktCount[nm] = (pktCount[nm] || 0) + 1;
    if (meta.state === "play") lastPkt = meta.name;
  });
  global.__pktCount = pktCount;
  client.on("state", (st, old) => { console.log("[state] " + old + " → " + st); });
  client.prependListener("error", (e) => {
    console.log("[PARSE_ERR] 崩溃前最后包 =", lastPkt, "| msg =", e.message);
  });
  // 1.20.5+ 的 registry_data 是"按单个注册表下发"：{id:"minecraft:item", entries:[{key,value}]}
  // mineflayer 只把它丢给 loadDimensionCodec（1.16 的 dimension_codec 接口），item 注册表被整个忽略，
  // 导致模组物品一律 name="unknown"。这里接管 item 注册表，按 entries 顺序（=网络 id）注入。
  client.on("registry_data", (packet) => {
    try {
      const rid = String((packet && packet.id) || "");
      const n = Array.isArray(packet.entries) ? packet.entries.length : 0;
      if (rid !== "minecraft:item") {
        // 只打印，不注入：其它注册表（powergrid:component_items 等）绝不能被写进物品表
        if (n > 0) console.log("[registry] 收到 " + rid + " entries=" + n + "（忽略）");
        return;
      }
      const reg = bot && bot.registry;
      if (!reg || !reg.items) return;
      let added = 0, kept = 0;
      packet.entries.forEach((e, i) => {
        const name = String((e && e.key) || "").trim();
        if (!name) return;
        const cur = reg.items[i];
        if (cur && cur.name === name) { kept++; return; } // 原版项：保留（displayName 更友好）
        const item = { id: i, name, displayName: name, stackSize: (cur && cur.stackSize) || 64 };
        reg.items[i] = item;
        reg.itemsByName[name] = item;
        added++;
      });
      global.__itemReg = { total: packet.entries.length, added, kept, at: Date.now() };
      console.log("[registry] " + rid + " 共 " + packet.entries.length + " 项：保留原版 " + kept + "，注入模组 " + added);
    } catch (e) { console.log("[registry] 注入失败:", e.message); }
  });
  // 记录成功解析的 window_items 包头（与 dz-skip 里的 win-raw 互补，保证两种路径都有最新数据）
  client.on("window_items", (p) => {
    try { const prev = global.__lastWinItems || {}; global.__lastWinItems = { windowId: p.windowId, stateId: p.stateId, count: (p.items || []).length, at: Date.now(), buf: prev.buf }; } catch (_) {}
  });
  // 成功解析路径也抓原始 buffer：dz-skip 只在解析失败时才落 buf，这里补上成功路径，
  // 让 csEquipBackpack 无论窗口包是否被 protodef 成功解析都能拿到原始字节逐槽定位真实协议槽位。
  try {
    client.on("raw", (data, meta) => {
      try {
        if (meta && meta.name === "window_items" && Buffer.isBuffer(data)) {
          const o0 = (data[0] === 0x13) ? 1 : 0; // 跳过 packet id 字节
          let p = o0;
          const rv = () => { let v = 0, s = 0, n; do { n = data[p + s]; v += (n & 0x7f) * Math.pow(2, 7 * s); s++; } while (n & 0x80); p += s; return v; };
          const wid = data[p++]; const stateId = rv(); const n = rv();
          const prev = global.__lastWinItems || {};
          global.__lastWinItems = { windowId: wid, stateId, count: n, at: Date.now(), buf: Buffer.from(data) };
        }
      } catch (_) {}
    });
  } catch (_) {}
  bot.loadPlugin(pathfinder);

  // [FIX] Mod 友好寻路：mineflayer 读不懂的未知方块（modded 方块/区块边界）原本被 pathfinder
  //       当作实心死墙（safe=false→cost 100），导致 bot 在淋浴间/主城等模组区域走几格就卡死。
  //       这里让 pathfinder 把这类方块视为可通行地面（boundingBox 缺失即视为 unknown），
  //       已知方块仍走原逻辑。普通地形不受影响（出生点测试已验证可正常行走）。
  class ModFriendlyMovements extends Movements {
    getBlock(pos, dx, dy, dz) {
      const b = super.getBlock(pos, dx, dy, dz);
      if (b && b.boundingBox == null) {
        // unknown / 读不到的方块 → 当作可通行地面（含 modded 区块、区块边界）
        b.safe = true; b.physical = false; b.replaceable = true; b.liquid = false;
        b.climbable = false; b.height = pos.y + dy; b.canFall = false; b.openable = false;
        return b;
      }
      return b;
    }
  }

  bot.on("login", () => {
    console.log("[" + ts() + "] login（" + USER + "）");
    // [FIX] Mod 友好寻路：插件注入在 bot 就绪后才完成，必须在此处（login 后）设置
    try { bot.pathfinder.setMovements(new ModFriendlyMovements(bot));
      // [优化] 行为调优：流畅行走 + 防坠落 + 不破坏建筑
      const mv = bot.pathfinder.movements;
      if (mv) {
        mv.allowSprinting = true;      // 冲刺赶路
        mv.allowParkour = true;        // 会跳跃过 1 格障碍（遇方块跳过去）
        mv.allow1by1towers = false;    // 不原地搭方块
        mv.allowScaffolding = false;   // 不搭脚手架
        mv.canDig = false;             // ★禁止挖方块（不破坏主城建筑）
        mv.maxDropDown = 4;            // 最多允许 4 格下落（再高绕行，防坠落）
        console.log("[fix] 寻路调优：冲刺/跳跃开启，禁挖禁搭，maxDropDown=4");
      }
      console.log("[fix] ModFriendlyMovements 已启用（未知方块视为可通行）"); }
    catch (e) { console.log("[fix] ModFriendlyMovements 设置失败:", e.message); }
    // TCP keepalive：手机流量下 NAT/基站的空闲连接会被悄悄回收，表现为 socketClosed（无任何原因包）。
    // 30s 探一次，能把「静默断线」大幅压下去。
    try {
      if (client.socket && client.socket.setKeepAlive) {
        client.socket.setKeepAlive(true, 30000);
        console.log("[net] TCP keepalive 已开启（30s）");
      }
    } catch (e) { console.log("[net] keepalive 设置失败:", e.message); }
    // 探针：打印服务器是否强制安全聊天 + 是否有 profileKeys
    console.log("[probe] enforcesSecureChat =", client.serverFeatures?.enforcesSecureChat);
    console.log("[probe] profileKeys =", client.profileKeys ? "有(" + Object.keys(client.profileKeys).join(",") + ")" : "null");
    console.log("[probe] cipher =", client.cipher ? "有" : "null");
    console.log("[probe] session.selectedProfile =", client.session?.selectedProfile?.id ?? "null");
    console.log("[probe] uuid =", client.uuid);
    console.log("[probe] _session =", client._session ? JSON.stringify(client._session) : "null");
    console.log("[probe] _signedChat =", client._signedChat ? "有" : "null");
  });
  bot.on("spawn", () => {
    parseErrReconnects = 0; // 成功进入世界 → 清零连续错位计数
    loginTries = 0; lastLoginAt = 0;   // 每次进世界重置登录补发额度
    sessionStartAt = Date.now();
    // 【修复】稳定 STABLE_MS 后再清零重连退避，否则第 5 次之后每次都要等 90 秒
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (reconnects > 0) console.log("[" + ts() + "] 连接已稳定 " + (STABLE_MS / 1000) + "s，重连退避计数清零（原=" + reconnects + "）");
      reconnects = 0;
    }, STABLE_MS);
    // 【修复】authed 只靠聊天里出现「已成功登录」才置真；一旦该文案变体/被刷掉/重连后没再出现，
    // canSay() 永远 false → 发言全进待发队列，表现为「发不出去 / 只能发一次」。
    // 这里加兜底：spawn 后 12s 仍未确认，就按已登录处理并补发队列。
    setTimeout(() => {
      if (!authed && bot && bot.entity) {
        authed = true;
        console.log("[" + ts() + "] [auth] 12s 内未收到「已成功登录」，按已登录处理（兜底），补发队列");
        try { flushPendingSay(); } catch (_) {}
      }
    }, 12000);
    console.log("[" + ts() + "] ✅ spawn 进入世界");
    // AuthMe：已注册账号直接 /login；未注册报错无害
    // BOT_REG=1 时改为首次注册（/register 两次口令），注册成功后应改回 /login
    if (process.env.BOT_REG === "1") {
      setTimeout(() => { bot.chat("/register " + PW + " " + PW); console.log(">> /register（首次注册）"); }, 3000);
    } else {
      setTimeout(() => sendLogin(), 3000);
    }
    spawnReadyAt = Date.now() + 8000;   // 留 8s 让背包(windows_items)同步完毕，避免误判“无食物”
    startAutoEat();       // 自动进食：food<20 即补，保持食物栏常满
    startAutoSleep();     // 自动睡觉：夜晚+有床时自动睡，防幻翼（aiplayer 机制）
    startSurvivalCheck(); // 低血避险：按比例（hp<30% 上限）停止工作 + 播报
    startCombat();        // 自动战斗：12 格内遇敌自动换剑反击（仅打 HOSTILE_HINTS）
    startPosReport();     // 坐标播报：位移 ≥1000 格时全服播报一次"当前位置 X Z"
    startRandomGreet();   // 随机问候：不定时 @ 在线玩家打招呼（LLM 接话）
    startChatMonitor();   // 聊天监视：无需 @，bot 主动加入玩家对话（定时扫描聊天缓冲）
    startWaystoneEye();   // 石碑之眼：识别附近普通传送石碑并自动激活（WAYSTONE_EYE_OFF=1 可关）
    startAntiAfk();       // 反挂机：定期微转视角/小跳，避免被服务端按 AFK 踢（ANTI_AFK_OFF=1 可关）
    startXpGuard();       // 经验守护：等级<50 时自动前往淋浴间（262,-1147）吸收经验球
    startDurabilityGuard(); // 耐久守护：装备耐久<35% 自动去淋浴间用经验修补修复
  });
  bot.on("death", () => {
    const p = bot.entity?.position;
    console.log("[" + ts() + "] 💀 被击杀 @", p ? Math.round(p.x) + "," + Math.round(p.z) : "?");
    announce("[阵亡] 被击杀了！马上自动重生");
    // 兜底：2 秒后若仍未重生（isAlive 为 false），主动请求 respawn
    setTimeout(() => {
      try { if (bot && !bot.isAlive) bot.respawn(); } catch (e) { console.log("[death] respawn:", e.message); }
    }, 2000);
  });
  // 受伤反击：bot 自身被伤害时取攻击者立即还手（见 onBotHurt / 3.5 段）
  bot.on("entityHurt", (entity, source) => {
    if (entity === bot.entity) onBotHurt(source);
  });
  bot.on("kicked", (r) => {
    const s = typeof r === "string" ? r : JSON.stringify(r);
    console.log("[" + ts() + "] [kicked]", s.slice(0, 200));
    // ★ 代理层（BungeeCord/Velocity）限流：同 IP 短时间连太多次。
    // 这服对两只 bot 共用手机出口 IP，所以一旦快速重连就是这个结果 —— 越急着重连越进不去。
    if (/throttled|too many|slow down/i.test(s)) {
      throttledAt = Date.now();
      console.log("[" + ts() + "] [throttle] IP 被限流，下次重连至少等 2 分钟（别再 8 秒一次硬撞）");
    }
  });
  bot.on("error", (e) => {
    const m = e && e.message ? e.message : String(e);
    console.log("[" + ts() + "] [error]", m);
    // 入站解析错位（play.toClient 的 "array size is abnormally large" / "Parse error"）是不可自恢复的：
    // 流永久错位 → bot 背包永远空、坐标冻结、卡死。本服偶发此问题，强制断开触发下方
    // bot.on('end') 的自动重连，重连后通常能正常回位。仅对 play 入站解析错误生效，避免误杀其他错误。
    if (/Parse error for play\.toClient|abnormally large|array size is abnormally/i.test(m) && !bot._parseErrEnding) {
      bot._parseErrEnding = true;
      parseErrReconnects++;
      // 诊断：导出"错位前最近 140 个入站包"到文件（仅前几次错位时落盘，异步不阻塞事件循环）
      if (parseErrReconnects <= 3) {
        try {
          const ring = (bot._client && bot._client._pktRing) ? bot._client._pktRing.slice() : [];
          const dump = "PARSE_ERR #" + parseErrReconnects + " @ " + new Date().toISOString() + "\nmsg=" + m + "\nlast_pkts(incoming, pid:len):\n" + ring.join("\n") + "\n";
          fs.writeFile("payload-dump/pre-crash.log", dump, () => {});
          console.log("[diag] 已导出错位前包序列 → payload-dump/pre-crash.log (" + ring.length + " 个)");
        } catch (_) {}
      }
      if (parseErrReconnects > 6) {
        console.log("[" + ts() + "] [error] 连续 " + parseErrReconnects + " 次入站解析错位，疑似确定性流错位，停止自动重连！需人工排查根因（见 node_modules/minecraft-protocol 的 unlock_recipes 丢弃逻辑）。");
      } else {
        console.log("[" + ts() + "] [error] 检测到入站解析错位，强制断开以自动重连（第 " + parseErrReconnects + " 次）…");
        try { bot.end(); } catch (_) {}
      }
    }
  });
  bot.on("end", (reason) => {
    reconnects++;
    // ★ 记下断开原因 + 这一趟活了多久：如果每次都是同一个时长（比如都 150s 左右），
    //   那就是服务端的定时踢（AFK/清理/限流），不是网络抖动。
    const lived = sessionStartAt ? Math.round((Date.now() - sessionStartAt) / 1000) : -1;
    try {
      console.log("[" + ts() + "] [end] 原因: " + (typeof reason === "string" ? reason : JSON.stringify(reason)).slice(0, 300)
        + " ｜ 在线 " + lived + "s");
    } catch (_) { console.log("[" + ts() + "] [end] 原因: <无法序列化> ｜ 在线 " + lived + "s"); }
    // 指数退避 20s→36s→65s→117s→180s，封顶 5 分钟。
    // 原来 8s 起跳太急：被 throttle 之后再撞只会继续被拒，形成「进去就退出」的死循环。
    let delay = Math.min(20000 * Math.pow(1.8, Math.min(reconnects - 1, 4)), 300000);
    if (Date.now() - throttledAt < 120000) delay = Math.max(delay, 120000);   // 2 分钟内被限流过 → 至少等 2 分钟
    delay += Number(process.env.RECONNECT_STAGGER || 0);                      // 两只 bot 错峰，别同时撞
    delay += Math.floor(Math.random() * 5000);                                // 抖动，避免长期共振
    console.log("[" + ts() + "] [end] 第 " + reconnects + " 次断开，" + Math.round(delay / 1000) + " 秒后重连…");
    setTimeout(startBot, delay);
  });
  // ---- AuthMe 登录（含补发）----
  function sendLogin() {
    if (authed || loginTries >= LOGIN_MAX) return;
    if (!PW) { console.log("!! [!] BOT_PW 为空，无法 /login（检查 restart.sh 的环境变量）"); loginTries = LOGIN_MAX; return; }
    loginTries++;
    lastLoginAt = Date.now();
    try {
      bot.chat("/login " + PW);
      console.log(">> /login（第 " + loginTries + " 次，" + USER + "）");
    } catch (e) {
      console.log("!! [!] /login 发送失败:", e.message);
    }
  }
  function maybeLogin() {
    if (authed || loginTries >= LOGIN_MAX) return;
    if (Date.now() - lastLoginAt < LOGIN_GAP) return;
    console.log("[auth] 服务器提示需要登录，补发 /login");
    sendLogin();
  }
  // 聊天识别：所有信道（message / system_chat / pushChat）都过这里，避免漏信道
  function checkAuthMe(t) {
    if (!t) return;
    if (!authed && /\/login/i.test(t) && /密码|password|登录/i.test(t)) maybeLogin();
    if (/密码错误|密码不正确|wrong password|密码错误次数/i.test(t)) {
      console.log("!! [!] 服务器报「密码错误」，停止补发 /login（防 AuthMe 临时封禁）。请核对 " + USER + " 的口令");
      loginTries = LOGIN_MAX;
    }
  }

  bot.on("message", (msg) => {
    const t = msg.toString ? msg.toString() : String(msg);
    if (!t) return;
    console.log("[CHAT]", t.slice(0, 130));
    // ★ 游戏内指令 @//bot/ ...：优先处理并 return，避免被 LLM 接话/问候逻辑抢走
    if (t.includes(CHAT_CMD_PREFIX) && !new RegExp("<" + USER + ">").test(t)) {
      const mCmd = t.match(/\[world\]\s*<(\w+)>[:：]?\s*(.*)/) || t.match(/<(\w+)>[:：]?\s*(.*)/);
      const who = mCmd ? mCmd[1] : "玩家";
      handleChatCommand(t, who).catch((e) => console.log("[CMD] 异常:", e.message));
      return;
    }
    // AuthMe 各版本文案不同：「已成功登录」/「登录成功」/「成功登录」都算
    if (t.includes("已成功登录") || /登录成功|成功登录/.test(t)) {
      authed = true;
      setTimeout(flushPendingSay, 1200);        // 补发离线期间排队的消息
      runWaystoneTaskOnce();                    // 服务器恢复后的首次登录 → 自动石碑传送任务
    }
    // AuthMe：服务器在催登录 → 补发（密码错时立刻停手，连错会被临时封禁）
    checkAuthMe(t);
    chatBuf.push({ at: new Date().toTimeString().slice(0, 8), text: t.slice(0, 150), seq: ++chatSeq });
    if (chatBuf.length > 30) chatBuf.shift();
    checkPlayerJoin(t); // 玩家加入 → 发送欢迎
    tryMentionReply(t);
  });

  // ---- NeoForge 伪造层 ----
  // ---- 递归提取 NBT/聊天组件文本（处理 {type,value} 包装和 text/extra/with 结构）----
  function nbtText(node) {
    if (node == null) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(nbtText).join("");
    if (typeof node === "object") {
      if ("value" in node && "type" in node) return nbtText(node.value);
      let s = "";
      if (node.text != null) s += nbtText(node.text); // text 也可能是 {type:"string",value:...} 包装
      if (node.extra) s += nbtText(node.extra);
      if (node.with) s += nbtText(node.with);
      if (node.translate && !node.with) s += nbtText(node.translate);
      return s;
    }
    return "";
  }
  function pushChat(text) {
    if (!text) return;
    checkAuthMe(text);   // 原始包兜底：AuthMe 提示走 system_chat 时 bot.on("message") 可能收不到
    const last = chatBuf[chatBuf.length - 1];
    if (last && last.text === text) return; // 去重（bot.on("message") 可能已收同一条）
    chatBuf.push({ at: new Date().toTimeString().slice(0, 8), text: text.slice(0, 150), seq: ++chatSeq });
    if (chatBuf.length > 30) chatBuf.shift();
    tryMentionReply(text);
  }

  // ---- 原始包探针：观察聊天相关包的收发 + 兜底收集（mineflayer 转发可能漏掉部分包）----
  client.on("system_chat", (p) => {
    const txt = nbtText(p.content);
    if (txt) {
      console.log("[raw:system_chat]", (p.isActionBar ? "[bar] " : "") + txt.slice(0, 130));
    } else {
      console.log("[raw:system_chat:RAW]", JSON.stringify(p.content).slice(0, 350));
    }
    if (txt && !p.isActionBar) pushChat(txt);
  });
  client.on("player_chat", (p) => {
    const sender = p.senderName ? nbtText(p.senderName) : (p.networkName ? nbtText(p.networkName) : "?");
    const txt = "<" + sender + "> " + (p.plainMessage || nbtText(p.unsignedChatContent) || "");
    console.log("[raw:player_chat]", txt.slice(0, 130));
    pushChat(txt);
  });
  client.on("profileless_chat", (p) => {
    const txt = nbtText(p.message) || nbtText(p.content);
    console.log("[raw:profileless_chat]", txt.slice(0, 130));
    pushChat(txt);
  });
  client.on("disguised_chat", (p) => {
    const txt = nbtText(p.message);
    console.log("[raw:disguised_chat]", txt.slice(0, 130));
    pushChat(txt);
  });

  // ---- NeoForge 配置阶段：收集 config_file 文件名，待配置阶段结束统一应答（缺失此应答会导致握手卡死，永远到不了 login）----
  let _cfgNames = [];
  function sendConfigAck() {
    if (!_cfgNames.length) return;
    // NeoForge ModConfigsAcknowledged = 纯字符串列表（writeCollection(writeUtf)），无每项状态字节。
    // 之前多写的 0x00 会残留字节，导致服务端 "Failed to decode packet custom_payload" 直接踢人。
    const parts = [varint(_cfgNames.length)];
    for (const nm of _cfgNames) parts.push(utf(nm));
    const payload = Buffer.concat(parts);
    // 临时诊断：导出前若干名字 + payload 头 160 字节，核对是否为合法字符串列表
    const sample = _cfgNames.slice(0, 6).concat(_cfgNames.slice(-4));
    console.log("[cfg-diag] 名字样本: " + JSON.stringify(sample));
    console.log("[cfg-diag] payload hex(160): " + payload.subarray(0, 160).toString("hex"));
    try { client.write("custom_payload", { channel: "neoforge:config_file", data: payload }); console.log("[cfg] ✅ 已应答 neoforge:config_file x" + _cfgNames.length); } catch (e) { console.log("[cfg] 应答失败:", e.message); }
    _cfgNames = [];
  }

  client.on("custom_payload", (p) => {
    const ch = p.channel;
    // 诊断：打印所有非 waystones 的 S->C 自定义通道（握手相关），定位"服务器发完后卡住、bot 未应答"的那个通道
    if (!ch.startsWith("waystones:")) {
      // 限流：create:funnel_flap 这类高频通道每秒几十条，只打前 5 条 + 每 500 条一次
      global.__cpCount = global.__cpCount || {};
      const c0 = (global.__cpCount[ch] = (global.__cpCount[ch] || 0) + 1);
      if (c0 <= 3 || c0 % 5000 === 0) console.log("[S->C cp] " + ch + " len=" + (p.data?.length ?? 0) + (c0 > 3 ? " (第 " + c0 + " 次)" : ""));
    }
    // ★ 维度网络存储同步：网络里"有哪些物品"的唯一来源（153KB 级）。缓存原始字节供离线解析。
    if (ch === "beyonddimensions:disordered_slot_group_sync_packet") {
      try {
        global.__bdNetSync = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data || []);
        global.__bdNetSyncAt = Date.now();
        console.log("[BD] 收到网络存储同步 " + global.__bdNetSync.length + "B（已缓存）");
      } catch (e) { }
    }
    if (ch === "neoforge:register") {
      const groups = capturedGroups();
      if (groups) {
        const payload = Buffer.concat([varint(groups.length), ...groups.map(([pid, comps]) => Buffer.concat([varint(pid), varint(comps.length), ...comps]))]);
        client.write("custom_payload", { channel: "neoforge:register", data: payload });
        console.log(">> C->S neoforge:register（1305 通道）");
      }
    } else if (ch === "neoforge:network") {
      console.log("✅ 协商成功");
      _cfgNames = []; // 重置配置文件名收集（新一次握手）
      const listening = ["minecraft:register", "minecraft:unregister", "minecraft:brand"];
      if (CAPTURED) for (const c of CAPTURED) if (c.flow === "CLIENTBOUND" && !listening.includes(c.id)) listening.push(c.id);
      client.write("custom_payload", { channel: "minecraft:register", data: mcRegisterBuf(listening) });
      console.log(">> C->S minecraft:register（监听 " + listening.length + " 个）");
    } else if (ch === "neoforge:modded_network_setup_failed") {
      console.log("❌ 协商失败 " + (p.data?.length ?? 0) + "B");
      try { fs.writeFileSync(path.join(HERE, "setup-failed.bin"), Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data || [])); } catch {}
    } else if (ch === "neoforge:frozen_registry_sync_completed") {
      client.write("custom_payload", { channel: "neoforge:frozen_registry_sync_completed", data: Buffer.alloc(0) });
    } else if (ch === "neoforge:frozen_registry") {
      // NeoForge 模组注册表同步：服务器**不**发 minecraft:item，模组物品/方块注册项全在这里下发。
      // 格式（实测）：writeUtf(registryId) + varint(count) + count × [varint(id) + writeUtf(name)]
      try {
        const buf = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data || []);
        global.__frzCount = (global.__frzCount || 0) + 1;
        if (global.__frzCount <= 40) {
          fs.appendFileSync(path.join(HERE, "payload-dump", "frozen-registry.log"),
            "#" + global.__frzCount + " len=" + buf.length + " hex=" + buf.toString("hex") + "\n");
        }
        // ---- 通用自动注册：不写死注册表名，凡 prismarine-registry 里有对应表的都自动灌入 ----
        let o = 0;
        const rv = () => { let v = 0, s = 0, n; do { n = buf[o + s]; v += (n & 0x7f) * Math.pow(2, 7 * s); s++; } while (n & 0x80); o += s; return v; };
        const rdUtf = () => { const n = rv(); const s = buf.slice(o, o + n).toString("utf8"); o += n; return s; };
        const rid = rdUtf();
        const count = rv();
        const names = [];
        for (let i = 0; i < count; i++) { const id = rv(); names[id] = rdUtf(); }

        global.__regMaps = global.__regMaps || {};
        global.__regMaps[rid] = names;

        // 规范化：minecraft:xxx → xxx（与 mineflayer 原生命名一致），模组项保留 modid:name
        const short = (nm) => (nm && nm.startsWith("minecraft:") ? nm.slice(10) : nm);

        // registryId → prismarine-registry 的两个字段（数组 + 名字表）
        const HINTS = {
          "minecraft:item": ["items", "itemsByName"],
          "minecraft:block": ["blocks", "blocksByName"],
          "minecraft:entity_type": ["entities", "entitiesByName"],
          "minecraft:biome": ["biomes", "biomesByName"],
          "minecraft:enchantment": ["enchantments", "enchantmentsByName"],
          "minecraft:particle_type": ["particles", "particlesByName"],
          "minecraft:mob_effect": ["effects", "effectsByName"],
          "minecraft:attribute": ["attributes", "attributesByName"],
          "minecraft:instrument": ["instruments", "instrumentsByName"]
        };
        const reg = bot && bot.registry;
        const hint = HINTS[rid];
        let fixed = 0, modded = 0;
        if (hint && reg && reg[hint[0]] && reg[hint[1]]) {
          const arr = reg[hint[0]], byName = reg[hint[1]];
          names.forEach((full, id) => {
            if (!full) return;
            const nm = short(full);
            if (!String(full).startsWith("minecraft:")) modded++;
            const cur = arr[id];
            if (cur && cur.name === nm) return; // 原版项：保留（displayName/硬度等更完整）
            const obj = Object.assign({}, cur || {}, { id, name: nm, displayName: nm });
            if (obj.stackSize == null) obj.stackSize = 64;
            arr[id] = obj;
            byName[nm] = obj;
            fixed++;
          });
        }
        if (rid === "minecraft:item") global.__itemMap = names;
        console.log("[registry] " + rid + " " + count + " 项" +
          (hint ? "，注入/修正 " + fixed + (modded ? "（其中模组 " + modded + "）" : "") : "（无对应表，仅缓存）"));

        // 快照落盘（防抖 2s，抓完整一轮同步；供离线对比/排查）
        clearTimeout(global.__regSaveT);
        global.__regSaveT = setTimeout(() => {
          try { fs.writeFileSync(path.join(HERE, "payload-dump", "registry-maps.json"), JSON.stringify(global.__regMaps)); } catch (_) {}
          try { if (global.__regMaps["minecraft:item"]) fs.writeFileSync(path.join(HERE, "payload-dump", "item-id-map.json"), JSON.stringify(global.__regMaps["minecraft:item"])); } catch (_) {}
        }, 2000);
      } catch (e) { console.log("[registry] frozen_registry 解析失败:", e.message); }
    } else if (ch === "neoforge:feature_flags") {
      client.write("custom_payload", { channel: "neoforge:feature_flags_ack", data: Buffer.alloc(0) });
      sendConfigAck(); // 配置阶段：所有 config_file 已收集，统一应答（必答，否则握手卡死）
    } else if (ch === "neoforge:extensible_enum_data") {
      client.write("custom_payload", { channel: "neoforge:extensible_enum_ack", data: Buffer.alloc(0) });
    } else if (ch === "neoforge:known_registry_data_maps") {
      client.write("custom_payload", { channel: "neoforge:known_registry_data_maps_reply", data: varint(0) });
    } else if (ch === "neoforge:config_file") {
      // 配置文件流：服务端逐个下发 mod 配置文件（每条 = varint名字长度 + 名字 + varint数据长度 + 数据，无前置 count）。
      // 客户端须收集文件名并在配置阶段结束统一应答（ModConfigsAcknowledged）。
      // ⚠️ 旧代码错把第一条名字长度当成了 count，导致后续每一项整体错位、把配置内容读进文件名 → 回传畸形包被踢。
      try {
        const buf = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data || []);
        if (!global.__cfgDump) { global.__cfgDump = true; console.log("[cfg-raw] 首个 config_file 头 60 字节 hex: " + buf.subarray(0, 60).toString("hex")); }
        let off = 0;
        const rv = () => { let n = 0, s = 0; while (off < buf.length) { const b = buf[off++]; n |= (b & 0x7f) << s; if (!(b & 0x80)) break; s += 7; } return n; };
        let added = 0;
        while (off < buf.length) {
          const nl = rv();
          if (!(nl > 0 && nl < 8192 && off + nl <= buf.length)) break; // 名字长度非法 → 停止
          const nm = buf.toString("utf8", off, off + nl);
          off += nl;
          const dl = rv();
          if (!(dl >= 0 && off + dl <= buf.length)) { off = buf.length; break; } // 数据到包尾 → 停止
          off += dl;
          if (!_cfgNames.includes(nm)) { _cfgNames.push(nm); added++; }
        }
        console.log("[cfg] 解析 config_file 新增 " + added + "，累计 " + _cfgNames.length);
      } catch (e) { console.log("[cfg] 解析 config_file 失败:", e.message); }
    } else if (ch === "framework:configuration/config_data" || ch === "create_connected:sync_config" || ch === "framework:configuration/synced_entity_data") {
      // 这些是单向（服务端→客户端）配置推送，客户端无需回传；之前回传 client→server 会被服务端判为非法包 → ECONNRESET。
      console.log("[cfg] 收到单向配置通道 " + ch + " len=" + (p.data?.length ?? 0) + "（不回传）");
    } else {
      // 其他模组通道——只关注 waystones 与界面打开包（其余静默，防刷屏）
      const dlen = p.data?.length ?? 0;
      const isWs = ch.startsWith("waystones:");
      if (isWs && dlen <= 1200) console.log("[payload] " + ch + " len=" + dlen + (Buffer.isBuffer(p.data) && dlen <= 200 ? " hex=" + p.data.toString("hex") : ""));
      if (ch === "neoforge:advanced_open_screen") {
        lastOpenScreenAt = Date.now();
        global.__lastOpenScreenAt = lastOpenScreenAt; // 供 warp_stone 事件驱动释放
        console.log("[waystone] ★ 收到界面打开包 advanced_open_screen（" + dlen + "B）——石碑交互已触发");
        if (Buffer.isBuffer(p.data)) {
          try { fs.mkdirSync(path.join(HERE, "payload-dump"), { recursive: true }); fs.appendFileSync(path.join(HERE, "payload-dump", "open_screen-hex.log"), dlen + " " + p.data.toString("hex") + "\n"); } catch (e) {}
        }
      }
      if (isWs && Buffer.isBuffer(p.data) && dlen > 0) {
        // waystones 包全量落盘（含坐标数据），便于解析石碑位置
        try {
          const dir = path.join(HERE, "payload-dump");
          fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(path.join(dir, "waystones-hex.log"), ch + " " + dlen + " " + p.data.toString("hex") + "\n");
        } catch (e) { console.log("[payload] ws dump 失败:", e.message); }
        // 解析已知传送点列表（名字 + 坐标）
        if (ch === "waystones:known_waystones") parseKnownWaystones(p.data);
      }
    }
  });

  // 诊断：确认服务端是否下发 finish_configuration（配置阶段结束 → 进入 play 的前提）
  client.on("finish_configuration", () => console.log("[cfg] ★ 收到 finish_configuration（服务端结束配置阶段，客户端即将发 ack 进入 play）"));
  const _origWrite = client.write.bind(client);
  client.write = (name, params) => { if (name === "finish_configuration") { _afterFinish = true; console.log("[cfg] >> C->S finish_configuration（客户端 ack，进入 play）"); } return _origWrite(name, params); };

  // 接收 Create: Storage 喷气背包燃料同步（S2C）：fxntstorage:jetpack_fuel_sync(float, varlong, varint)
  client.on("custom_payload", (p) => {
    if (p.channel === "fxntstorage:jetpack_fuel_sync" && Buffer.isBuffer(p.data) && p.data.length >= 4) {
      try {
        CS_LAST_FUEL = p.data.readFloatBE(0);
        CS_FUEL_TIME = Date.now();
        const v2 = readVarLongBuf(p.data, 4);
        const v3 = readVarIntBuf(p.data, v2.next);
        console.log("[CS] 燃料同步 fuel=" + CS_LAST_FUEL.toFixed(1) + "s modifier=" + v3.value);
      } catch (e) { console.log("[CS] 燃料解析失败:", e.message); }
    }
  });

  client.on("select_known_packs", (data) => {
    client.write("select_known_packs", { packs: [{ namespace: "minecraft", id: "core", version: "1.21.1" }] });
  });
}

// ---- 工作系统 ----
function ts() { return new Date().toTimeString().slice(0, 8); }
// 向服务器简短播报（/me 形式，截断防超长）
function announce(text) {
  if (!bot || !bot.entity) return;
  try { bot.chat("" + String(text).slice(0, 80)); console.log("[播报]", text.slice(0, 80)); } catch (e) {}
}
// ---- 石碑数据（从 waystones:known_waystones 包解析：服务器全部传送点的名字+坐标）----
let gotoVersion = 0; // goto 链版本号（新 goto/stop 递增，旧 setTimeout 链自动作废）
let knownWaystones = []; // [{name, dim, x, y, z, icon}]
let lastOpenScreenAt = 0; // 最近一次收到"打开界面"包的时间（用于确认石碑交互成功）
const WAYSTONE_DIMS = ["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end", "aether:the_aether", "twilightforest:twilight_forest"];
function parseKnownWaystones(buf) {
  try {
    // v5 算法（已验证 79/79）：扫描 [len][waystones:xxx][08] 详情段；
    // uuid = 紧邻详情段起点前的 16 字节（可打印字符过多则判无效）
    const details = [];
    let i = 0;
    while (i < buf.length) {
      const L = buf[i];
      if (L >= 16 && L <= 45 && i + 1 + L < buf.length) {
        const s = buf.slice(i + 1, i + 1 + L).toString("ascii");
        // 仅匹配"干净命名空间标识符"（形如 namespace:id），避免从损坏缓冲里误匹配乱码中的 waystone 字节
        const isCleanId = /^[a-z0-9_]+:[a-z0-9_.\/]+$/i.test(s);
        if (isCleanId && (s.startsWith("waystones:") || s.toLowerCase().includes("waystone")) && buf[i + 1 + L] === 8) {
          const dstart = i;
          try {
            let j = i + 1 + L + 1 + 1; // skip len + str + 08 + 00
            const nl = buf[j]; const name = buf.slice(j + 1, j + 1 + nl).toString("utf8"); j += 1 + nl;
            const icon = buf[j]; j += 1;
            const dl = buf[j]; const dim = buf.slice(j + 1, j + 1 + dl).toString("ascii"); j += 1 + dl;
            if (j + 8 > buf.length) { i += 1; continue; }
            const lng = buf.readBigInt64BE(j); j += 8;
            let x = Number(lng >> 38n);
            if (x >= (1 << 25)) x -= (1 << 26);
            let z = Number((lng >> 12n) & 0x3ffffffn);
            if (z >= (1 << 25)) z -= (1 << 26);
            const y = Number(lng & 0xfffn);
            j += 1; j += 2; // 04 + 0000
            let uuid = null;
            if (dstart >= 16) {
              const cand = buf.slice(dstart - 16, dstart);
              let printable = 0;
              for (const b of cand) if (b >= 32 && b < 127) printable++;
              if (printable <= 12) uuid = cand.toString("hex");
            }
            if (Math.abs(x) < 5e6 && Math.abs(z) < 5e6 && y >= 0 && y <= 400) {
              details.push({ uuid, wtype: s, name, dim, x, y, z, icon });
            }
            i = j;
            continue;
          } catch (e) { /* 落空步进 */ }
        }
      }
      i += 1;
    }
    // 合并入 knownWaystones
    let added = 0;
    for (const d of details) {
      if (!d.name || d.x == null) continue;
      const exist = knownWaystones.find((w) => w.x === d.x && w.y === d.y && w.z === d.z);
      if (exist) {
        if (exist.name === "?" && d.name && d.name !== "?") exist.name = d.name;
        if (!exist.uuid && d.uuid) exist.uuid = d.uuid;
        if (!exist.wtype) exist.wtype = d.wtype;
        continue;
      }
      knownWaystones.push({ name: d.name, dim: d.dim, x: d.x, y: d.y, z: d.z, icon: d.icon, uuid: d.uuid, wtype: d.wtype });
      added++;
    }
    const uuidTotal = knownWaystones.filter((w) => w.uuid).length;
    if (added) console.log("[waystone] 新增 " + added + " 个传送点（共 " + knownWaystones.length + " 个，含 UUID 的 " + uuidTotal + " 个）");
  } catch (e) { console.log("[waystone] 解析失败:", e.message); }
}
function nearestWaystone() {
  if (!bot || !bot.entity || !knownWaystones.length) return null;
  const p = bot.entity.position;
  let best = null, bd = 1e18;
  for (const w of knownWaystones) {
    if (w.dim !== "minecraft:overworld") continue;
    const d = (w.x - p.x) ** 2 + (w.z - p.z) ** 2;
    if (d < bd) { bd = d; best = w; }
  }
  return best ? { ...best, dist: Math.round(Math.sqrt(bd)) } : null;
}
function findWaystoneByName(kw) {
  if (!knownWaystones.length) return null;
  const hits = knownWaystones.filter((w) => w.name.includes(kw) && w.dim === "minecraft:overworld");
  if (!hits.length) return null;
  const p = bot?.entity?.position;
  if (!p) return hits[0];
  hits.sort((a, b) => ((a.x - p.x) ** 2 + (a.z - p.z) ** 2) - ((b.x - p.x) ** 2 + (b.z - p.z) ** 2));
  return hits[0];
}
// best-effort：在背包里找名字/类型像"传送石 / warp stone"的物品（依赖背包可读性，本服可能读不到）
function findWarpStoneItem() {
  try {
    if (!bot || !bot.inventory) return null;
    const items = bot.inventory.items();
    for (const it of items) {
      const s = ((it.name || "") + " " + (it.type || "")).toLowerCase();
      if (s.includes("warp_stone") || s.includes("传送石") || (s.includes("warp") && s.includes("waystone"))) return it;
    }
  } catch (e) {}
  return null;
}
// 传送：支持两类目标。
//  · 普通传送石碑(waystones:waystone)：直接发 select_waystone（模组记忆上次界面）。
//  · 共享石碑(w_*_sharestone)/传送盘：服务器要求"先走到一个共享石碑、右键打开网络界面"才允许选目标
//    （且需消耗经验），所以这里先 openSharedStoneGui() 右键开界面，再发 select_waystone。
async function warpToByName(kw) {
  const hits = knownWaystones.filter((w) => w.name && w.name.includes(kw) && w.dim === "minecraft:overworld");
  if (!hits.length) return { ok: false, reason: "no_match", kw };
  const w = hits[0];
  if (!w.uuid) return { ok: false, reason: "no_uuid", name: w.name };
  // 普通传送石碑：保持原行为（直接发）
  if (isRegularWaystone(w.wtype)) {
    try {
      client.write("custom_payload", { channel: "waystones:select_waystone", data: Buffer.from(w.uuid, "hex") });
      return { ok: true, name: w.name, uuid: w.uuid, x: w.x, y: w.y, z: w.z };
    } catch (e) { return { ok: false, reason: "send_err", error: e.message }; }
  }
  // 共享石碑/传送盘等：先右键打开一个共享石碑的网络界面，再选目标传送
  console.log("[warp] 目标「" + w.name + "」是共享石碑，先打开共享石碑 GUI");
  const opened = await openSharedStoneGui(w.wtype, w.name);
  if (!opened) return { ok: false, reason: "gui_not_open", name: w.name, hint: "需要走到一个「同色」共享石碑并右键打开界面才能传送" };
  const before = bot && bot.entity ? { x: bot.entity.position.x, z: bot.entity.position.z } : null;
  try {
    client.write("custom_payload", { channel: "waystones:select_waystone", data: Buffer.from(w.uuid, "hex") });
  } catch (e) { return { ok: false, reason: "send_err", error: e.message }; }
  await new Promise((r) => setTimeout(r, 6000));
  if (!bot || !bot.entity) return { ok: false, reason: "disconnected" };
  const np = bot.entity.position;
  const moved = before ? Math.hypot(np.x - before.x, np.z - before.z) : 0;
  const success = moved > 20;
  if (!success) closeScreenSafe();
  return { ok: success, reason: success ? null : "warp_not_effective", name: w.name, wtype: w.wtype, moved: Math.round(moved), pos: { x: Math.round(np.x), z: Math.round(np.z) } };
}
// 走到最近的共享石碑并右键打开网络界面，返回是否成功打开（Promise<bool>）
// 彩色共享石碑只连同色网络，所以优先选与目标「同 wtype（同色）」的共享石碑；排除目标自身。
// 已在目标共享石碑 3.5 格内则直接右键当前方块，省去赶路。
function openSharedStoneGui(targetWtype, targetName) {
  return new Promise((resolve) => {
    const p = bot && bot.entity ? bot.entity.position : null;
    let shares = knownWaystones.filter((w) => isSharestone(w.wtype) && w.dim === "minecraft:overworld");
    if (!shares.length) { console.log("[warp] 没有可用共享石碑"); resolve(false); return; }
    // 同色优先：彩色共享石碑网络互不相通，必须用与目标同色的石碑才列得出目标
    if (targetWtype) {
      const same = shares.filter((w) => (w.wtype || "") === targetWtype && (w.name || "") !== (targetName || ""));
      if (same.length) shares = same;
    }
    shares.sort((a, b) => ((a.x - p.x) ** 2 + (a.z - p.z) ** 2) - ((b.x - p.x) ** 2 + (b.z - p.z) ** 2));
    const s = shares[0];
    console.log("[warp] 选用共享石碑「" + s.name + "」(" + s.wtype + ")@ " + s.x + "," + s.z + " 打开网络界面");
    // 已贴着某个共享石碑：原地右键它，不必再走
    if (p && Math.hypot(s.x - p.x, s.z - p.z) <= 3.5) {
      const Vec3c = p.constructor;
      const b = bot.blockAt(new Vec3c(s.x, s.y, s.z)) || null;
      if (b) {
        const tB = Date.now();
        bot.lookAt(new Vec3c(s.x + 0.5, s.y + 0.5, s.z + 0.5)).then(() => bot.activateBlock(b)).then(() => {
          setTimeout(() => resolve(lastOpenScreenAt >= tB), 1800);
        }).catch(() => resolve(false));
        return;
      }
    }
    gotoWaystoneAndOpen(s, (ok, err, opened) => {
      if (!ok) console.log("[warp] 共享石碑未打开:", String(err && err.message || "走不到"));
      resolve(opened);
    });
  });
}
// 使用主手传送石：best-effort 把背包里的传送石装备到主手，再右键触发（打开传送界面/直接传送）。
// 说明：本服 bot 背包视图可能读不到（window_items 解析失败），若背包里找不到传送石则直接右键当前主手物品，
// 只要传送石在主手即可触发。返回是否成功装备了物品。
async function useWarpStoneItem() {
  let it = null;
  try { it = findWarpStoneItem(); } catch (e) {}
  if (it) { try { await bot.equip(it, "hand"); } catch (e) {} }
  await bot.activateItem(false);
  await new Promise((r) => setTimeout(r, 150));
  try { bot.deactivateItem(); } catch (e) {}
  return { ok: true, equipped: !!it };
}
// 走到石碑坐标并右键交互
function gotoWaystoneAndOpen(w, onDone) {
  if (!bot || !bot.entity || !w) return;
  const Vec3c = bot.entity.position.constructor;
  myBotGoto(w.x, w.y, w.z, 2);
  let tries = 0;
  const check = () => {
    if (!bot || !bot.entity) return;
    tries++;
    const dist = bot.entity.position.distanceTo(new Vec3c(w.x, w.y, w.z));
    if (dist <= 3.5) {
      // 尝试该坐标及其上方一格（石碑可能是 2 格高）
      const b1 = bot.blockAt(new Vec3c(w.x, w.y, w.z));
      const b2 = bot.blockAt(new Vec3c(w.x, w.y + 1, w.z));
      const target = b2 && b2.name === null ? b2 : b1; // 优先未知方块（石碑本体）
      const b = target || b1;
      if (!b) { if (onDone) onDone(false, new Error("目标位置方块读不到"), false); return; }
      const tBefore = Date.now();
      bot.lookAt(new Vec3c(w.x + 0.5, w.y + 0.5, w.z + 0.5)).then(() => bot.activateBlock(b)).then(() => {
        setTimeout(() => {
          const opened = lastOpenScreenAt >= tBefore;
          console.log("[waystone] 已右键石碑「" + w.name + "」@ " + w.x + "," + w.y + "," + w.z + " 界面=" + (opened ? "已打开" : "未确认"));
          if (onDone) onDone(true, null, opened);
        }, 1800);
      }).catch((e) => { if (onDone) onDone(false, e, false); });
      return;
    }
    if (tries > 25) { if (onDone) onDone(false, new Error("走不到，剩 " + dist.toFixed(0) + " 格"), false); return; }
    setTimeout(check, 3000);
  };
  check();
}

// ---- 床 / 出生点：查询附近床，走到最近床右键设置出生点 ----
// 走到指定坐标并 await 到达（Promise）。range 内视为到达，超时（~40s）返回 false。
function walkToCoord(x, y, z, range) {
  return new Promise((resolve) => {
    if (!bot || !bot.entity) { resolve(false); return; }
    const r = range ?? 2;
    myBotGoto(x, y, z, r);
    let tries = 0;
    const Vec3c = bot.entity.position.constructor;
    const check = () => {
      if (!bot || !bot.entity) { resolve(false); return; }
      const d = bot.entity.position.distanceTo(new Vec3c(x, y, z));
      if (d <= r + 1.5) { resolve(true); return; }
      if (++tries > 40) { resolve(false); return; } // 40×1s ≈ 40s 上限
      setTimeout(check, 1000);
    };
    setTimeout(check, 1000);
  });
}
// 查询附近的床（name 含 "bed" 的方块），返回坐标+距离，按距离升序
function findBeds(radius) {
  try {
    const r = radius || 32;
    const positions = bot.findBlocks({
      matching: (b) => b && b.name && b.name.toLowerCase().includes("bed"),
      maxDistance: r, count: 100,
    });
    const p = bot.entity.position;
    return (positions || []).map((pos) => ({
      x: pos.x, y: pos.y, z: pos.z,
      dist: Math.round(Math.hypot(pos.x - p.x, pos.z - p.z)),
    })).sort((a, b) => a.dist - b.dist);
  } catch (e) { console.log("[bed] 查询失败:", e.message); return []; }
}
// 走到最近床并右键设置出生点（右键=activateBlock：白天写入重生点、夜晚睡觉亦写入）
async function setSpawnAtNearestBed(radius) {
  const beds = findBeds(radius || 32);
  if (!beds.length) return { ok: false, reason: "no_bed", radius: radius || 32 };
  const bed = beds[0];
  console.log("[bed] 找到最近床 @" + bed.x + "," + bed.y + "," + bed.z + "（" + bed.dist + " 格）");
  const reached = await walkToCoord(bed.x, bed.y, bed.z, 2);
  if (!reached) return { ok: false, reason: "cannot_reach", bed };
  const Vec3c = bot.entity.position.constructor;
  const block = bot.blockAt(new Vec3c(bed.x, bed.y, bed.z));
  if (!block) return { ok: false, reason: "bed_block_missing", bed };
  try {
    await bot.activateBlock(block);
    await new Promise((r) => setTimeout(r, 1200));
    return { ok: true, bed: { x: bed.x, y: bed.y, z: bed.z }, dist: bed.dist };
  } catch (e) { return { ok: false, reason: "activate_failed", error: e.message, bed }; }
}

// 3.6) 石碑之眼：识别附近"普通传送石碑"(wtype=waystones:waystone) 并激活（右键打开传送界面/发现）
// 自动：bot 空闲(无工作/无跟随)且不在战斗、血量正常时，每 6 秒扫描已知石碑列表里 16 格内普通石碑，自动走过去激活。
// 手动：@bot 激活石碑 / 激活附近waystone → 激活 40 格内最近的普通石碑。
let waystoneEyeTimer = null;
let waystoneEyeBusy = false;
const WS_EYE_RADIUS = 16;                  // 自动激活扫描半径（格）
const WS_EYE_MIN_DIST = 8;                 // 已在石碑 8 格内则跳过（避免对着脚下的反复开）
const WS_ACTIVATE_CD = 20 * 60 * 1000;    // 同一普通石碑 20 分钟内不重复激活
const wsActivated = new Map();             // "x,y,z" -> 上次激活时间戳
// "传送石碑"判定：右键激活才能使用的那种（区别于共享石碑）。
// 命名空间无关：只要 wtype 含 "waystone" 且不是 share、不是 warp_plate 即算"传送石碑"。
// 共享石碑（black/red/..._sharestone）无需激活（未激活也能被传送过去）→ 排除；
// warp_plate（传送盘）非石碑 → 排除。
const WS_REGULAR_TYPES = ["waystones:waystone"]; // 兼容旧写法
function isRegularWaystone(wtype) {
  if (!wtype || typeof wtype !== "string") return false;
  const t = wtype.toLowerCase();
  if (!t.includes("waystone")) return false;       // 必须含 waystone
  if (t.includes("share")) return false;           // 排除共享石碑
  if (t.includes("warp_plate")) return false;      // 排除传送盘
  return true;
}
function isSharestone(wtype) {
  return !!wtype && typeof wtype === "string" && wtype.toLowerCase().includes("share");
}

function regularWaystoneNear(radius) {
  if (!bot || !bot.entity || !knownWaystones.length) return null;
  const p = bot.entity.position;
  let best = null, bd = 1e18;
  for (const w of knownWaystones) {
    if (!isRegularWaystone(w.wtype)) continue;     // 仅"普通传送石碑"，排除传送盘/各色特殊石碑
    if (w.dim !== "minecraft:overworld") continue;
    if (w.name === "?") continue;                    // 无名坐标跳过
    const d = Math.hypot(w.x - p.x, w.z - p.z);
    if (d <= radius && d < bd) { bd = d; best = w; }
  }
  return best;
}
function closeScreenSafe() {
  try {
    if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); return; }
    if (typeof bot.closeScreen === "function") bot.closeScreen();
  } catch (e) { console.log("[ws-eye] 关界面:", e.message); }
}
function activateWaystone(w, cb) {
  if (!w) { if (cb) cb(false, new Error("无目标")); return; }
  wsActivated.set(w.x + "," + w.y + "," + w.z, Date.now());
  console.log("[ws-eye] 激活普通石碑「" + w.name + "」@ " + w.x + "," + w.y + "," + w.z);
  gotoWaystoneAndOpen(w, (ok, err, opened) => {
    if (ok) {
      setTimeout(closeScreenSafe, 1800); // 打开后延迟关界面，避免卡在传送菜单
      announce("[石碑] 已激活附近普通石碑「" + w.name + "」" + (opened ? "（传送界面已打开）" : "（已交互）"));
    } else {
      announce("[石碑] 激活「" + w.name + "」失败：" + String(err?.message || "").slice(0, 30));
    }
    if (cb) cb(ok, err);
  });
}
// 兜底：列表里还没有该传送石碑（尚未被发现）时，右键 bot 身边/面前的相邻方块。
// 模组石碑在 mineflayer 里是无名方块(name=null)，优先点 unknown 方块。
function activateAdjacentWaystone(cb) {
  if (!bot || !bot.entity) { if (cb) cb(false, new Error("bot 未就绪")); return; }
  const Vec3c = bot.entity.position.constructor;
  const p = bot.entity.position;
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
  const cands = [];
  for (const [dx, dy, dz] of dirs) {
    const b = bot.blockAt(p.offset(dx, dy, dz));
    if (b && b.type !== 0) cands.push(b); // type!==0 表示有方块
  }
  if (!cands.length) { if (cb) cb(false, new Error("四周没有可右键的方块")); return; }
  // 优先 unknown（name===null）方块，其次任意非空方块
  cands.sort((a, b) => (a.name === null ? -1 : 0) - (b.name === null ? -1 : 0));
  const b = cands[0];
  console.log("[ws-eye] 右键相邻方块 " + (b.name || "unknown") + " @" + b.position.x + "," + b.position.y + "," + b.position.z);
  bot.lookAt(new Vec3c(b.position.x + 0.5, b.position.y + 0.5, b.position.z + 0.5)).then(() => bot.activateBlock(b)).then(() => {
    setTimeout(() => { const opened = lastOpenScreenAt >= Date.now() - 2600; if (cb) cb(true, null, opened); }, 1800);
  }).catch((e) => { if (cb) cb(false, e); });
}
function startWaystoneEye() {
  if (waystoneEyeTimer) return;
  if (process.env.WAYSTONE_EYE_OFF === "1") { console.log("[ws-eye] 已被 WAYSTONE_EYE_OFF=1 关闭"); return; }
  waystoneEyeTimer = setInterval(() => {
    try {
      if (!bot || !bot.entity || !authed || waystoneEyeBusy) return;
      if (workMode || followTarget) return;                  // 工作/跟随中不抢戏
      if (combatTarget) return;                              // 战斗中不抢戏
      if (getMaxHealth && bot.health < getMaxHealth() * 0.35) return; // 低血不自扰
      const w = regularWaystoneNear(WS_EYE_RADIUS);
      if (!w) return;
      const key = w.x + "," + w.y + "," + w.z;
      if (Date.now() - (wsActivated.get(key) || 0) < WS_ACTIVATE_CD) return;
      const d = Math.hypot(w.x - bot.entity.position.x, w.z - bot.entity.position.z);
      if (d <= WS_EYE_MIN_DIST) return;                      // 已在跟前
      waystoneEyeBusy = true;
      activateWaystone(w, () => { setTimeout(() => { waystoneEyeBusy = false; }, 2000); });
    } catch (e) { console.log("[ws-eye] 异常:", e.message); }
  }, 6000);
  console.log("[ws-eye] 启动（识别 " + WS_EYE_RADIUS + " 格内普通传送石碑并自动激活）");
}

// ---- 服务器恢复后的自动石碑任务：进程内首次登录触发一次（用户要求：服务器重启后继续传送石碑任务）----
let autoWaystoneTaskDone = false;
function runWaystoneTaskOnce() {
  if (process.env.RUN_WAYSTONE_TASK !== "1") return; // 默认关闭：用户要求停止自动石碑测试播报（需要时 RUN_WAYSTONE_TASK=1 开启）
  if (autoWaystoneTaskDone) return;
  autoWaystoneTaskDone = true;
  setTimeout(async () => {
    try {
      announce("[石碑任务] 服务器恢复，开始传送石碑测试");
      // 等传送点数据（最多 150 秒）
      for (let i = 0; i < 75 && !knownWaystones.length; i++) await new Promise((r) => setTimeout(r, 2000));
      if (!knownWaystones.length) { announce("[石碑任务] 没收到传送点数据，跳过本次"); return; }
      let near = nearestWaystone();
      if (near && near.dist > 250) {
        announce("[石碑任务] 最近石碑 " + near.dist + " 格，先用 /spawn 回出生点");
        bot.chat("/spawn");
        await new Promise((r) => setTimeout(r, 4500));
        near = nearestWaystone();
      }
      if (!near) { announce("[石碑任务] 找不到可用石碑"); return; }
      announce("[石碑任务] 前往「" + near.name + "」石碑（" + near.dist + " 格）");
      gotoWaystoneAndOpen(near, (ok, err, opened) => {
        if (!ok) { announce("[石碑任务] 失败：走不到或交互异常（" + String(err?.message || "").slice(0, 30) + "）"); return; }
        if (!opened) { announce("[石碑任务] 右键了「" + near.name + "」，但界面未打开（服务器菜单状态仍未恢复）"); return; }
        announce("[石碑任务] 界面已打开！准备传送");
        // 选目标：优先与当前石碑相距 >100 格的已知点（造船厂/出生点/主城优先，否则取最远的便于验证）
        const cands = knownWaystones.filter((w) => w.uuid && w.dim === "minecraft:overworld");
        const far = cands.filter((w) => Math.hypot(w.x - near.x, w.z - near.z) > 100);
        const pool = (far.length ? far : cands).slice();
        const target = pool.find((w) => w.name.includes("造船"))
          || pool.find((w) => w.name.includes("出生点") || w.name.includes("枫落"))
          || pool.find((w) => w.name.includes("主城"))
          || pool.sort((a2, b2) => Math.hypot(b2.x - near.x, b2.z - near.z) - Math.hypot(a2.x - near.x, a2.z - near.z))[0];
        if (!target) { announce("[石碑任务] 没有可用传送目标（缺 UUID）"); return; }
        const before = { x: bot.entity.position.x, z: bot.entity.position.z };
        try {
          client.write("custom_payload", { channel: "waystones:select_waystone", data: Buffer.from(target.uuid, "hex") });
          console.log("[ws-task] 已发送传送包 → " + target.name + " uuid=" + target.uuid);
          announce("[石碑任务] 已发送传送 →「" + target.name + "」，等待结果");
        } catch (e) { announce("[石碑任务] 传送包发送失败：" + String(e.message).slice(0, 30)); return; }
        setTimeout(() => {
          if (!bot || !bot.entity) { announce("[石碑任务] 传送后掉线，无法确认结果"); return; }
          const np = bot.entity.position;
          const moved = Math.hypot(np.x - before.x, np.z - before.z);
          if (moved > 20) announce("[石碑任务] 传送成功！当前位置 " + Math.round(np.x) + " " + Math.round(np.z) + "（目标「" + target.name + "」）");
          else announce("[石碑任务] 传送未生效（位置没变），菜单状态可能未就绪");
        }, 6000);
      });
    } catch (e) { console.log("[ws-task] 异常:", e.message); }
  }, 8000);
}

// ---- 完整石碑测试：列出传送点 → 走过去打开界面 → 选远处目标传送 → 验证位移，返回分步报告 ----
// 复用 nearestWaystone / gotoWaystoneAndOpen / closeScreenSafe（与 runWaystoneTaskOnce 同源逻辑，但可随时触发、带结构化结果）。
async function test_waystone() {
  try {
    if (!bot || !bot.entity) return { ok: false, error: "bot 未就绪" };
    if (!knownWaystones.length) return { ok: false, error: "传送点数据未同步（等待 waystones:known_waystones 包）" };
    const report = { ok: true, steps: [] };
    const overworld = knownWaystones.filter((w) => w.dim === "minecraft:overworld");
    report.steps.push({ step: "sync", total: overworld.length, withUuid: overworld.filter((w) => w.uuid).length });
    let near = nearestWaystone();
    if (!near) return { ok: false, error: "主世界没有可用石碑" };
    // 太远则先回出生点（避免长途赶路超时）
    if (near.dist > 250) {
      bot.chat("/spawn");
      await new Promise((r) => setTimeout(r, 4500));
      near = nearestWaystone();
      if (!near) return { ok: false, error: "回出生点后仍无可用石碑" };
    }
    report.steps.push({ step: "goto", name: near.name, dist: near.dist });
    // 走过去并右键打开（界面打开才会发 select_waystone）
    const openRes = await new Promise((res) => {
      gotoWaystoneAndOpen(near, (ok, err, op) => res({ ok, err, op }));
    });
    report.steps.push({ step: "open", name: near.name, reached: openRes.ok, opened: openRes.op });
    if (!openRes.ok || !openRes.op) {
      report.steps.push({ step: "warp", skipped: true, reason: openRes.ok ? "界面未打开（服务器菜单状态可能未就绪）" : String(openRes.err?.message || "走不到") });
      report.ok = false;
      return report;
    }
    // 选远处目标传送（界面仍开着时发 select_waystone，与正常点目标一致）
    const cands = overworld.filter((w) => w.uuid);
    if (!cands.length) { report.steps.push({ step: "warp", skipped: true, reason: "没有带 UUID 的目标" }); report.ok = false; closeScreenSafe(); return report; }
    const far = cands.filter((w) => Math.hypot(w.x - near.x, w.z - near.z) > 100);
    const target = far[0] || cands.slice().sort((a, b) => Math.hypot(b.x - near.x, b.z - near.z) - Math.hypot(a.x - near.x, a.z - near.z))[0];
    const before = { x: bot.entity.position.x, z: bot.entity.position.z };
    report.steps.push({ step: "warp", to: target.name, uuid: target.uuid });
    client.write("custom_payload", { channel: "waystones:select_waystone", data: Buffer.from(target.uuid, "hex") });
    await new Promise((r) => setTimeout(r, 6000));
    const np = bot.entity.position;
    const moved = Math.hypot(np.x - before.x, np.z - before.z);
    report.steps.push({ step: "verify", moved: Math.round(moved), success: moved > 20, pos: { x: Math.round(np.x), z: Math.round(np.z) } });
    if (moved <= 20) { report.ok = false; closeScreenSafe(); } // 传送未生效，清理界面
    return report;
  } catch (e) { return { ok: false, error: e.message }; }
}

let mcDataBlocks = null;
try { mcDataBlocks = await import("minecraft-data").then((m) => m.default("1.21.1").blocksByName); } catch (e) { console.log("!! mc-data 加载失败:", e.message); }
let workMode = null, workTimer = null, noTargetCount = 0, patrolIdx = 0, patrolAnchors = [], dugCount = 0;
const WORK_NAMES = { log: "砍树", stone: "挖石", patrol: "巡逻" };
  function stopWork(reason) {
    if (workMode) {
      console.log("[work] 停止 " + (WORK_NAMES[workMode] || workMode) + (reason ? "（" + reason + "）" : ""));
      announce("⏸ " + (WORK_NAMES[workMode] || workMode) + "停止" + (reason ? "：" + reason : "") + "（共挖 " + dugCount + " 块）");
    }
    workMode = null; dugCount = 0;
    if (workTimer) { clearInterval(workTimer); workTimer = null; }
    stopFollow();
    if (bot && bot.entity) { try { bot.pathfinder.setGoal(null); } catch {} try { bot.clearControlStates(); } catch {} }
  }
  function findNearestBlock(names, maxDist = 32) {
    // 优先用运行时注册表（含服务器同步的模组方块，如 waystones:waystone），fallback 到静态 minecraft-data
    const reg = (bot && bot.registry && bot.registry.blocksByName) || mcDataBlocks;
    if (!reg) return null;
    const bag = new Set();
    for (const n of names) { if (reg[n]?.id != null) bag.add(reg[n].id); }
    if (!bag.size) {
      // 模糊匹配：注册表里名字包含任一关键词的方块（应对模组方块全名带命名空间）
      const allKeys = Object.keys(reg);
      for (const n of names) {
        for (const key of allKeys) {
          if (key.includes(n) && reg[key]?.id != null) bag.add(reg[key].id);
        }
      }
    }
    if (!bag.size) return null;
    try {
      return bot.findBlock({ matching: [...bag], maxDistance: maxDist, count: 256, useExtraInfo: false });
    } catch (e) { return null; }
  }
  // 列出注册表中名字包含关键词的方块（调试/探测用）
  function listBlocksMatching(keyword) {
    const reg = (bot && bot.registry && bot.registry.blocksByName) || mcDataBlocks;
    if (!reg) return [];
    return Object.keys(reg).filter((k) => k.includes(keyword)).slice(0, 40);
  }
  // 走近方块并右键交互（lookAt 精确瞄准 + activateBlock）——反作弊经验：交互前必须精确转向
  function walkAndActivate(block, onDone) {
    if (!bot || !bot.entity || !block) return;
    const target = block.position;
    const myBot = bot;
    let tries = 0;
    const check = () => {
      if (bot !== myBot || !myBot.entity) return;
      tries++;
      const p = myBot.entity.position;
      const dist = p.distanceTo(target);
      if (dist <= 3.5) {
        myBot.lookAt(target.offset(0.5, 0.5, 0.5)).then(() => {
          return myBot.activateBlock(block);
        }).then(() => {
          console.log("[activate] 已右键 " + block.name + " @" + Math.round(target.x) + "," + Math.round(target.y) + "," + Math.round(target.z));
          if (onDone) onDone(true);
        }).catch((e) => {
          console.log("[activate] 交互失败:", e.message);
          if (onDone) onDone(false, e);
        });
        return;
      }
      if (tries > 20) {
        console.log("[activate] 走不到目标（20 次尝试，剩 " + dist.toFixed(1) + " 格）");
        if (onDone) onDone(false, new Error("走不到，剩 " + dist.toFixed(1) + " 格"));
        return;
      }
      myBot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 2));
      setTimeout(check, 3000);
    };
    check();
  }
  function digBlockThen(b) {
    return bot.dig(b, true).then(() => {
      dugCount++;
      console.log("[work] 挖掉 " + b.name + " @" + Math.round(b.position.x) + "," + Math.round(b.position.y) + "," + Math.round(b.position.z));
      if (dugCount % 50 === 0) announce("[挖矿] 已挖 " + dugCount + " 块" + (WORK_NAMES[workMode] === "砍树" ? "木" : "石"));
      // 挖完原地等待掉落物拾取（1 秒），掉落物在 pickup 半径内自动进背包
      return new Promise((r) => setTimeout(r, 1000));
    });
  }
  function workTick() {
    if (!workMode || !bot || !bot.entity || bot.pathfinder?.goal) return; // 正在走/挖就不打断
    if (bot.targetDigBlock) return; // 正在挖同一个方块，等待完成
    if (bot.health <= 6) { stopWork("血量过低自保"); bot.chat("血量过低，先撤了！"); return; }
    if (workMode === "log" || workMode === "stone") {
      const names = workMode === "log"
        ? ["oak_log", "birch_log", "spruce_log", "jungle_log", "dark_oak_log", "acacia_log", "mangrove_log", "cherry_log"]
        : ["stone", "cobblestone", "deepslate", "andesite", "granite", "diorite", "coal_ore", "iron_ore"];
      const target = findNearestBlock(names, 32);
      if (!target) {
        noTargetCount++;
        if (noTargetCount >= 3) { announce("⚠ 附近 32 格没找到" + (workMode === "log" ? "树" : "石头") + "，先停工"); bot.chat("" + (workMode === "log" ? "附近 32 格没有树了" : "附近没有可挖的石头了") + "，休息一下"); stopWork("无目标"); noTargetCount = 0; }
        return;
      }
      noTargetCount = 0;
      const d = target.position.distanceTo(bot.entity.position);
      if (d < 4.5) {
        // 够近：直接挖
        digBlockThen(target).catch((e) => console.log("[work] dig 失败:", e.message));
      } else {
        // 远：寻路过去
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1));
        } catch (e) { console.log("[work] goto 失败:", e.message); }
      }
    } else if (workMode === "patrol") {
      const p = bot.entity.position;
      const anchors = patrolAnchors.length ? patrolAnchors : [{ x: p.x + 10, z: p.z }, { x: p.x, z: p.z + 10 }];
      const anchor = anchors[patrolIdx % anchors.length];
      patrolIdx++;
      try {
        bot.pathfinder.setGoal(new goals.GoalNear(anchor.x, anchor.y ?? p.y, anchor.z, 2));
        console.log("[work] 巡逻 → " + Math.round(anchor.x) + "," + Math.round(anchor.z));
      } catch (e) { console.log("[work] 巡逻 goto 失败:", e.message); }
    }
  }
  function startWork(mode, opts = {}) {
    if (!bot || !bot.entity) return false;
    stopWork();
    workMode = mode;
    noTargetCount = 0;
    patrolIdx = 0;
    if (mode === "patrol" && opts.anchors) patrolAnchors = opts.anchors;
    workTimer = setInterval(workTick, 2500);
    console.log("[work] 开始 " + (WORK_NAMES[mode] || mode));
    return true;
  }

// ---- @ 实时自动回复 + 指令执行 ----
// 触发：玩家聊天正文 @ bot（[world] <player>: @bot_one 过来），或 TrChat mention 提示。
// 指令：过来→寻路 / 砍树→log / 挖矿→stone / 巡逻→patrol / 停→stop。工作指令执行真正的 startWork/goto。
let lastAutoReplyBy = {}; // 按玩家分别限频，避免 A 的 @ 影响 B 的回复
let followTarget = null; // 持续跟随目标玩家名
let followTimer = null;  // 跟随定时器
// ---- 玩家加入欢迎 ----
// 服务器广播格式："xxx joined the game"（实测行首纯文本）。5 分钟内同名玩家只欢迎一次。
const welcomedPlayers = {};
function checkPlayerJoin(t) {
  if (/<[^>]+>/.test(t)) return; // 玩家聊天格式（含 <名字>），跳过防误判
  const clean = t.replace(/^§./, ""); // 去掉颜色代码前缀
  const m = clean.match(/^(\w{2,16}) joined the game/) || clean.match(/^([^\s<]{2,16}) 加入了游戏/);
  if (!m) return;
  const name = m[1];
  if (name.toLowerCase() === USER.toLowerCase()) return; // 不欢迎自己（含重连时自己的加入广播）
  const now = Date.now();
  if (welcomedPlayers[name] && now - welcomedPlayers[name] < 300000) return; // 5 分钟去重
  welcomedPlayers[name] = now;
  console.log("[welcome] 玩家 " + name + " 加入 → 发送欢迎");
  setTimeout(() => {
    if (bot && bot.entity) bot.chat("欢迎 " + name + " 来到服务器！");
  }, 2500);
}

const SYS_HINTS = ["joined the game", "left the game", "made the advancement", "[玩家系统]", "清理", "垃圾桶", "Tempus fugit", "is now sleeping", "welcome", "欢迎"];
function tryMentionReply(t) {
  if (!bot || !bot.entity) return;
  // 防自触发：自己的消息（[world] <bot_one>: ...）
  if (new RegExp("<" + USER + ">").test(t)) return;
  // 系统消息忽略（mention 提示放行）
  const isMentionHint = /\| Player \w+ mentioned you/.test(t);
  if (!isMentionHint && SYS_HINTS.some((h) => t.includes(h))) return;

  // 触发：玩家聊天正文 @ bot（含 bot_one/bot_two，兼容新旧命名）
  let player = null;
  let content = "";
  let greetingReply = false; // 随机问候后的对话延续
  const mChat = t.match(/\[world\]\s*<(\w+)>[:：]?\s*(.*)/) || t.match(/<(\w+)>[:：]?\s*(.*)/);
  const _mentionRe = new RegExp("bot[_-]?one|bot[_-]?two|" +
      (USER || "bot_one").replace(/[^a-zA-Z0-9_]/g, "[_-]?"), "i");
  if (mChat && _mentionRe.test(mChat[2] || "")) {
    player = mChat[1];
    content = mChat[2] || "";
  }
  // 随机问候的会话延续：窗口期内该玩家发言（即使没 @ 名字）也接话
  if (!player && mChat && greetActive.has(mChat[1])) {
    const exp = greetActive.get(mChat[1]);
    if (Date.now() < exp) { player = mChat[1]; content = mChat[2] || ""; greetingReply = true; }
    else greetActive.delete(mChat[1]);
  }
  // mention 提示兜底（无正文时）
  if (!player) {
    const mM = t.match(/\| Player (\w+) mentioned you/);
    if (mM) player = mM[1];
  }
  if (!player) return;
  if (player.toLowerCase() === USER.toLowerCase()) return;

  // 指令判定提前：预设唤醒指令（经验/位置/过来/砍树等）→ 只回复问的，不做寒暄接话
  const cmdText = content || t;
  const isWorkCmd = /过来|跟我来|跟我走|跟着我|跟着|come|follow|砍树|伐木|木头|log|挖矿|挖石|石头|mine|巡逻|patrol|停|休息|stop|回家|回出生点|回城|回主城|spawn|home|睡觉|去睡|sleep|吃东西|吃饭|进食|饿了|eat|附近|周围|有什么|找牛|找羊|找猪|找鸡|找动物|找玩家|有人吗|有怪|怪物|时间|几点|石碑|传送石|指路石|waystone|传送点|经验|等级|级别|xp|经验值|几级|多少级|level|位置|坐标|在哪/i.test(cmdText)
    || knownWaystones.some((w) => w.name !== "?" && cmdText.includes(w.name)); // 含已知传送点名 → 即时指令
  const now = Date.now();
  if (isWorkCmd) greetActive.delete(player); // 指令应答后关闭寒暄窗口：后续"1/好的"不再触发 LLM 接话

  // 问候对话延续：仅纯聊天时 LLM 接话（6 秒间隔，窗口续期 10 分钟）；预设指令直接走下方分发
  if (greetingReply && !isWorkCmd) {
    const nowG = now;
    if (nowG - (lastAutoReplyBy[player] || 0) < 6000) return;
    lastAutoReplyBy[player] = nowG;
    greetActive.set(player, nowG + 10 * 60 * 1000);
    console.log("[greet] " + player + " 回复：「" + content.slice(0, 40) + "」→ LLM 接话");
    askLLM("你刚才在服务器里向玩家 " + player + " 打招呼，对方回复：「" + content + "」。请自然地接着聊下去，口语化，一句话不超过 30 字。").then((reply) => {
      if (!reply) return;
      const clean = reply.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
      setTimeout(() => { if (bot && bot.entity) bot.chat("@" + player + " " + clean); }, 500);
    });
    return;
  }

  // 限频 20 秒只针对寒暄话术；工作指令不受限
  const lastForPlayer = lastAutoReplyBy[player] || 0;
  if (!isWorkCmd && now - lastForPlayer < 20000) { console.log("[mention] " + player + " @ 了 bot，限频中未回复"); return; }
  if (!isWorkCmd) lastAutoReplyBy[player] = now;

  const p = bot.entity.position;

  // 指令：过来 → 寻路到说话人（一次性）
  if (/过来|来我这|come/.test(cmdText)) {
    const who = bot.players[player] || Object.values(bot.players).find((pl) => pl.username && pl.username.toLowerCase().includes(player.toLowerCase()));
    const pe = who?.entity?.position;
    if (pe) {
      stopFollow();
      startWork(null);
      myBotGoto(pe.x, pe.y, pe.z, 2);
      bot.chat("@" + player + " 好的，马上过来！（目标 " + Math.round(pe.x) + "," + Math.round(pe.z) + "）");
      console.log("[mention] → 走向 " + player + " @" + Math.round(pe.x) + "," + Math.round(pe.z));
      return;
    }
    bot.chat("@" + player + " 想过去但看不到你的位置，走近一点我再过来");
    return;
  }
  // 指令：跟我走 → 持续跟随
  if (/跟我走|跟着我|跟着|follow/.test(cmdText)) {
    const who = bot.players[player] || Object.values(bot.players).find((pl) => pl.username && pl.username.toLowerCase().includes(player.toLowerCase()));
    const pe = who?.entity?.position;
    if (pe) {
      startWork(null);
      startFollow(player);
      bot.chat("@" + player + " 好，跟着你走！（保持 3 格内，说「停」我就停下）");
      console.log("[mention] → 跟随 " + player);
      return;
    }
    bot.chat("@" + player + " 看不到你的位置，走近一点我再跟");
    return;
  }
  // 指令：问经验值/等级 → 回复当前等级
  if (/经验|等级|级别|xp|经验值|几级|多少级|level/i.test(cmdText)) {
    const xp = bot.experience || {};
    const lvl = xp.level != null ? xp.level : 0;
    const prog = Math.round((xp.progress != null ? (xp.progress || 0) : 0) * 100);
    bot.chat("@" + player + " 我当前经验等级 Lv." + lvl + "（本级进度 " + prog + "%）");
    console.log("[mention] → 经验等级查询：Lv." + lvl);
    return;
  }
  // 指令：实体感知（附近有什么 / 找牛 / 找玩家 / 有怪吗）——对标 aiplayer entity_groups
  if (/附近|周围|有什么|找牛|找羊|找猪|找鸡|找动物|找玩家|有人吗|有怪|怪物/.test(cmdText)) {
    const me2 = bot.entity.position;
    const wantAnimal = /牛|cow/.test(cmdText) ? "cow" : /羊|sheep/.test(cmdText) ? "sheep" : /猪|pig/.test(cmdText) ? "pig" : /鸡|chicken/.test(cmdText) ? "chicken" : null;
    const wantPlayer = /玩家|有人/.test(cmdText);
    const wantHostile = /有怪|怪物|敌对|危险/.test(cmdText);
    const found = [];
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (!e || e === bot.entity || !e.position) continue;
      const dist = e.position.distanceTo(me2);
      if (dist > 64) continue;
      const nm = String(e.name || e.type || "");
      if (wantAnimal && !nm.includes(wantAnimal)) continue;
      if (wantPlayer && e.type !== "player") continue;
      if (wantHostile && !HOSTILE_HINTS.some((h) => nm.includes(h))) continue;
      found.push({ label: e.username || e.displayName || e.name || e.type, dist: Math.round(dist), pos: e.position });
    }
    found.sort((a, b) => a.dist - b.dist);
    if (found.length) {
      bot.chat("@" + player + " " + found.slice(0, 3).map((f) => f.label + " 在 " + Math.round(f.pos.x) + "," + Math.round(f.pos.z) + "（" + f.dist + "格）").join("；"));
    } else {
      bot.chat("@" + player + " " + (wantAnimal ? "64 格内没找到这种动物" : wantPlayer ? "64 格内没看到其他玩家" : wantHostile ? "64 格内没有怪物" : "64 格内没发现什么"));
    }
    console.log("[mention] → 实体查询：" + cmdText.slice(0, 30));
    return;
  }
  // 指令：时间查询（对标 aiplayer night 字段：isDay 不可信，用 timeOfDay）
  if (/时间|几点|白天|晚上/.test(cmdText)) {
    const t0 = bot.time?.timeOfDay ?? 0;
    const phase = t0 < 6000 ? "早上" : t0 < 12000 ? "白天" : t0 < 13800 ? "黄昏" : t0 < 22200 ? "夜晚" : "深夜";
    bot.chat("@" + player + " 现在是" + phase + "（dayTime " + t0 + "）" + (isNightTime() ? "，我去找床睡觉" : ""));
    return;
  }
  // 指令：激活附近普通传送石碑（仅挑 wtype=waystones:waystone，区别于通用"石碑"指令）
  if (/激活/.test(cmdText) && /(石碑|waystone|传送石)/.test(cmdText)) {
    stopFollow(); startWork(null);
    if (!knownWaystones.length) { bot.chat("@" + player + " 石碑数据还没同步，稍等再叫我"); return; }
    const w = regularWaystoneNear(40);
    if (!w) {
      // 兜底：列表里没有（尚未被发现）→ 右键你身边的相邻方块，尝试激活新传送石碑
      bot.chat("@" + player + " 附近列表里没有传送石碑，试试右键你身边的方块");
      waystoneEyeBusy = true;
      activateAdjacentWaystone((ok, err, opened) => {
        waystoneEyeBusy = false;
        if (ok && opened) bot.chat("@" + player + " 已激活身边的石碑（传送界面已打开）");
        else if (ok) bot.chat("@" + player + " 已右键身边方块（界面未确认，可能那不是石碑）");
        else bot.chat("@" + player + " 身边没有可激活的方块：" + String(err?.message || "").slice(0, 30));
      });
      return;
    }
    const d0 = Math.round(Math.hypot(w.x - bot.entity.position.x, w.z - bot.entity.position.z));
    bot.chat("@" + player + " 去激活「" + w.name + "」普通石碑（" + d0 + " 格）");
    console.log("[mention] → 激活普通石碑「" + w.name + "」");
    waystoneEyeBusy = true;
    activateWaystone(w, (ok, err, opened) => {
      waystoneEyeBusy = false;
      if (ok && opened) bot.chat("@" + player + " 已激活「" + w.name + "」（传送界面已打开）");
      else if (ok) bot.chat("@" + player + " 已右键「" + w.name + "」（界面未确认）");
      else bot.chat("@" + player + " 激活失败：" + String(err?.message || "").slice(0, 30));
    });
    return;
  }
  // 指令：传送到某传送点（@bot 传送到 主城 / 用传送石传送到 XXX）
  // 传送石碑(waystones:waystone) → 直接发 select_waystone 包（任意位置传送，无需靠近）；
  // 共享石碑 → 传送石不能传它，改为走过去用界面传送。
  if (/传送到|传送去|用传送石|传送石.*传送/.test(cmdText) && knownWaystones.length) {
    stopFollow(); startWork(null);
    let tgt = null;
    for (const w of knownWaystones) {
      if (w.dim === "minecraft:overworld" && w.name !== "?" && w.name.length >= 2 && cmdText.includes(w.name)) { tgt = w; break; }
    }
    if (!tgt) { bot.chat("@" + player + " 没找到要传送的传送点，试试说「传送到 <名字>」"); return; }
    // 改用 travelToWaystone：不走到目标石碑，而是用传送石/最近同类型石碑中转（共享石碑走最近同色中转）
    travelToWaystone(tgt, (m) => bot.chat("@" + player + " " + m));
    return;
  }
  // 指令：激活"我旁边的传送石碑"（你站在某个传送石碑旁，让 bot 右键激活它）
  // 适用：服务器同步列表里没有该传送石碑（bot 无法从列表找到），需你指认现场方块
  if (/激活.*(旁边|身边|附近).*(传送石碑|waystone)|(旁边|身边|附近).*激活.*(传送石碑|waystone)/.test(cmdText)) {
    stopFollow(); startWork(null);
    bot.chat("@" + player + " 我看看你身边的方块，尝试激活传送石碑…");
    waystoneEyeBusy = true;
    activateAdjacentWaystone((ok, err, opened) => {
      waystoneEyeBusy = false;
      if (ok && opened) bot.chat("@" + player + " 已激活你身边的传送石碑（传送界面已打开）");
      else if (ok) bot.chat("@" + player + " 已右键身边方块（界面未确认，可能那不是传送石碑）");
      else bot.chat("@" + player + " 身边没有可右键的方块：" + String(err?.message || "").slice(0, 30));
    });
    return;
  }
  // 指令：用传送石（右手持传送石时点它 → 右键触发，打开传送界面/直接传送）
  if (/^用传送石$|^传送石$|用传送石\b/.test(cmdText) && !/传送到|传送去/.test(cmdText)) {
    stopFollow(); startWork(null);
    bot.chat("@" + player + " 我右键使用主手的传送石…（请确保传送石已拿在手上）");
    (async () => {
      try {
        const r = await useWarpStoneItem();
        bot.chat("@" + player + " 已触发传送石（" + (r.equipped ? "已装备到主手" : "直接右键主手物品") + "）");
      } catch (e) {
        bot.chat("@" + player + " 使用传送石失败：" + String(e.message || "").slice(0, 30));
      }
    })();
    return;
  }
  // 指令：石碑（从传送点列表找最近的/按名字 → 前往右键交互）
  if (/石碑|传送石|指路石|waystone|传送点/.test(cmdText)) {
    stopFollow();
    startWork(null);
    if (!knownWaystones.length) {
      bot.chat("@" + player + " 石碑数据还没同步，稍等一下再叫我");
      return;
    }
    let wy = null;
    for (const cand of knownWaystones) {
      if (cand.dim === "minecraft:overworld" && cand.name !== "?" && cmdText.includes(cand.name)) { wy = cand; break; }
    }
    if (!wy) wy = nearestWaystone();
    if (!wy) { bot.chat("@" + player + " 没找到合适的石碑"); return; }
    const d0 = Math.round(Math.sqrt((wy.x - bot.entity.position.x) ** 2 + (wy.z - bot.entity.position.z) ** 2));
    if (/在哪|哪里|位置|有没有|找/.test(cmdText) && !/去|到|打开|过去|传送/.test(cmdText)) {
      bot.chat("@" + player + " 「" + wy.name + "」石碑在 " + wy.x + "," + wy.z + "（" + d0 + " 格）");
      return;
    }
    // 前往：不走到目标石碑，改用 travelToWaystone（传送石/最近同类型石碑中转；共享石碑走最近同色中转）
    bot.chat("@" + player + " 前往「" + wy.name + "」（" + d0 + " 格），用传送石或最近同类型石碑传送过去，不走过去");
    console.log("[mention] → 石碑「" + wy.name + "」@" + wy.x + "," + wy.z);
    travelToWaystone(wy, (m) => bot.chat("@" + player + " " + m));
    return;
  }
  // 指令：去某地点（名字命中已知传送点）——如"去主城""去商店""去铸炮厂"
  if (/去|到|打开|前往|传送/.test(cmdText) && knownWaystones.length) {
    let wy2 = null;
    for (const cand of knownWaystones) {
      if (cand.dim === "minecraft:overworld" && cand.name !== "?" && cand.name.length >= 2 && cmdText.includes(cand.name)) { wy2 = cand; break; }
    }
    if (wy2) {
      stopFollow();
      startWork(null);
      const d2 = Math.round(Math.sqrt((wy2.x - bot.entity.position.x) ** 2 + (wy2.z - bot.entity.position.z) ** 2));
      bot.chat("@" + player + " 去「" + wy2.name + "」？用传送石或最近同类型石碑传送过去，不走过去（" + d2 + " 格）");
      console.log("[mention] → 传送点「" + wy2.name + "」@" + wy2.x + "," + wy2.z);
      travelToWaystone(wy2, (m) => bot.chat("@" + player + " " + m));
      return;
    }
  }
  // 指令：回家 → /spawn 回出生点
  if (/回家|回出生点|回城|回主城|回基地|spawn|home/.test(cmdText)) {
    stopFollow();
    startWork(null);
    const before = { x: Math.round(p.x), z: Math.round(p.z) };
    bot.chat("/spawn");
    bot.chat("@" + player + " 好的，回出生点！");
    console.log("[mention] → 回家 /spawn（from " + before.x + "," + before.z + "）");
    setTimeout(() => {
      if (!bot || !bot.entity) return;
      const np = bot.entity.position;
      if (Math.abs(np.x - before.x) > 1 || Math.abs(np.z - before.z) > 1) {
        announce("[回家] 已回出生点 (" + Math.round(np.x) + "," + Math.round(np.z) + ")");
      } else {
        announce("⚠ 回出生点失败，仍在 " + Math.round(np.x) + "," + Math.round(np.z));
      }
    }, 2500);
    return;
  }
  // 指令：睡觉 → 找床 + sleep
  if (/睡觉|去睡|睡一觉|sleep/.test(cmdText)) {
    stopFollow();
    startWork(null);
    try {
      const bed = bot.findBlock({ matching: (b) => b && b.name && b.name.toLowerCase().includes("bed"), maxDistance: 40 });
      if (bed) {
        bot.chat("@" + player + " 找到床了，去睡觉");
        myBotGoto(bed.position.x, bed.position.y, bed.position.z, 2);
        setTimeout(async () => {
          try {
            const bb = bot.blockAt(bed.position);
            if (bb && !bot.isSleeping) await bot.sleep(bb);
            announce("[睡觉] 已躺下睡觉");
            console.log("[sleep] 已躺下");
          } catch (e) { console.log("[sleep] 失败:", e.message); announce("⚠ 睡觉失败：" + String(e.message).slice(0, 40)); }
        }, 4000);
        return;
      }
    } catch (e) { console.log("[sleep] 找床失败:", e.message); }
    bot.chat("@" + player + " 附近没找到床，先回出生点");
    bot.chat("/spawn");
    return;
  }
  // 指令：吃东西
  if (/吃东西|吃饭|进食|饿了|eat/.test(cmdText)) {
    stopFollow();
    startWork(null);
    const foods = bot.inventory.items().filter((it) => it && it.name && (it.name.includes("bread") || it.name.includes("apple") || it.name.includes("porkchop") || it.name.includes("beef") || it.name.includes("cooked") || it.name.includes("potato") || it.name.includes("carrot") || it.name.includes("berry") || it.name.includes("cookie") || it.name.includes("melon") || it.name.includes("golden")));
    if (foods.length) {
      const f = foods[0];
      const fname = f.displayName || f.name;
      const beforeFood = bot.food;
      bot.equip(f, "hand").then(() => bot.consume()).then(() => {
        console.log("[eat] 吃了 " + fname);
        announce("[进食] 吃了" + fname + "（food " + beforeFood + "→" + bot.food + "）");
        bot.chat("@" + player + " 吃了个" + fname + "，饱了！");
      }).catch((e) => console.log("[eat] 失败:", e.message));
      bot.chat("@" + player + " 好，吃东西（" + fname + "）");
      return;
    }
    bot.chat("@" + player + " 背包里没有可吃的食物");
    return;
  }
  // 指令：砍树
  if (/砍树|伐木|木头|log/.test(cmdText)) { stopFollow(); startWork("log"); bot.chat("@" + player + " 收到！开始砍树"); return; }
  // 指令：挖矿
  if (/挖矿|挖石|石头|石子|mine|cobble/.test(cmdText)) { stopFollow(); startWork("stone"); bot.chat("@" + player + " 收到！开始挖石"); return; }
  // 指令：巡逻
  if (/巡逻|转转|逛逛|patrol/.test(cmdText)) {
    stopFollow();
    startWork("patrol", { anchors: [{ x: p.x + 12, z: p.z }, { x: p.x, z: p.z + 12 }, { x: p.x - 12, z: p.z }] });
    bot.chat("@" + player + " 收到！开始巡逻");
    return;
  }
  // 指令：停止
  if (/停|休息|够了|stop/.test(cmdText)) { stopFollow(); stopWork("收到停止指令"); bot.chat("@" + player + " 好的，收工！"); return; }

  // 指令：测试石碑（完整流程：列出→打开→传送→验证）
  if (/测试石碑|测石碑|石碑测试|test.?waystone/.test(cmdText)) {
    stopFollow(); startWork(null);
    bot.chat("@" + player + " 开始测试石碑传送，稍等…");
    test_waystone().then((r) => {
      if (!r.ok) { bot.chat("@" + player + " 石碑测试未通过：" + (r.error || JSON.stringify(r.steps))); return; }
      const v = r.steps.find((s) => s.step === "verify");
      const wp = r.steps.find((s) => s.step === "warp");
      bot.chat("@" + player + " 石碑测试通过！传送" + (v ? v.moved : "?") + " 格到达「" + (wp ? wp.to : "") + "」，当前坐标 " + (v ? (v.pos.x + " " + v.pos.z) : ""));
    });
    return;
  }

  // 指令：超越维度模组（维度网络存储）
  if (/维度网络|维度网|beyonddimension|打开网络|开网络|网络界面|磁铁|切网络|网络切换|存.*网络|收.*网络|放.*网络|取.*网络|从网络|网络里|网络有/.test(cmdText)) {
    stopFollow(); startWork(null);
    const say = (m) => bot.chat("@" + player + " " + m);
    // 打开维度网络界面（不含 存/取/看 等子意图）
    if (/打开网络|开网络|网络界面|维度网络|维度网/.test(cmdText) && !/存|收|放|取|拿|看|列|有|查/.test(cmdText)) {
      const r = bdOpenNetwork(false);
      say(r.ok ? "已打开维度网络存储界面" : "打开失败：" + (r.error || ""));
      return;
    }
    // 开关磁铁
    if (/磁铁/.test(cmdText)) {
      const r = bdToggleMagnet(0);
      say(r.ok ? "已切换磁铁状态" : "失败：" + (r.error || ""));
      return;
    }
    // 切换主网络
    if (/切网络|网络切换|切换网络|换网络|网络切换器/.test(cmdText)) {
      const r = bdOpenSwitcher();
      say(r.ok ? "已打开网络切换器" : "失败：" + (r.error || ""));
      return;
    }
    // 查看网络内容
    if (/看|列|有|查|什么|清单|列表|里面/.test(cmdText)) {
      bdReadNet().then((r) => {
        if (!r.ok) { say("读取失败：" + (r.error || "")); return; }
        if (!r.items || !r.items.length) { say("网络里是空的"); return; }
        const top = r.items.slice(0, 12).map((s) => s.item + "×" + s.count).join("、");
        say("网络里有 " + r.items.length + " 种：" + top + (r.items.length > 12 ? " …" : ""));
      });
      return;
    }
    // 存物品进网络
    if (/存|收|放|入库|进网络/.test(cmdText)) {
      const item = bdExtractItemName(cmdText);
      if (!item) { say("想存什么？说「把 <物品> 存进网络」"); return; }
      bdDeposit(item).then((r) => say(r.ok ? ("已把 " + (r.item || item) + "×" + (r.count || "") + " 存入网络") : "存入失败：" + (r.error || "")));
      return;
    }
    // 从网络取物品
    if (/取|拿|出|领|提取|取出/.test(cmdText)) {
      const item = bdExtractItemName(cmdText);
      if (!item) { say("想取什么？说「从网络拿 <物品>」"); return; }
      bdWithdraw(item).then((r) => say(r.ok ? ("已取出 " + item + " 到主手") : "取出失败：" + (r.error || "")));
      return;
    }
    say("维度网络指令：打开网络 / 磁铁 / 切网络 / 看网络 / 存 <物品> / 取 <物品>");
    return;
  }

  // 指令：超越维度 — 连接符绑定 / 喂食护符 / 自动喂食
  if (/绑定|连接符|喂食护符|护符|进食|吃饭|饿|自动喂食|开喂食|关喂食/.test(cmdText)) {
    stopFollow(); startWork(null);
    const say = (m) => bot.chat("@" + player + " " + m);
    // 绑定网络（右键管理员连接符 → 成为管理员并设主网络）
    if (/绑定|连接符/.test(cmdText)) {
      bdBindNetwork().then((r) => say(r.ok ? "已右键连接符绑定网络（连接符已消耗，O 键可开维度网络）" : "绑定失败：" + (r.error || "")));
      return;
    }
    // 装备喂食护符（进 Curios 饰品栏；背包内也会自动喂食）
    if (/喂食护符|护符|装备/.test(cmdText)) {
      bdEquipFeeder().then((r) => say(r.ok ? ("喂食护符已就位（" + (r.curios || "") + "），饥饿时自动进食") : "装备失败：" + (r.error || "")));
      return;
    }
    // 立即进食（从维度网络取白名单食物）
    if (/进食|吃饭|饿|吃/.test(cmdText)) {
      bdFeedNow().then((r) => say(r.ok ? ("已进食：" + r.ate) : "进食失败：" + (r.error || "")));
      return;
    }
    // 自动喂食开关（bot 侧兜底）
    if (/自动喂食|开喂食|关喂食/.test(cmdText)) {
      const on = /开|启|开始/.test(cmdText) && !/关|停|结束/.test(cmdText);
      const r = on ? bdStartFoodMonitor() : bdStopFoodMonitor();
      say(r.ok ? (on ? "已开启 bot 侧兜底自动喂食" : "已关闭 bot 侧兜底自动喂食") : "失败：" + (r.error || ""));
      return;
    }
    say("喂食护符指令：绑定网络 / 装备喂食护符 / 进食 / 自动喂食");
    return;
  }

  // 指令：Create: Storage 背包 + 喷气背包
  if (/背包|喷气|悬停|飞起|起飞|赶路|燃料|飞行|jetpack|backpack|机械心脏|背罐/.test(cmdText)) {
    stopFollow(); startWork(null);
    const say = (m) => bot.chat("@" + player + " " + m);
    if (/装备.*背包|穿.*背包|背包.*穿戴|背包.*装备|背背包|穿戴背包|拿背包/.test(cmdText)) {
      csEquipBackpack().then((r) => say(r.ok ? ("背包已尝试穿到饰品栏（" + (r.curios || "") + "；最大血量 " + (r.maxHealth ?? "?") + "；升级你已提前放好）") : "装备失败：" + (r.error || "")));
      return;
    }
    if (/看|列|有|查|什么|里面|清单|内容|读|背包里/.test(cmdText)) {
      csReadBackpack().then((r) => {
        if (!r.ok) { say("读取失败：" + (r.error || "")); return; }
        if (!r.items || !r.items.length) { say("背包是空的"); return; }
        const top = r.items.slice(0, 12).map((s) => s.item + "×" + s.count).join("、");
        say("背包里有 " + r.items.length + " 种：" + top + (r.items.length > 12 ? " …" : ""));
      });
      return;
    }
    if (/存|收|放|入库|进背包|入背包/.test(cmdText)) {
      const item = bdExtractItemName(cmdText);
      if (!item) { say("想存什么？说「把 <物品> 存进背包」"); return; }
      csDeposit(item).then((r) => say(r.ok ? ("已把 " + (r.item || item) + "×" + (r.count || "") + " 存入背包") : "存入失败：" + (r.error || "")));
      return;
    }
    if (/取|拿|出|领|提取|取出|从背包/.test(cmdText)) {
      const item = bdExtractItemName(cmdText);
      if (!item) { say("想取什么？说「从背包拿 <物品>」"); return; }
      csWithdraw(item).then((r) => say(r.ok ? ("已从背包取出 " + (r.item || item) + "×" + (r.count || "")) : "取出失败：" + (r.error || "")));
      return;
    }
    if (/飞起|起飞|上升|jetpack|飞上去|起跳/.test(cmdText)) { csJetUp(); say("已发送飞起指令"); return; }
    if (/悬停|hover/.test(cmdText)) { csJetHover(); say("已发送悬停指令"); return; }
    if (/停飞|降落|停下.*飞|关.*飞|停止.*喷气|jet.*stop/.test(cmdText)) { csJetStop(); say("已停止喷气"); return; }
    if (/燃料|飞行时间|剩余.*飞|背罐|fuel/.test(cmdText)) {
      const f = csFuelStatus();
      say(f.fuelRemaining != null ? ("剩余飞行时间约 " + f.fuelRemaining.toFixed(0) + " 秒（" + (f.active ? "喷气中" : "未喷气") + "）") : "暂无燃料同步数据（背包穿戴且喷气/飞行时才会同步）");
      return;
    }
    if (/避障|卡住.*飞|自动飞/.test(cmdText)) {
      const on = !/关|停/.test(cmdText);
      const r = csSetAutoFly(on);
      say(r.ok ? (on ? "已开启自动飞起避障（卡住时自动飞起越障）" : "已关闭自动飞起避障") : "失败");
      return;
    }
    if (/赶路|飞行移动|jet.*travel|背包赶路/.test(cmdText)) {
      const on = !/关|停/.test(cmdText);
      const r = csSetTravel(on);
      say(r.ok ? (on ? "已开启喷气赶路（悬停+前进，配合寻路）" : "已关闭喷气赶路") : "失败");
      return;
    }
    say("背包/喷气指令：装备背包 / 看背包 / 存<物品>进背包 / 从背包拿<物品> / 飞起 / 悬停 / 停飞 / 燃料 / 自动飞起避障 / 喷气赶路");
    return;
  }

  // 默认：LLM 智能回复（非预设指令的 @）
  console.log("[mention] " + player + " @ 了 bot → LLM 回复");
  askLLM("玩家 " + player + " 在聊天里 @ 了你，内容是：" + cmdText + "。请用一句话简短回复。").then((reply) => {
    if (reply) {
      const clean = reply.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
      setTimeout(() => { if (bot && bot.entity) bot.chat("@" + player + " " + clean); }, 800);
    } else {
      const lines = ["@" + player + " 在的", "@" + player + " 收到", "@" + player + " 在听"];
      const line = lines[Math.floor(Math.random() * lines.length)];
      setTimeout(() => { if (bot && bot.entity) bot.chat(line); }, 800);
    }
  });
}
function myBotGoto(x, y, z, range) {
  if (!bot || !bot.entity) return;
  try { bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range ?? 2)); } catch (e) { console.log("[goto] 失败:", e.message); }
}
function startFollow(name) {
  stopFollow();
  followTarget = name;
  followTimer = setInterval(() => {
    if (!bot || !bot.entity || !followTarget) { stopFollow(); return; }
    const who = bot.players[followTarget] || Object.values(bot.players).find((pl) => pl.username && pl.username.toLowerCase().includes(followTarget.toLowerCase()));
    const pe = who?.entity?.position;
    if (pe) {
      const dist = bot.entity.position.distanceTo(pe);
      if (dist > 3) myBotGoto(pe.x, pe.y, pe.z, 2);
    }
  }, 2000);
}
function stopFollow() {
  followTarget = null;
  if (followTimer) { clearInterval(followTimer); followTimer = null; }
}

// ---- 进食 + 自动觅食 ----
let autoEating = false;
let autoEatTimer = null;
let spawnReadyAt = 0;        // spawn 后留出背包同步时间，避免误判“无食物”喊话
const FOOD_NAMES = ["bread", "apple", "porkchop", "beef", "cooked", "potato", "carrot", "berry", "cookie", "melon", "golden", "mutton", "chicken", "rabbit", "fish", "salmon", "cod", "tropical", "puffer", "chorus", "dried", "beetroot", "pumpkin", "cake", "honey", "sweet", "pie", "stew", "soup", "baked", "egg", "rice", "mantou"];
async function eatFood() {
  if (!bot || !bot.entity || autoEating) return false;
  const foods = bot.inventory.items().filter((it) => it && it.name && FOOD_NAMES.some((n) => it.name.includes(n)));
  if (!foods.length) return false;
  autoEating = true;
  try {
    const f = foods[0];
    await bot.equip(f, "hand");
    await bot.consume();
    console.log("[eat] 吃了 " + (f.displayName || f.name) + "（food " + bot.food + "）");
    return true;
  } catch (e) {
    console.log("[eat] 失败:", e.message);
    return false;
  } finally {
    autoEating = false;
  }
}
// ---- 经验物品（经验瓶/经验颗粒）：识别 + 右键使用 ----
const XP_ITEM_RE = /experience|exp_bottle|xp_|经验|颗粒|bottle_o/i;
// 模组"经验颗粒"在 bot registry 里是 unknown，只能按物品数字 ID 识别（实测 type=5339）
const XP_ITEM_TYPES = new Set(String(process.env.XP_ITEM_TYPES ?? "5339").split(",").map((s) => Number(s.trim())).filter((n) => n > 0));
function findXpItem() {
  if (!bot || !bot.inventory) return null;
  return bot.inventory.items().find((it) => {
    if (!it) return false;
    if (XP_ITEM_TYPES.has(it.type)) return true; // 按物品 ID 命中（经验颗粒）
    const nm = (it.name || "") + " " + (it.displayName || "") + " " + (it.customName || "");
    return XP_ITEM_RE.test(nm);
  }) || null;
}
async function useXpItems(maxUse = 64) {
  if (!bot || !bot.entity) return 0;
  let used = 0;
  for (let i = 0; i < maxUse; i++) {
    const it = findXpItem();
    if (!it) break;
    try {
      await bot.equip(it, "hand");
      await bot.activateItem();  // 右键使用（经验瓶投掷后生成经验球）
      try { bot.deactivateItem(); } catch (e) {}
      used++;
      await new Promise((r) => setTimeout(r, 320));
    } catch (e) { console.log("[use_xp] 失败:", e.message); break; }
  }
  if (used) {
    console.log("[use_xp] 使用了 " + used + " 个经验物品，等待吸收…");
    await new Promise((r) => setTimeout(r, 1600));
  }
  return used;
}

// 背包里是否还有可吃的食物
function hasFoodItem() {
  if (!bot || !bot.inventory) return false;
  return bot.inventory.items().some((it) => it && it.name && FOOD_NAMES.some((n) => it.name.includes(n)));
}

// 背包没食物且确实偏低 → 在服务器喊话求食物（带冷却 + 阈值，避免刷屏）
let lastFoodRequestAt = 0;
const FOOD_REQUEST_CD = 120000; // 120s 内不重复喊
function maybeRequestFood() {
  const now = Date.now();
  if (now - lastFoodRequestAt < FOOD_REQUEST_CD) return;
  const sat = (typeof bot.foodSaturation === "number") ? bot.foodSaturation : 20;
  if (bot.food >= 18 && sat >= 14) return; // 还够吃，不喊
  lastFoodRequestAt = now;
  try {
    bot.chat("【bot】背包没食物了，求好心人给点吃的！面包/苹果/熟肉都行，谢谢～");
    console.log("[eat] 背包无食物，已在服务器喊话求食物");
  } catch (e) { console.log("[eat] 喊话求食物失败:", e.message); }
}

// 求食后顺路去捡附近掉落的食物（让“求食物”真的有下文）
function collectNearbyFood() {
  if (!bot || !bot.entity || bot.pathfinder?.goal) return;        // 不抢戏、不重复寻路
  if (Date.now() - lastHurtAt <= HURT_RETALIATE_MS) return;       // 战斗中不捡
  if (Date.now() - lastFoodRequestAt > 60000) return;             // 仅“刚求过食”后才去捡
  let best = null, bd = 1e18;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || !e.position || e === bot.entity) continue;
    if (e.type !== "object" && e.type !== "item") continue;       // 只认掉落物实体
    const nm = String(e.name || (e.metadata && e.metadata.item && e.metadata.item.itemId) || "").toLowerCase();
    if (!FOOD_NAMES.some((n) => nm.includes(n))) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d > 16 || d >= bd) continue;
    bd = d; best = e;
  }
  if (best) {
    try {
      bot.pathfinder.setGoal(new goals.GoalNear(best.position.x, best.position.y, best.position.z, 1.2));
      console.log("[eat] 前往捡取掉落食物 " + (best.name || "?") + " dist=" + bd.toFixed(1));
    } catch (e) { }
  }
}

function startAutoEat() {
  if (autoEatTimer) return;
  autoEatTimer = setInterval(() => {
    if (!bot || !bot.entity) return;
    if (Date.now() < spawnReadyAt) return;   // 背包同步宽限期内不动作（防误判无食物）
    // Minecraft 机制：只有饥饿值 food<20 才能进食。保持食物栏常满即可让饱和度长期接近满。
    // 因此仅在 food<20 时尝试进食；saturation 会在每次进食后回补到 food+6 附近。
    if (bot.food < 20) {
      if (hasFoodItem()) {
        eatFood().then((ok) => { if (ok) console.log("[eat] 自动补食保持满饱食度（food " + bot.food + " sat " + ((bot.foodSaturation ?? 0).toFixed(1)) + "）"); });
      } else if (bot.food < 18) {
        // 背包没食物且饥饿值已偏低（<18）→ 喊话求食物 + 顺手捡掉落物
        maybeRequestFood();
        collectNearbyFood();
      }
    }
  }, 3000);
}

// ---- 生存自动化（对标 aiplayer 自主本能）----
// 1) 自动睡觉（防幻翼）：夜晚 + 附近有床 + 空闲 → 走近 + sleep。
//    aiplayer 经验：isDay 不可信，夜晚判定用 timeOfDay（12542-23458）。
let autoSleepTimer = null;
let lastSleepTry = 0;
function isNightTime() {
  if (!bot || !bot.time) return false;
  const t = bot.time.timeOfDay;
  return t >= 12542 && t <= 23458;
}
function tryAutoSleep() {
  try {
    if (!bot || !bot.entity || bot.isSleeping) return;
    if (workMode || followTarget) return; // 干活/跟随时不睡
    if (!isNightTime()) return;
    const now = Date.now();
    if (now - lastSleepTry < 30000) return; // 30 秒重试间隔，避免反复折腾
    const bed = bot.findBlock({ matching: (b) => b && b.name && b.name.toLowerCase().includes("bed"), maxDistance: 40 });
    if (!bed) return; // 附近没床就不折腾
    lastSleepTry = now;
    const dist = bot.entity.position.distanceTo(bed.position);
    const doSleep = () => {
      try {
        if (!bot || !bot.entity || bot.isSleeping) return;
        bot.sleep(bed).then(() => announce("[睡觉] 夜晚了，自动睡觉")).catch((e) => console.log("[autosleep] 睡觉失败:", e.message));
      } catch (e) { console.log("[autosleep] 失败:", e.message); }
    };
    if (dist > 4) {
      console.log("[autosleep] 夜晚，走近床 @" + Math.round(bed.position.x) + "," + Math.round(bed.position.z));
      myBotGoto(bed.position.x, bed.position.y, bed.position.z, 2);
      setTimeout(() => {
        if (!bot || !bot.entity) return;
        const d2 = bot.entity.position.distanceTo(bed.position);
        if (d2 <= 4.5) doSleep();
        else console.log("[autosleep] 走到床边失败（仍在 " + d2.toFixed(1) + " 格）");
      }, 9000);
    } else {
      doSleep();
    }
  } catch (e) { console.log("[autosleep] 失败:", e.message); }
}
function startAutoSleep() {
  if (autoSleepTimer) return;
  autoSleepTimer = setInterval(tryAutoSleep, 10000); // 每 10 秒检查（aiplayer 同频）
}

// 2) 低血避险（aiplayer 红线：按血量比例而非绝对值，因为上限可被 heart container 抬到 60）
let lowHpAlerted = false;
let survivalTimer = null;
function survivalCheck() {
  if (!bot || !bot.entity) return;
  // ★ 关键修正：血量上限现在是 60（20 + 20×2），写死 10/14 会等到快死才触发
  // 改为按比例：低于 30% 避险，高于 45% 解除
  const maxHp = getMaxHealth();
  const lowTh = Math.max(10, Math.floor(maxHp * 0.3));   // 60 血 → 18
  const safeTh = Math.max(14, Math.floor(maxHp * 0.45));  // 60 血 → 27
  if (bot.health < lowTh && !lowHpAlerted) {
    lowHpAlerted = true;
    announce("⚠ 血量过低（" + Math.round(bot.health) + "/" + maxHp + "），停止工作避险");
    if (workMode) stopWork("低血避险");
    stopFollow();
    console.log("[survival] 低血避险触发，hp=" + bot.health + "/" + maxHp);
  } else if (bot.health >= safeTh) {
    lowHpAlerted = false;
  }
}
function startSurvivalCheck() {
  if (survivalTimer) return;
  survivalTimer = setInterval(survivalCheck, 5000);
}

// ============ 3) 自动战斗（遇敌反击）============
// ★ 配置必须在使用前声明（虽然函数体延迟执行，但保守起见提前）
const COMBAT_RANGE = Number(process.env.COMBAT_RANGE || 12); // 索敌半径（格）
let combatTimer = null;
let combatTarget = null;
let combatCd = 0;
let _noWeaponRetreatAt = 0; // 无武器后撤限频

function getMaxHealth() {
  // 优先取真实上限（heart container 抬高后的），拿不到再退回 20
  try {
    const attr = bot && bot.entity && bot.entity.attributes && bot.entity.attributes["minecraft:generic.max_health"];
    if (attr && typeof attr.value === "number" && attr.value > 0) return Math.round(attr.value);
  } catch (e) { }
  return 20;
}

function findHostiles(maxDist) {
  if (!bot || !bot.entity) return [];
  const me = bot.entity.position;
  const out = [];
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position) continue;
    const nm = String(e.name || e.type || "");
    // ★ 红线：只打敌对，绝不误伤玩家 / 动物
    if (!HOSTILE_HINTS.some((h) => nm.includes(h))) continue;
    const d = e.position.distanceTo(me);
    if (d > maxDist) continue;
    out.push({ ent: e, name: nm, dist: d });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}

async function combatTick() {
  if (!bot || !bot.entity || !bot.entity.position) return;
  // 正在寻路/挖矿时不打断，除非敌人非常近
  const hostiles = findHostiles(COMBAT_RANGE);
  // 受伤后持续追打攻击者（玩家/未知实体，即便不在 HOSTILE_HINTS 也打）
  if (lastAttacker && Date.now() - lastHurtAt <= HURT_RETALIATE_MS) {
    const e = lastAttacker;
    if (e && e !== bot.entity && e.position) {
      const d = e.position.distanceTo(bot.entity.position);
      if (d > COMBAT_RANGE * 3) lastAttacker = null;                                  // 跑太远放弃
      else if (d <= COMBAT_RANGE * 2 && !hostiles.find((h) => h.ent === e)) hostiles.push({ ent: e, name: e.name || e.username || "?", dist: d });
    } else { lastAttacker = null; }
  }
  if (!hostiles.length) { combatTarget = null; return; }

  const t = hostiles[0];
  // ★ 红线：血量太低就不打了，保留血量逃跑
  const maxHp = getMaxHealth();
  if (bot.health < maxHp * 0.35) {
    if (combatTarget) { combatTarget = null; console.log("[combat] 血量不足，放弃战斗撤退"); }
    return;
  }
  // 正在干活且敌人还远 → 先干活，近了再打（但刚受伤挨打就立即还手，不受此限）
  const recentlyHurt = Date.now() - lastHurtAt <= HURT_RETALIATE_MS;
  if (!recentlyHurt) {
    if (bot.pathfinder?.goal && t.dist > 6) return;
    if (bot.targetDigBlock && t.dist > 6) return;
  }

  try {
    // 1) 换武器：优先最强（原版 + 模组武器统一打分）
    const weapon = await equipWeapon();
    if (!weapon) {
      // ★ 没有武器就不空手硬拼（bot 一死掉光 6500+ 经验），改为拉开距离
      if (Date.now() - _noWeaponRetreatAt > 3000) {
        _noWeaponRetreatAt = Date.now();
        try {
          const me = bot.entity.position;
          const dx = me.x - t.ent.position.x, dz = me.z - t.ent.position.z;
          const L = Math.hypot(dx, dz) || 1;
          bot.pathfinder.setGoal(new goals.GoalNear(me.x + (dx / L) * 8, me.y, me.z + (dz / L) * 8, 2));
          console.log("[combat] 无武器 → 后撤拉开距离（远离 " + t.name + "）");
        } catch (e) { }
      }
      return;
    }
    // 2) 转向目标（必须在主线程做 lookAt，失败不致命）
    try { await bot.lookAt(t.ent.position.offset(0, t.ent.height ? t.ent.height * 0.5 : 0.8, 0), true); } catch (e) { }
    // 3) 攻击：★ 点按（单次点击 + 等武器攻击冷却），不按住连挥
    if (t.dist <= 3.5) {
      const cd = weaponClickCooldown(weapon);
      if (Date.now() - combatCd >= cd) {
        combatCd = Date.now();
        await bot.attack(t.ent);           // 只发一次 use_entity(ATTACK)，等价"点一下左键"
        try { bot.clearControlStates(); } catch (e) { }
        console.log("[combat] 👆 点按攻击 " + t.name + " dist=" + t.dist.toFixed(1) + " 冷却=" + cd + "ms hp=" + bot.health + "/" + maxHp);
      }
    } else {
      // 2) 远距离先靠近
      combatTarget = t.name;
      if (!bot.pathfinder?.goal) {
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(t.ent.position.x, t.ent.position.y, t.ent.position.z, 2));
          console.log("[combat] 追击 " + t.name + " dist=" + t.dist.toFixed(1));
        } catch (e) { }
      }
    }
  } catch (e) { console.log("[combat] 失败:", e.message); }
}

function startCombat() {
  if (combatTimer) return;
  if (process.env.COMBAT_OFF === "1") { console.log("[combat] 已被 COMBAT_OFF=1 关闭"); return; }
  console.log("[combat] 自动战斗启动：范围 " + COMBAT_RANGE + " 格，冷却 800ms，血量 <35% 撤退");
  combatTimer = setInterval(() => { combatTick().catch(() => { }); }, 600);
}

// ============ 3.5) 受伤反击（挨打就还手）============
// 监听 entityHurt：bot 受伤时拿到攻击者(source)，立即还手并持续追打一段时间。
// 与上面的主动索敌(combatTick)互补：combatTick 只打 HOSTILE_HINTS；
// 这里额外保证“被玩家/未知实体打”时也会反击，且受伤会打断当前任务立即还手。
let lastAttacker = null;            // 最近伤害 bot 的实体
let lastHurtAt = 0;                 // 最近一次受伤时间戳
const HURT_RETALIATE_MS = 9000;    // 受伤后这段时间内持续追打攻击者
const RETALIATE_CD = 550;           // 还手攻击冷却(ms)，避免空挥刷包

// 选武器：支持原版 + 模组武器（剑/斧/刀/长枪/锤/镰 等），按「材质 + 类型」打分
// 旧版只用 /sword|axe/ 匹配，模组武器（如 xxx:青铜剑、xxx:战镰）完全识别不到 → 会空手打
const WEAPON_RE = /(sword|blade|katana|dagger|rapier|saber|scimitar|cutlass|cleaver|glaive|halberd|spear|lance|pike|trident|scythe|battleaxe|waraxe|_axe$|mace|warhammer|_hammer$|club|knife|shiv|flail|whip|naginata|nodachi|tachi|wakizashi|estoc|falchion|machete|sickle)/i;
// 排除工具/非武器（先排除，避免 pickaxe 被 _axe$ 误判成斧）
const WEAPON_BLACKLIST = /(pickaxe|shovel|_hoe$|hoe$|shears|fishing_rod|flint_and_steel|bucket|_ore$|_ingot$|_nugget$|_dust$|_gem$|torch|lantern|campfire|_door$|_trapdoor$|_sign$|_boat$|bowl|bow$|crossbow|arrow|_seed$|sapling|_head$|_spawn_egg$|_bucket$|_plate$|_gear$)/i;
const MATERIAL_SCORE = [
  [/netherite/, 100], [/dragon|chaotic|awakened/, 96], [/allthemodium|vibranium|unobtainium/, 94],
  [/ancient/, 90], [/diamond/, 80], [/emerald/, 72], [/amethyst/, 68],
  [/steel|titanium|tungsten|obsidian/, 66], [/iron/, 60], [/bronze/, 55], [/copper/, 52],
  [/stone|flint/, 40], [/gold|golden/, 22], [/wood|wooden/, 18],
];
const TYPE_BONUS = [
  [/sword|katana|longsword|broadsword|naginata|nodachi|tachi|wakizashi/, 14],
  [/glaive|halberd|spear|lance|pike|trident/, 10],
  [/battleaxe|waraxe|_axe$/, 9],
  [/scythe|cleaver|machete|falchion|cutlass|sickle/, 8],
  [/mace|warhammer|_hammer$|club|flail|whip/, 7],
  [/dagger|knife|shiv|rapier|estoc/, 6],
  [/blade|rapier|saber|scimitar/, 12],
];
function isWeaponName(n) {
  const s = String(n || "");
  if (!s) return false;
  if (WEAPON_BLACKLIST.test(s)) return false;
  return WEAPON_RE.test(s);
}
function weaponScore(n) {
  let s = 0;
  for (const [re, v] of MATERIAL_SCORE) if (re.test(n)) { s += v; break; }
  for (const [re, v] of TYPE_BONUS) if (re.test(n)) { s += v; break; }
  return s;
}
function pickWeapon() {
  if (!bot || !bot.inventory) return null;
  let items = [];
  try { items = bot.inventory.items(); } catch (e) { return null; }
  let best = null, bs = -1;
  for (const it of items) {
    if (!it || !isWeaponName(it.name)) continue;
    let r = weaponScore(it.name);
    try {
      // 快坏的武器降级，避免打两下就断
      if (it.maxDurability && typeof it.durabilityUsed === "number") {
        const remain = it.maxDurability - it.durabilityUsed;
        if (remain <= 0) continue;
        if (remain / it.maxDurability < 0.08) r -= 40;
      }
    } catch (e) { }
    if (r > bs) { bs = r; best = it; }
  }
  return best;
}

// 1.21.1 攻击冷却 = 20 / 攻速 刻（50ms/刻）。剑 1.6 → 12.5 刻 ≈ 625ms。
// 拿到武器攻速就算精确冷却；拿不到按类型兜底。加 60ms 余量避免服务端判定未蓄满。
function weaponClickCooldown(weapon) {
  const nm = String((weapon && weapon.name) || "");
  let speed = 1.6;                              // 默认按剑
  if (/axe/.test(nm)) speed = 1.0;              // 斧 1.0 → 1000ms
  else if (/trident/.test(nm)) speed = 1.1;
  else if (/pickaxe|shovel|hoe|_hoe$/.test(nm)) speed = 1.2;
  else if (/sword|katana|blade/.test(nm)) speed = 1.6;
  else if (/dagger|knife/.test(nm)) speed = 2.0;
  try {
    // 若 item 上带攻速属性（部分 1.21 注册表有），优先用它
    const attr = weapon && weapon.attributes && (weapon.attributes["minecraft:generic.attack_speed"] || weapon.attributes["generic.attack_speed"]);
    if (attr && typeof attr.value === "number" && attr.value > 0) speed = attr.value;
  } catch (e) { }
  const ms = Math.round((20 / speed) * 50) + 60;
  return Math.max(350, Math.min(1800, ms));
}

let _noWeaponWarnAt = 0;
// 换上最强武器；没有武器返回 null（调用方据此决定"不空手硬拼"）
async function equipWeapon() {
  const w = pickWeapon();
  if (!w) {
    if (Date.now() - _noWeaponWarnAt > 30000) {
      _noWeaponWarnAt = Date.now();
      const held = bot && bot.heldItem ? bot.heldItem.name : "空手";
      console.log("[combat] ⚠ 未识别到可用武器（当前手持 " + held + "）→ 不空手硬拼，改为拉开距离");
    }
    return null;
  }
  try {
    if (!bot.heldItem || bot.heldItem.type !== w.type) {
      await bot.equip(w, "hand");
      console.log("[combat] 🗡 换手持武器：" + w.name + "（评分 " + weaponScore(w.name) + "）");
    }
  } catch (e) {
    console.log("[combat] 换武器失败(" + w.name + "): " + e.message);
  }
  return w;
}

// 兜底：拿不到 source 时，找最近的敌对 mob（仅敌对，不误伤附近玩家）
function nearestHostileFallback(maxDist) {
  if (!bot || !bot.entity) return null;
  const me = bot.entity.position;
  let best = null, bd = 1e18;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position) continue;
    const nm = String(e.name || e.type || "");
    if (!HOSTILE_HINTS.some((h) => nm.includes(h))) continue;
    const d = e.position.distanceTo(me);
    if (d > maxDist) continue;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// 立即还手（受冷却限制），确保“挨打就挥”
function tryRetaliateSwing(target) {
  if (!bot || !bot.entity || !target || !target.position) return;
  if (Date.now() - combatCd < RETALIATE_CD) return;
  combatCd = Date.now();
  (async () => {
    try {
      try { if (bot.pathfinder?.goal) bot.pathfinder.setGoal(null); } catch (e) { } // 打断当前寻路，优先还手
      // ★ 先换武器；没有武器就不空手还击（空手伤害 1，打怪等于送经验）
      const w = await equipWeapon();
      if (!w) return;
      try { await bot.lookAt(target.position.offset(0, (target.height || 1) * 0.85, 0), true); } catch (e) { }
      const d = target.position.distanceTo(bot.entity.position);
      if (d <= 4.2) {
        await bot.attack(target);        // 点按：单次点击
        try { bot.clearControlStates(); } catch (e) { }
        console.log("[combat] 👆 点按还手 " + (target.name || target.username || "?") + " dist=" + d.toFixed(1) + " 冷却=" + weaponClickCooldown(w) + "ms hp=" + bot.health + "/" + getMaxHealth());
      } else {
        try { bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2)); } catch (e) { }
      }
    } catch (e) { console.log("[combat] 还手失败:", e.message); }
  })();
}

// bot 受伤回调
function onBotHurt(source) {
  if (!bot || !bot.entity) return;
  lastHurtAt = Date.now();
  let attacker = null;
  if (source && source !== bot.entity && source.position) attacker = source; // damage_event 给的 culprit
  if (!attacker) attacker = nearestHostileFallback(8);                       // 兜底：最近敌对 mob
  if (!attacker) return;
  lastAttacker = attacker;
  combatTarget = attacker.name || attacker.username || "?";
  const maxHp = getMaxHealth();
  if (bot.health < maxHp * 0.35) {
    console.log("[combat] 受到 " + (attacker.name || attacker.username || "?") + " 攻击但血量过低(" + bot.health + "/" + maxHp + ")，以撤退为主");
    return;
  }
  console.log("[combat] 受到 " + (attacker.name || attacker.username || "?") + " 攻击，反击！");
  tryRetaliateSwing(attacker);
}

// 3) 经验守护：经验等级 < 50 时自动前往「淋浴间」黑色石碑（262,-1147）附近吸收经验球
const XP_LOW_LEVEL = Number(process.env.XP_LOW_LEVEL ?? 50); // 阈值，可用环境变量 XP_LOW_LEVEL 覆盖（测试用）
const XP_SPOT = { x: 262, y: 78, z: -1147, name: "淋浴间" };
let xpGuardEnabled = process.env.XP_GUARD !== "0"; // 开关，默认开启；环境变量 XP_GUARD=0 全局关闭
let xpGuardTimer = null;
let xpGuardMoving = false;
let xpGuardUsing = false;
let xpGuardLastReport = 0;
function xpGuardCheck() {
  try {
    if (!xpGuardEnabled) return; // 开关关闭时不做任何事
    if (!bot || !bot.entity || !authed) return;
    const exp = bot.experience;
    if (!exp || typeof exp.level !== "number") return; // 经验包尚未同步
    if (exp.level >= XP_LOW_LEVEL) { xpGuardMoving = false; return; }
    // 优先使用背包里的经验物品（经验瓶/经验颗粒），没有再去淋浴间
    if (findXpItem()) {
      if (!xpGuardUsing) {
        xpGuardUsing = true;
        useXpItems(64).then((n) => {
          xpGuardUsing = false;
          if (n > 0) announce("[经验] 使用了 " + n + " 个经验物品补充经验（当前等级 " + (bot?.experience?.level ?? "?") + "）");
        });
      }
      return;
    }
    const p = bot.entity.position;
    const dist = Math.hypot(p.x - XP_SPOT.x, p.z - XP_SPOT.z);
    if (dist <= 8) { // 已在淋浴间附近 → 站着等经验球自动飞来
      if (xpGuardMoving) { xpGuardMoving = false; console.log("[xpguard] 已到淋浴间附近，等待吸收经验球"); }
      return;
    }
    if (xpGuardMoving) return; // 正在赶路中
    xpGuardMoving = true;
    const now = Date.now();
    if (now - xpGuardLastReport > 60000) {
      xpGuardLastReport = now;
      announce("[经验] 等级 " + exp.level + " 低于 " + XP_LOW_LEVEL + "，前往淋浴间补充经验（" + Math.round(dist) + " 格）");
    }
    console.log("[xpguard] level=" + exp.level + " < " + XP_LOW_LEVEL + "，前往淋浴间 @" + XP_SPOT.x + "," + XP_SPOT.z);
    myBotGoto(XP_SPOT.x, XP_SPOT.y, XP_SPOT.z, 4);
    setTimeout(() => {
      if (!bot || !bot.entity) { xpGuardMoving = false; return; }
      const d2 = Math.hypot(bot.entity.position.x - XP_SPOT.x, bot.entity.position.z - XP_SPOT.z);
      if (d2 > 8) { xpGuardMoving = false; console.log("[xpguard] 尚未到位（剩 " + d2.toFixed(0) + " 格），下次检查继续"); }
    }, 30000);
  } catch (e) { console.log("[xpguard] 失败:", e.message); }
}
function startXpGuard() {
  if (xpGuardTimer) return;
  xpGuardTimer = setInterval(xpGuardCheck, 15000); // 每 15 秒检查一次
}

// 4) 装备耐久监测 + 自动修补（经验修补）：耐久低于阈值 → 去淋浴间吸经验球，由经验修补自动修复
// 阈值：DURABILITY_LOW（默认 0.35 = 剩余 35%）触发；DURABILITY_HIGH（默认 0.85）视为修满。DURABILITY_GUARD=0 关闭。
const DURABILITY_LOW = Number(process.env.DURABILITY_LOW ?? 0.35);
const DURABILITY_HIGH = Number(process.env.DURABILITY_HIGH ?? 0.85);
let durabilityGuardEnabled = process.env.DURABILITY_GUARD !== "0";
let durabilityRepairing = false;
// 单件物品耐久 → {remaining, max, used, ratio}；读不到则 null（非可损耗物品/未知）
function itemDurability(it) {
  if (!it) return null;
  let max = null;
  try {
    const def = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[it.name];
    if (def && def.maxDurability) max = def.maxDurability;
  } catch (e) {}
  if (max == null) {
    const FB = { netherite_helmet: 407, netherite_chestplate: 592, netherite_leggings: 555, netherite_boots: 481, netherite_sword: 2031,
                 diamond_helmet: 363, diamond_chestplate: 528, diamond_leggings: 495, diamond_boots: 429, diamond_sword: 1561 };
    max = FB[it.name] || null;
  }
  if (max == null) return null;
  const used = it.durabilityUsed || 0;
  const remaining = Math.max(0, max - used);
  return { remaining, max, used, ratio: +(remaining / max).toFixed(3) };
}
// 逐槽位耐久报告（head/torso/legs/feet/hand）
function gearDurabilityReport() {
  const r = {};
  try {
    const eq = bot.entity && bot.entity.equipment;
    if (eq) for (const k of ["head", "torso", "legs", "feet"]) {
      const it = eq[k];
      r[k] = it ? Object.assign({ name: it.name, displayName: it.displayName || it.name }, itemDurability(it)) : null;
    }
    r.hand = bot.heldItem ? Object.assign({ name: bot.heldItem.name, displayName: bot.heldItem.displayName || bot.heldItem.name }, itemDurability(bot.heldItem)) : null;
  } catch (e) { r.error = e.message; }
  return r;
}
// 全局最差耐久比（含主手武器）
function checkGearDurability() {
  const rep = gearDurabilityReport();
  let worst = 1, worstName = null;
  for (const k of ["head", "torso", "legs", "feet", "hand"]) {
    const d = rep[k];
    if (d && typeof d.ratio === "number" && !isNaN(d.ratio)) { if (d.ratio < worst) { worst = d.ratio; worstName = d.displayName || d.name; } }
  }
  return { worst, worstName, report: rep };
}
// 启动一次修补会话：去淋浴间停留吸经验，经验修补自动修复；修满或超时结束。announceFn 用于播报。
function startRepairSession(announceFn) {
  if (durabilityRepairing) { if (announceFn) announceFn("已在修补中"); return { ok: true, busy: true }; }
  const st = checkGearDurability();
  if (!st || st.worst == null) { if (announceFn) announceFn("读不到装备耐久（可能尚未穿戴）"); return { ok: false, reason: "no_data" }; }
  if (st.worst >= DURABILITY_HIGH) { if (announceFn) announceFn("耐久已充足（最低 " + Math.round(st.worst * 100) + "%），无需修补"); return { ok: true, alreadyOk: true, worst: st.worst }; }
  durabilityRepairing = true;
  if (announceFn) announceFn("前往淋浴间修补（最低 " + Math.round(st.worst * 100) + "%）→ 吸经验球触发经验修补");
  myBotGoto(XP_SPOT.x, XP_SPOT.y, XP_SPOT.z, 8);
  const start = Date.now();
  const iv = setInterval(() => {
    try {
      if (!bot || !bot.entity) { clearInterval(iv); durabilityRepairing = false; return; }
      const cur = checkGearDurability();
      const dist = Math.hypot(bot.entity.position.x - XP_SPOT.x, bot.entity.position.z - XP_SPOT.z);
      if (cur && cur.worst != null && cur.worst >= DURABILITY_HIGH) { clearInterval(iv); durabilityRepairing = false; if (announceFn) announceFn("✅ 修补完成（最低 " + Math.round(cur.worst * 100) + "%）"); return; }
      if (Date.now() - start > 15 * 60 * 1000) { clearInterval(iv); durabilityRepairing = false; if (announceFn) announceFn("⚠ 15 分钟未修满，当前最低 " + Math.round((cur ? cur.worst : 0) * 100) + "%，请检查淋浴间经验源"); return; }
      if (dist > 10) myBotGoto(XP_SPOT.x, XP_SPOT.y, XP_SPOT.z, 8); // 被挤开则回去
    } catch (e) { clearInterval(iv); durabilityRepairing = false; console.log("[dur] 异常:", e.message); }
  }, 10000);
  return { ok: true, started: true };
}
function startDurabilityGuard() {
  if (!durabilityGuardEnabled) { console.log("[dur] 已被 DURABILITY_GUARD=0 关闭"); return; }
  setInterval(() => {
    try {
      if (!bot || !bot.entity || !authed || durabilityRepairing) return;
      if (workMode || followTarget || combatTarget) return;                 // 工作/跟随/战斗中不抢戏
      if (getMaxHealth && bot.health < getMaxHealth() * 0.35) return;        // 低血不自扰
      const st = checkGearDurability();
      if (!st || st.worst == null) return;
      if (st.worst < DURABILITY_LOW) {
        announce("[耐久] 装备耐久偏低（" + (st.worstName || "?") + " 剩 " + Math.round(st.worst * 100) + "%），自动前往淋浴间用经验修补");
        startRepairSession(announce);
      }
    } catch (e) { console.log("[dur] 异常:", e.message); }
  }, 15000);
  console.log("[dur] 启动（耐久<" + Math.round(DURABILITY_LOW * 100) + "% 自动去淋浴间修补；已开启，DURABILITY_GUARD=0 可关闭）");
}

// 5) 石碑旅行：用户让 bot 去某石碑时，不走到目标石碑，而是
//    · 传送石碑(waystones:waystone)：优先用身上传送石（右键开 GUI 再选），无传送石则直接发 select_waystone 包（等效传送石，任意位置），
//      都没有 UUID 时退化为走到最近传送石碑中转；
//    · 共享石碑(各色 _sharestone)：传送石不能传它，必须走到【最近同色】共享石碑，再在其界面选目标（不同颜色不互通）。
function sharestoneColor(wtype) { const t = (wtype || "").toLowerCase(); return t.replace("waystones:", "").replace("_sharestone", "").replace("sharestone", ""); }
function nearestWaystoneBy(pred) {
  if (!bot || !bot.entity || !knownWaystones.length) return null;
  const p = bot.entity.position;
  let best = null, bd = 1e18;
  for (const w of knownWaystones) {
    if (w.dim !== "minecraft:overworld" || w.name === "?" || !pred(w)) continue;
    const d = Math.hypot(w.x - p.x, w.z - p.z);
    if (d < bd) { bd = d; best = w; }
  }
  return best ? { ...best, dist: Math.round(bd) } : null;
}
async function travelToWaystone(target, reply) {
  if (!target) { if (reply) reply("没找到目标传送点"); return { ok: false, reason: "no_target" }; }
  try {
    if (isSharestone(target.wtype)) {
      // 共享石碑：不能用传送石，必须去最近同色共享石碑中转
      const color = sharestoneColor(target.wtype) || "该色";
      const near = nearestWaystoneBy((w) => isSharestone(w.wtype) && sharestoneColor(w.wtype) === sharestoneColor(target.wtype));
      if (!near) { if (reply) reply("附近没有「" + color + "」共享石碑可中转，无法前往「" + target.name + "」"); return { ok: false, reason: "no_near_sharestone", color }; }
      if (reply) reply("「" + target.name + "」是" + color + "共享石碑（传送石不可用），走到最近的同色共享石碑「" + near.name + "」（" + near.dist + " 格）中转传送");
      console.log("[travel] 共享石碑 → 最近同色「" + near.name + "」中转 → 「" + target.name + "」");
      gotoWaystoneAndOpen(near, (ok, err, opened) => {
        if (!ok || !opened) { if (reply) reply("走过去失败：" + String((err && err.message) || "").slice(0, 30)); return; }
        if (target.uuid) {
          client.write("custom_payload", { channel: "waystones:select_waystone", data: Buffer.from(target.uuid, "hex") });
          if (reply) reply("已从中转点传送到「" + target.name + "」");
        } else if (reply) reply("目标「" + target.name + "」尚未被发现（无 UUID），无法传送，请先靠近激活它");
      });
      return { ok: true, method: "sharestone_relay", via: near.name };
    }
    // 传送石碑：优先用身上传送石，否则直接发包，否则最近传送石碑中转
    if (target.uuid) {
      const stone = findWarpStoneItem();
      if (stone) {
        if (reply) reply("用身上的传送石传送到「" + target.name + "」（右键开界面→选择）");
        console.log("[travel] 传送石碑 → 用传送石（" + (stone.displayName || stone.name) + "）");
        try {
          await bot.equip(stone, "hand");
          await bot.activateItem(false);
          setTimeout(() => {
            client.write("custom_payload", { channel: "waystones:select_waystone", data: Buffer.from(target.uuid, "hex") });
            try { bot.deactivateItem(); } catch (e) {}
            if (reply) reply("已用传送石传送到「" + target.name + "」");
          }, 1500);
        } catch (e) { if (reply) reply("使用传送石失败：" + String(e.message || "").slice(0, 30) + "，改用直接传送"); client.write("custom_payload", { channel: "waystones:select_waystone", data: Buffer.from(target.uuid, "hex") }); }
        return { ok: true, method: "warp_stone" };
      }
      // 没有传送石 → 直接发 select_waystone 包（等效传送石，任意位置）
      client.write("custom_payload", { channel: "waystones:select_waystone", data: Buffer.from(target.uuid, "hex") });
      if (reply) reply("（未携带传送石）直接发送传送指令到「" + target.name + "」");
      console.log("[travel] 传送石碑 → 直接 select_waystone（无传送石）");
      return { ok: true, method: "select_packet" };
    }
    // 传送石碑但无 UUID → 走到最近传送石碑中转
    const near = nearestWaystoneBy(isRegularWaystone);
    if (!near) { if (reply) reply("附近没有传送石碑可中转，且「" + target.name + "」无 UUID"); return { ok: false, reason: "no_near_waystone" }; }
    if (reply) reply("「" + target.name + "」尚未被发现，走到最近的传送石碑「" + near.name + "」（" + near.dist + " 格）中转");
    gotoWaystoneAndOpen(near, (ok, err, opened) => {
      if (!ok || !opened) { if (reply) reply("走过去失败：" + String((err && err.message) || "").slice(0, 30)); return; }
      if (target.uuid) { client.write("custom_payload", { channel: "waystones:select_waystone", data: Buffer.from(target.uuid, "hex") }); if (reply) reply("已中转传送到「" + target.name + "」"); }
      else if (reply) reply("目标仍无 UUID，无法传送");
    });
    return { ok: true, method: "waystone_relay", via: near.name };
  } catch (e) { if (reply) reply("传送异常：" + String(e.message || "").slice(0, 30)); return { ok: false, error: e.message }; }
}

// 3.5) 聊天监视：无需 @，bot 主动加入玩家对话（定时扫描聊天缓冲）
// 触发：① 经验/等级关键词  ② 位置/坐标关键词  ③ 直接叫 "bot/机器人"  ④ 含"你"的问句
// 限频：全局 30 秒 + 同玩家 45 秒，一轮只回应第一条命中的消息，避免刷屏。
let chatMonitorTimer = null;
let lastMonitorSeq = 0;            // 已扫描到的聊天序号游标
let lastMonitorByPlayer = {};      // 按说话人限频
let lastMonitorGlobal = 0;
const MONITOR_INTERVAL = 12000;    // 每 12 秒扫描一次
const MONITOR_GLOBAL_CD = 30000;   // 全局冷却 30 秒
const MONITOR_PLAYER_CD = 45000;   // 同玩家冷却 45 秒
const MONITOR_NAME_RE = /(^|\s)(bot|机器人|universal)\b/i;
const MONITOR_XP_RE = /经验|等级|级别|xp|几级|多少级|level/i;
const MONITOR_LOC_RE = /在哪|位置|坐标|你在哪|哪里|位于/i;
const MONITOR_Q_RE = /[?？]|吗|呢|怎么|什么|多少|几$|几点|谁/i;

function startChatMonitor() {
  if (process.env.CHAT_MONITOR_OFF === "1") return;  // 手机端默认关：它会定时调 LLM，抢 CPU/网络
  if (chatMonitorTimer) return;
  lastMonitorSeq = chatSeq;        // 启动前已有的聊天不追溯，避免一上线就补回复
  chatMonitorTimer = setInterval(chatMonitorTick, MONITOR_INTERVAL);
  console.log("[chatmon] 启动（无需 @，每 " + (MONITOR_INTERVAL / 1000) + " 秒扫描聊天）");
}

function chatMonitorTick() {
  if (!bot || !bot.entity || !authed) return;
  const now = Date.now();
  if (now - lastMonitorGlobal < MONITOR_GLOBAL_CD) return; // 全局冷却
  const fresh = chatBuf.filter((c) => (c.seq || 0) > lastMonitorSeq);
  lastMonitorSeq = chatSeq;
  if (!fresh.length) return;
  // 从旧到新处理，本轮只回应第一条命中的消息
  for (const c of fresh) {
    const text = c.text || "";
    if (!text) continue;
    if (new RegExp("<" + USER + ">").test(text)) continue;   // 自己的消息
    if (SYS_HINTS.some((h) => text.includes(h))) continue;   // 系统消息
    if (/bot[_-]?one|bot[_-]?two/i.test(text)) continue;      // 已被 @mention 路径处理
    const m = text.match(/<(\w+)>[:：]?\s*(.*)/);
    if (!m) continue;
    const speaker = m[1];
    const content = (m[2] || "").trim();
    if (!content || speaker.toLowerCase() === USER.toLowerCase()) continue;
    if (now - (lastMonitorByPlayer[speaker] || 0) < MONITOR_PLAYER_CD) continue; // 同玩家限频
    // 判断触发类型（顺序：经验 > 位置 > 叫名 > 问句）
    let kind = null;
    if (MONITOR_XP_RE.test(content)) kind = "xp";
    else if (MONITOR_LOC_RE.test(content)) kind = "loc";
    else if (MONITOR_NAME_RE.test(content)) kind = "name";
    else if (MONITOR_Q_RE.test(content) && /你(?!们)/.test(content)) kind = "q"; // 含"你"的问句（排除"你们"）
    if (!kind) continue;
    lastMonitorByPlayer[speaker] = now;
    lastMonitorGlobal = now;
    monitorRespond(kind, speaker, content, fresh);
    break;
  }
}

function monitorRespond(kind, speaker, content, recent) {
  if (kind === "xp") {
    const xp = bot.experience || {};
    const lvl = xp.level != null ? xp.level : 0;
    const prog = Math.round((xp.progress != null ? (xp.progress || 0) : 0) * 100);
    bot.chat("@" + speaker + " 我当前经验等级 Lv." + lvl + "（本级进度 " + prog + "%）");
    console.log("[chatmon] 命中经验查询 → " + speaker);
    return;
  }
  if (kind === "loc") {
    const p = bot.entity.position;
    bot.chat("@" + speaker + " 我在 " + Math.round(p.x) + ", " + Math.round(p.z) + "（Y " + Math.round(p.y) + "）");
    console.log("[chatmon] 命中位置查询 → " + speaker);
    return;
  }
  if (kind === "name") {
    // 叫到 bot 了：若含工作指令关键词，转交 @mention 路径执行；否则纯聊天用 LLM 接话
    const CMD_RE = /过来|跟我|跟着|砍树|伐木|挖矿|挖石|巡|停|休息|回家|回出生|睡觉|吃|附近|找|时间|几点|石碑|传送|经验|等级|位置|坐标|在哪/;
    if (CMD_RE.test(content)) {
      tryMentionReply("<" + speaker + "> @" + USER + " " + content); // 构造伪装 mention 复用全部指令逻辑
      console.log("[chatmon] 叫名+指令 → 转交 mention 执行：" + speaker);
      return;
    }
    // 落到下面的 LLM 接话
  }
  // name / q → LLM 接话（基于最近聊天上下文，自然加入对话）
  const ctx = recent.filter((r) => /<\w+>/.test(r.text || "")).slice(-5).map((r) => r.text).join("\n");
  const prompt = "你是一个 Minecraft 服务器里的 AI 玩家（名字 " + USER + "），和真人玩家一起玩。\n"
    + "最近服务器聊天：\n" + ctx + "\n\n"
    + "玩家 " + speaker + " 说：「" + content + "」\n"
    + "请自然接一句话，口语化，不超过 30 字，不要带 @。";
  askLLM(prompt).then((reply) => {
    if (!reply) return;
    const clean = reply.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
    if (clean) setTimeout(() => { if (bot && bot.entity) bot.chat(clean); }, 600);
  });
  console.log("[chatmon] 命中接话 → " + speaker + "：「" + content.slice(0, 30) + "」");
}

// 4) 坐标变化播报：相对上次播报位移 ≥1000 格时向服务器播报一次位置（格式：当前位置 X Z）
let lastReportPos = null;
let posReportTimer = null;
let lastPosReportAt = 0;
function startPosReport() {
  if (posReportTimer) return;
  posReportTimer = setInterval(() => {
    if (!bot || !bot.entity) return;
    if (!authed) return; // 登录完成前不播报（重连瞬态坐标会误触发）
    const p = bot.entity.position;
    if (!lastReportPos) { lastReportPos = { x: p.x, z: p.z }; lastPosReportAt = Date.now(); return; } // 首个基准不播报
    const dx = p.x - lastReportPos.x, dz = p.z - lastReportPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist >= 3000) {
      const now = Date.now();
      if (now - lastPosReportAt < 600000) return; // 距上次播报至少 10 分钟（压缩播报频次）
      lastReportPos = { x: p.x, z: p.z };
      lastPosReportAt = now;
      announce("当前位置 " + Math.round(p.x) + " " + Math.round(p.z));
      console.log("[posreport] 位移 " + Math.round(dist) + " 格 → 已播报位置");
    }
  }, 10000); // 每 10 秒检查
}

// 5) 待发消息队列：离线/未登录时 say 进队列（落盘防重启丢失），登录成功后自动补发
const PENDING_FILE = path.join(HERE, "pending-say.json");
let pendingSay = []; // [{ text, at }]
try {
  if (fs.existsSync(PENDING_FILE)) pendingSay = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")) || [];
} catch (e) { pendingSay = []; }
function savePendingSay() {
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify(pendingSay.slice(-20), null, 1)); } catch (e) {}
}
function canSay() {
  return !!(bot && bot.entity && authed);
}
function flushPendingSay() {
  if (!pendingSay.length) return;
  const now = Date.now();
  const toSend = [];
  for (const m of pendingSay) {
    if (now - (m.at || 0) > 86400000) { console.log("[say-queue] 丢弃超 24h 的过期消息:", m.text); continue; }
    toSend.push(m);
  }
  pendingSay = []; // 立即清空（不重试，避免整队列卡循环）
  savePendingSay();
  if (!toSend.length) return;
  console.log("[say-queue] 登录成功，开始补发 " + toSend.length + " 条离线期间的消息");
  toSend.forEach((m, i) => {
    setTimeout(() => {
      try { bot.chat(m.text); console.log("[say-queue] 已补发:", m.text); }
      catch (e) { console.log("[say-queue] 补发失败:", e.message); }
    }, 1500 + i * 1500);
  });
}

// 6) 随机问候：不定时 @ 在线玩家打招呼（"你好呀！你在干嘛？"），并根据回复用 LLM 接话
let randomGreetTimer = null;
const greetActive = new Map(); // 玩家名 -> 会话窗口过期时间戳
const GREET_AI_RE = /deepseek|_bot$|\d{4}$/i; // 排除 AI/小号（名字带 _bot 或以 4 位数字结尾的账号）
// ---- 反挂机 ----
// 本服的踢人是 socketClosed（不给原因包），且两只 bot 同一秒一起断 —— 很像服务端定时检查。
// 挂机不动最容易被判 AFK，这里定时微转视角（会有 position_look 包）+ 偶尔小跳。
let antiAfkTimer = null;
function startAntiAfk() {
  if (process.env.ANTI_AFK_OFF === "1") { console.log("[afk] 已被 ANTI_AFK_OFF=1 关闭"); return; }
  if (antiAfkTimer) clearInterval(antiAfkTimer);
  antiAfkTimer = setInterval(() => {
    try {
      if (!bot || !bot.entity) return;
      bot.look(bot.entity.yaw + 0.5, bot.entity.pitch, true);   // force=true 才会真正发包
      if (Math.random() < 0.35) {
        bot.setControlState("jump", true);
        setTimeout(() => { try { bot.setControlState("jump", false); } catch (_) {} }, 260);
      }
    } catch (_) {}
  }, 45000);
  console.log("[afk] 反挂机已启动（每 45s 微转视角，35% 概率小跳）");
}

function startRandomGreet() {
  if (process.env.RUN_RANDOM_GREET !== "1") return; // 默认关闭：用户要求停止随机搭话（"你好呀！你在干嘛？"）
  if (randomGreetTimer) return;
  scheduleRandomGreet(true);
}
function scheduleRandomGreet(first) {
  const mins = first ? 2 + Math.random() * 5 : 12 + Math.random() * 18; // 首次 2~7 分钟，之后 12~30 分钟
  console.log("[greet] 下次随机问候在 " + Math.round(mins) + " 分钟后");
  randomGreetTimer = setTimeout(() => {
    tryRandomGreet();
    scheduleRandomGreet(false);
  }, Math.round(mins * 60 * 1000));
}
function tryRandomGreet() {
  if (process.env.RUN_RANDOM_GREET !== "1") return; // 默认关闭：用户要求停止随机搭话
  if (!canSay()) { console.log("[greet] 跳过：bot 未就绪"); return; }
  const now = Date.now();
  for (const [n, exp] of greetActive) if (now >= exp) greetActive.delete(n);
  if (greetActive.size > 0) { console.log("[greet] 跳过：已有进行中的会话（" + [...greetActive.keys()].join(",") + "）"); return; }
  const names = Object.keys(bot.players || {}).filter((n) => n && !GREET_AI_RE.test(n) && n.toLowerCase() !== USER.toLowerCase());
  if (!names.length) { console.log("[greet] 跳过：没有可问候的其他玩家"); return; }
  const target = names[Math.floor(Math.random() * names.length)];
  bot.chat("@" + target + " 你好呀！你在干嘛？");
  greetActive.set(target, now + 10 * 60 * 1000); // 10 分钟会话窗口
  console.log("[greet] → 已问候 " + target + "（会话窗口 10 分钟）");
}

// 3) 实体感知（对标 aiplayer entity_groups：找牛/找玩家/发现敌对都用它）
function collectEntities(maxDist) {
  if (!bot || !bot.entity) return { groups: [], nearest: [] };
  const me = bot.entity.position;
  const groups = {};
  const list = [];
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position) continue;
    const dist = e.position.distanceTo(me);
    if (dist > maxDist) continue;
    const name = e.username || e.displayName || e.name || e.type;
    const key = e.type + ":" + name;
    if (!groups[key]) groups[key] = { type: e.type, name, count: 0, nearest: { dist: 9999, pos: null, hp: null } };
    const g = groups[key];
    g.count++;
    if (dist < g.nearest.dist) {
      g.nearest = { dist: +dist.toFixed(1), pos: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) }, hp: e.health ?? null };
    }
    list.push({ name, type: e.type, dist: +dist.toFixed(1), pos: e.position });
  }
  list.sort((a, b) => a.dist - b.dist);
  const sorted = Object.values(groups).sort((a, b) => a.nearest.dist - b.nearest.dist);
  return { groups: sorted, nearest: list.slice(0, 10) };
}
const HOSTILE_HINTS = ["zombie", "skeleton", "creeper", "spider", "witch", "enderman", "slime", "phantom", "blaze", "ghast", "pillager", "vindicator", "ravager", "warden", "hoglin", "piglin", "silverfish", "cave_spider", "drowned", "husk", "stray", "magma"];
// ★ COMBAT_RANGE / COMBAT_ON 已提前到自动战斗段落声明，避免重复声明
const COMBAT_ON = process.env.COMBAT_OFF !== "1";

// ---- 超越维度 (Beyond Dimensions) 模组 NeoForge 自定义包编码辅助 ----
// 该模组用 O 键打开"维度网络"存储界面；协议 bot 无客户端模组，需复现按键发出的自定义包。
// 数据包均为 CustomPacketPayload，经 minecraft:custom_payload 发送（channel = 包体 type 的 ResourceLocation）。
function bdVarInt(n) {
  const bytes = [];
  let value = n >>> 0;
  while (true) {
    if ((value & ~0x7F) === 0) { bytes.push(value); break; }
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  return Buffer.from(bytes);
}
// STRING_UTF8 编码：VarInt(utf8 字节数) + utf8 字节
function bdUtf8(s) {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([bdVarInt(b.length), b]);
}

// ===== 超越维度 (Beyond Dimensions) 动作封装（决策桥 + 聊天触发 共用） =====
// 该模组无客户端模组，所有"按键"本质都是发一个 NeoForge 自定义包。
// 存储是类 AE2 的超大容量网络：NET_MENU 走标准 Minecraft 容器（可直接读槽位）。

// 解析物品 registry id（支持 minecraft: 前缀省略）
function bdResolveItemId(name) {
  if (!bot || !bot.registry) return null;
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  const reg = bot.registry;
  if (/^\d+$/.test(n)) return reg.items[Number(n)] ? Number(n) : null;   // 直接给数字 id
  const full = n.includes(":") ? n : "minecraft:" + n;
  if (reg.itemsByName[full]) return reg.itemsByName[full].id;
  // 模糊匹配：名字包含查询串，取最短的（更精确，避免 diamond→diamond_block）
  const cands = [];
  for (const k in reg.itemsByName) {
    const e = reg.itemsByName[k];
    if (e && e.name && e.name.toLowerCase().includes(n)) cands.push(e);
  }
  if (!cands.length) return null;
  cands.sort((a, b) => String(a.name).length - String(b.name).length);
  return cands[0].id;
}

// ItemStack OPTIONAL 编码（1.21 格式：present + (registryId+1) + count + tag(false) + 空组件）
// 注意：1.20.5+ 的 writeItem 写的是 registryId+1（0 表示空），取物品包只需物品类型匹配，NBT/组件可省。
// ItemStack 编码（1.21.1 实测，见 protocol.json 的 Slot 定义）：
//   varint itemCount          0 = 空
//   非 0 时： varint itemId（原始 registry id，0=air，**不要 +1**）
//             varint addedComponentCount
//             varint removedComponentCount
//             之后才是组件数据
// 旧实现是 1.20.4 的 present+tag 格式，还多了 1 字节，服务端解出来是错的 → 取物永远失败。
function bdItemStackBuffer(itemId, count) {
  const n = Math.max(0, Number(count) || 0);
  if (!n) return bdVarInt(0);
  return Buffer.concat([
    bdVarInt(n),            // itemCount
    bdVarInt(itemId),       // itemId
    bdVarInt(0),            // addedComponentCount
    bdVarInt(0),            // removedComponentCount
  ]);
}

// O 键：打开维度网络（craft=true 打开带合成栏的 NET_CRAFT_MENU）→ 走的通道名
// ★ 编码（反编译 OpenNetGuiPacket$1 得出）：Utf8String(uuid) + Utf8String(枚举名)
//   枚举是**字符串**不是 varint！发 varint 会让 NetMenuType.valueOf("") 抛异常 → 服务端直接踢人。
//   uuid 字段服务端根本没读（handleInServer 只用 player），发空串最省。
function bdOpenNetwork(craft, fmt) {
  if (!client) return { ok: false, error: "bot 未连接" };
  let target = craft ? "NET_CRAFT_MENU" : "NET_MENU";
  const f = fmt == null ? "" : String(fmt).trim();
  if (f) {
    if (/^\d+$/.test(f)) target = ["NET_MENU", "NET_CRAFT_MENU", "NET_CRAFT_TERMINAL"][Number(f)] || "NET_MENU";
    else if (/^NET_/i.test(f)) target = f.toUpperCase();
  }
  const body = Buffer.concat([bdUtf8(""), bdUtf8(target)]);
  client.write("custom_payload", { channel: "beyonddimensions:open_net_gui_packet", data: body });
  console.log("[BD] 打开维度网络 target=" + target + " (" + body.length + "B)");
  return { ok: true, action: "bd_open_network", target, bytes: body.length };
}

// [ 键：开关磁铁（which: ALL=0 / ITEM=1 / FLUID=2）
function bdToggleMagnet(which) {
  if (!client) return { ok: false, error: "bot 未连接" };
  const w = (which === 1 || which === "ITEM") ? 1 : (which === 2 || which === "FLUID") ? 2 : 0;
  client.write("custom_payload", { channel: "beyonddimensions:toggle_magnet_packet", data: bdVarInt(w) });
  console.log("[BD] 开关磁铁 (" + (w === 0 ? "ALL" : w === 1 ? "ITEM" : "FLUID") + ")");
  return { ok: true, action: "bd_toggle_magnet", which: w };
}

// U 键：打开主网络切换器
function bdOpenSwitcher() {
  if (!client) return { ok: false, error: "bot 未连接" };
  client.write("custom_payload", { channel: "beyonddimensions:open_primary_net_switcher_packet", data: Buffer.alloc(0) });
  console.log("[BD] 打开主网络切换器");
  return { ok: true, action: "bd_open_switcher" };
}

// 在背包里找物品（返回 Item 对象）
function bdFindItem(itemName) {
  if (!bot) return null;
  const items = bot.inventory.items();
  // 1) 数字 = 物品 type id（模组物品在注册表里没名字，只能按 type 找）
  const asNum = Number(itemName);
  if (Number.isFinite(asNum) && String(itemName).trim() !== "") {
    const byType = items.find((it) => it.type === asNum);
    if (byType) return byType;
  }
  // 3) 名字匹配（未知物品回落到 frozen_registry 解析出的英文 id）
  const lower = String(itemName || "").trim().toLowerCase();
  const nm = (it) => ((it && it.name && it.name !== "unknown") ? it.name : ((global.__itemMap && it) ? (global.__itemMap[it.type] || "") : "")).toLowerCase();
  let f = items.find((it) => nm(it).includes(lower));
  if (!f) f = items.find((it) => it.displayName && String(it.displayName).toLowerCase().includes(lower));
  return f || null;
}

// 存：把背包里某物品整组存入主网络（先装备到主手 → PutHandItemToNetPacket）
async function bdDeposit(itemName) {
  if (!client || !bot) return { ok: false, error: "bot 未连接" };
  if (!itemName) return { ok: false, error: "缺少物品名" };
  const it = bdFindItem(itemName);
  if (!it) return { ok: false, error: "背包里没找到 " + itemName };
  try { await bot.equip(it, "hand"); } catch (e) { return { ok: false, error: "装备到主手失败:" + e.message }; }
  await new Promise((r) => setTimeout(r, 200));
  const hand = bot.heldItem;
  if (!hand) return { ok: false, error: "主手为空，存入失败" };
  client.write("custom_payload", { channel: "beyonddimensions:put_hand_item_to_net_packet", data: bdUtf8("MAIN_HAND") });
  console.log("[BD] 存入主网络：" + hand.name + "×" + hand.count);
  return { ok: true, action: "bd_deposit", item: hand.name, count: hand.count };
}

// 取：从主网络取出某物品到主手（主手须空 → PickBlockFromNetPacket；服务端仅按物品类型匹配）
async function bdWithdraw(itemName, count) {
  if (!client || !bot) return { ok: false, error: "bot 未连接" };
  if (!itemName) return { ok: false, error: "缺少物品名" };
  const id = bdResolveItemId(itemName);
  if (id == null) return { ok: false, error: "无法解析物品ID: " + itemName };
  const want = Math.max(1, Math.min(Number(count) || 1, 64));
  // ★ 主手必须为空，否则服务端第一句就 return
  if (bot.heldItem) { try { await bot.unequip("hand"); } catch (e) { } await sleep(200); }
  const body = bdItemStackBuffer(id, want);
  client.write("custom_payload", { channel: "beyonddimensions:pick_block_from_net_packet", data: body });
  await sleep(650);
  const got = bot.heldItem;
  const name = (bot.registry.items[id] && bot.registry.items[id].name) || (global.__itemMap && global.__itemMap[id]) || itemName;
  if (!got || got.type !== id) {
    console.log("[BD] 取物失败：" + itemName + "（主手=" + (got ? got.name : "空") + "）");
    return { ok: false, action: "bd_withdraw", requested: itemName, error: "网络里没有该物品或取物失败" };
  }
  console.log("[BD] 从主网络取出：" + name + " ×" + got.count);
  return { ok: true, action: "bd_withdraw", item: name, count: got.count, requested: want };
}

// 读：打开 NET_MENU（标准容器）→ 收集 windowItems 槽位 → 关闭 → 返回物品清单
// ★ 注意：mineflayer 的 window.slots[i] 本身就是 Item（带 .type/.count/.slot），不是 {item} 包装。
//   旧代码写 s.item 永远为 undefined → 永远读到 0 件，这是之前"背包/网络读不出东西"的同类 bug。
function netCollectSlots(window, slots) {
  const arr = Array.isArray(slots) ? slots : (window && Array.isArray(window.slots) ? window.slots : []);
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    if (!s || !s.type || !s.count) continue;
    const nm = (s.name && s.name !== "unknown") ? s.name
      : (bot.registry.items[s.type] && bot.registry.items[s.type].name)
      || (global.__itemMap && global.__itemMap[s.type]) || ("#" + s.type);
    out.push({ slot: (s.slot != null ? s.slot : i), item: nm, count: s.count, type: s.type });
  }
  return out;
}

// 解析维度网络存储同步包（DisorderedSlotGroupSyncPacket，s2c）
// 线格式（反编译 STREAM_CODEC）：
//   varint groupId
//   varint nKeys  × [ ResourceLocation typeId + IStackKey.serialize(...) ]
//   varint nCounts × varintLong
//   varint nMod    × varintLong
//   varint nIns    × varintLong
// ItemStackKey.serialize：bool present | [ ResourceLocation itemId + DataComponentPatch ]
function decodeBdNetSync(buf) {
  let o = 0;
  const rv = () => { let v = 0, s = 0, n; do { n = buf[o + s]; v += (n & 0x7f) * Math.pow(2, 7 * s); s++; } while (n & 0x80); o += s; return v; };
  const rvLong = () => { let v = 0n, s = 0, n; do { n = buf[o + s]; v |= BigInt(n & 0x7f) << BigInt(7 * s); s++; } while (n & 0x80); o += s; return v; };
  const utf = () => { const n = rv(); const s = buf.slice(o, o + n).toString("utf8"); o += n; return s; };
  const out = { groupId: 0, keys: [], counts: [], complete: false, offset: 0, total: 0, error: null };
  try {
    out.groupId = rv();
    const nKeys = rv();
    out.total = nKeys;
    for (let i = 0; i < nKeys; i++) {
      const typeId = utf();
      let item = null;
      if (/stack_type\/item$/.test(typeId)) {
        const present = buf[o++];
        if (present) {
          item = utf();
          const added = rv();     // DataComponentPatch：added / removed 两个 varint
          const removed = rv();
          if (added !== 0 || removed !== 0) throw new Error("第 " + i + " 个物品带数据组件(" + added + "/" + removed + ")，无法跳过");
        }
      } else {
        throw new Error("第 " + i + " 个是非物品键: " + typeId);
      }
      out.keys.push(item);
    }
    const nC = rv();
    for (let i = 0; i < nC; i++) out.counts.push(Number(rvLong()));
    const nMod = rv(); for (let i = 0; i < nMod; i++) rvLong();
    const nIns = rv(); for (let i = 0; i < nIns; i++) rvLong();
    out.complete = (o === buf.length);
    out.offset = o;
  } catch (e) {
    out.error = e.message;
    out.offset = o;
  }
  return out;
}

// 近似清单：直接扫存储同步包里的键前缀，抽出物品名（不依赖组件跳过，因此拿不到数量）
// 用于"网络里有哪些东西"——精确计数目前受模组自定义组件阻塞。
const BD_KEY_PREFIX = Buffer.from("\x20beyonddimensions:stack_type/item", "latin1");
function scanBdNetNames() {
  const buf = global.__bdNetSync;
  if (!buf) return null;
  const names = [];
  let i = buf.indexOf(BD_KEY_PREFIX);
  let guard = 0;
  while (i >= 0 && guard++ < 5000) {
    let o = i + BD_KEY_PREFIX.length;
    const present = buf[o++];
    if (present === 1) {
      const n = buf[o++];
      if (n > 0 && n < 200) {
        const s = buf.slice(o, o + n).toString("utf8");
        if (/^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(s)) names.push(s);
      }
    }
    i = buf.indexOf(BD_KEY_PREFIX, i + 1);
  }
  return Array.from(new Set(names)).sort();
}

function bdNetSummary() {
  const buf = global.__bdNetSync;
  if (!buf) return null;
  const d = decodeBdNetSync(buf);
  const summary = {};
  for (let i = 0; i < d.keys.length; i++) {
    const nm = d.keys[i] || "(空)";
    summary[nm] = (summary[nm] || 0) + (d.counts[i] || 0);
  }
  d.summary = summary;
  d.bytes = buf.length;
  return d;
}

// 读：打开 NET_MENU → 同时尝试两条通道
//   ① 容器槽位（window_items，标准容器同步）
//   ② 存储同步包 disordered_slot_group_sync_packet（模组自定义同步）
// 哪个有数据用哪个，两个都有就合并（容器优先，字段更干净）。
async function bdReadNet() {
  if (!client || !bot) return { ok: false, error: "bot 未连接" };
  // 关掉现有界面后必须留时间让服务端处理，否则紧接着的 open_net_gui 会被吞掉
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (e) { }
  await sleep(500);
  bdOpenNetwork(false);
  await sleep(2200);
  const w = bot.currentWindow;
  let winList = w ? netCollectSlots(w, w.slots) : [];
  const winInfo = w ? { windowId: w.id, windowType: w.type, windowSlots: w.slots.length } : null;
  try { if (w) bot.closeWindow(w); } catch (e) { }
  // 实测 NET_MENU 的容器窗口只有 36 格（玩家背包部分），网络物品不走容器同步
  // → 只有槽位数明显大于 36 时才算"真的把存储塞进容器了"，否则一律用同步包
  if (winInfo && winInfo.windowSlots <= 100) winList = [];
  const sync = bdNetSummary();
  const syncList = sync ? sync.keys.map((k, i) => ({ item: k || "(空槽)", count: sync.counts[i] || 0 })) : [];
  const pick = winList.length ? winList : syncList;
  const source = winList.length ? "window" : (syncList.length ? "sync" : "none");
  if (!pick.length) {
    return {
      ok: false,
      error: "两条通道都没读到内容（窗口 " + (winInfo ? winInfo.windowSlots + " 格" : "未打开") + "；同步包 " + (sync ? sync.bytes + "B" : "未收到") + "）",
      winInfo, syncKeys: sync ? sync.keys.length : 0,
    };
  }
  const agg = {};
  for (const it of pick) agg[it.item] = (agg[it.item] || 0) + it.count;
  console.log("[BD] 读取网络完成 source=" + source + " 种类=" + Object.keys(agg).length);
  return {
    ok: true, action: "bd_read_net", source,
    count: pick.length, items: pick, summary: agg,
    winInfo,
    namesApprox: scanBdNetNames(),
    sync: sync ? { bytes: sync.bytes, keys: sync.keys.length, total: sync.total, complete: sync.complete, parseError: sync.error } : null,
  };
}

// 从维度网络取物 → 丢给指定玩家
// 服务端 PickBlockFromNetPacket 要求：**主手为空** + 按 Item 类型匹配（数量取 targetStack 的 count）
async function netGiveToPlayer(query, count, playerName) {
  if (!client || !bot) return { ok: false, error: "bot 未连接" };
  const id = bdResolveItemId(query);
  if (id == null) return { ok: false, error: "无法解析物品：" + query };
  const name = (bot.registry.items[id] && bot.registry.items[id].name)
    || (global.__itemMap && global.__itemMap[id]) || String(query);
  const want = Math.max(1, Math.min(Number(count) || 1, 64));
  // 1) 主手必须空
  if (bot.heldItem) { try { await bot.unequip("hand"); } catch (e) { } await sleep(200); }
  if (bot.heldItem) { try { await bot.tossStack(bot.heldItem); } catch (e) { } await sleep(250); }
  // 2) 发取物包
  client.write("custom_payload", { channel: "beyonddimensions:pick_block_from_net_packet", data: bdItemStackBuffer(id, want) });
  console.log("[BD] 网络取物请求：" + name + " ×" + want);
  await sleep(700);
  const got = bot.heldItem;
  if (!got || got.type !== id) {
    return { ok: false, error: "网络里没有 " + name + "（或取物失败）", item: name, requested: want };
  }
  const n = Math.min(want, got.count);
  // 3) 面向玩家再丢（否则会扔到背后）
  try {
    const target = Object.values(bot.entities).find((e) => (e.username === playerName) || (e.name === playerName));
    if (target && target.position) await bot.lookAt(target.position.offset(0, 1.5, 0), true);
  } catch (e) { }
  const invCountById = (tid) => bot.inventory.items().filter((i) => i.type === tid).reduce((s2, i) => s2 + i.count, 0);
  const before = invCountById(id);
  let tossErr = null;
  try {
    if (n >= got.count) await bot.tossStack(got);
    else await bot.toss(got.type, null, n);
  } catch (e) { tossErr = e.message; }
  await sleep(450);
  const after = invCountById(id);
  const dropped = Math.max(0, before - after);
  if (!dropped) {
    console.log("[BD] 取到了但没能丢出（物资仍在背包 slot=" + got.slot + "）" + (tossErr ? " 错误:" + tossErr : ""));
    return { ok: false, error: "取到了 " + name + " 但丢出失败（已在背包）" + (tossErr ? ":" + tossErr : ""), item: name, inventoryLeft: after };
  }
  console.log("[BD] 已从网络取出并丢给 " + playerName + "：" + name + " ×" + dropped + "（背包剩余 " + after + "）");
  return { ok: true, action: "net_give", item: name, count: dropped, to: playerName, inventoryLeft: after };
}

// ===== 游戏内指令：@//bot/ <指令> [参数] =====
// 玩家在服务器聊天框直接给 bot 下任务，不需要外部 HTTP。
// 兜底逻辑：不认识的指令一律当"决策桥动作名"，自调用本地 HTTP 桥 → 自动继承全部能力。
const CHAT_CMD_PREFIX = "@//bot/";

function bridgeSelfCall(obj) {
  return new Promise((resolve) => {
    try {
      const data = JSON.stringify(obj);
      const req = http.request({
        host: "127.0.0.1", port: BRIDGE_PORT, method: "POST", path: "/",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false, error: "桥接返回非JSON" }); } });
      });
      req.on("error", (e) => resolve({ ok: false, error: "桥接不可用:" + e.message }));
      req.write(data);
      req.end();
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

// 对最近敌对目标"点按"一次（单次 bot.attack，不按住、不连点）
async function attackNearestOnce() {
  if (!bot || !bot.entity) return { ok: false, error: "未在线" };
  const list = findHostiles(COMBAT_RANGE);
  let t = list[0];
  if (!t && lastAttacker && lastAttacker.position) {
    t = { ent: lastAttacker, name: lastAttacker.name || lastAttacker.username || "?", dist: lastAttacker.position.distanceTo(bot.entity.position) };
  }
  if (!t) return { ok: false, error: "附近 " + COMBAT_RANGE + " 格内没有敌对目标" };
  const w = await equipWeapon();
  if (!w) return { ok: false, error: "背包里没有可用武器" };
  try { await bot.lookAt(t.ent.position.offset(0, (t.ent.height || 1) * 0.85, 0), true); } catch (e) { }
  const d = t.ent.position.distanceTo(bot.entity.position);
  if (d > 4.2) {
    try { bot.pathfinder.setGoal(new goals.GoalNear(t.ent.position.x, t.ent.position.y, t.ent.position.z, 2)); } catch (e) { }
    return { ok: false, error: "目标在 " + d.toFixed(1) + " 格外，正在靠近" };
  }
  await bot.attack(t.ent);
  return { ok: true, target: t.name, weapon: w.name, dist: +d.toFixed(1) };
}

async function handleChatCommand(rawText, player) {
  const full = String(rawText || "");
  const idx = full.indexOf(CHAT_CMD_PREFIX);
  const body = idx >= 0 ? full.slice(idx + CHAT_CMD_PREFIX.length).trim() : full.trim();
  const reply = (s) => { try { bot.chat("@" + player + " " + String(s).slice(0, 80)); } catch (e) { } };
  const usage = () => reply("用法 @//bot/ <指令>：help / net（看网络）/ get <物品> [数量] / inv / where / state / warp <石碑> / stop / attack / raw <json> / 也可直接填桥接动作名");
  if (!body) { usage(); return; }
  const sp = body.search(/\s/);
  const head = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
  const tail = sp < 0 ? "" : body.slice(sp + 1).trim();
  console.log("[CMD] " + player + " → " + head + (tail ? " " + tail.slice(0, 80) : ""));

  try {
    switch (head) {
      case "help": case "?": case "帮助":
        usage(); return;
      case "net": case "netlist": case "网络": {
        reply("正在读取维度网络…");
        const r = await bdReadNet();
        const kw = tail.trim().toLowerCase();
        // 精确计数能对上时优先用它
        const arr = Object.entries(r.summary || {}).filter(([n]) => n !== "(空槽)").sort((a, b) => b[1] - a[1]);
        if (arr.length >= 20) {
          const hit = kw ? arr.filter(([n]) => n.toLowerCase().includes(kw)) : arr;
          if (!hit.length) return reply("网络里没有匹配 " + kw + " 的物品");
          const lines = hit.slice(0, 5).map(([n, c]) => n.replace("minecraft:", "") + "×" + c).join("、");
          return reply("网络 " + hit.length + " 种：" + lines + (hit.length > 8 ? " …还有 " + (hit.length - 8) + " 种" : ""));
        }
        // 计数不可用时退回"物品名清单"
        let names = r.namesApprox || [];
        if (!names.length) return reply(r.ok ? "维度网络里没读到物品" : ("读取失败：" + r.error));
        if (kw) names = names.filter((n) => n.toLowerCase().includes(kw));
        if (!names.length) return reply("网络里没有匹配 " + kw + " 的物品");
        const sample = names.slice(0, 5).map((n) => n.replace("minecraft:", "")).join("、");
        return reply("网络约 " + names.length + " 种物品（数量暂不可精确读取）：" + sample + (names.length > 8 ? " …" : ""));
      }
      case "get": case "give": {
        const m = tail.match(/^(\S+)(?:\s+(\d+))?$/);
        if (!m) return reply("用法：@//bot/ get <物品id> [数量]，例 @//bot/ get diamond 16");
        const r = await netGiveToPlayer(m[1], Number(m[2] || 1), player);
        if (!r.ok) return reply("取不到：" + r.error);
        return reply("已从维度网络取出并丢给你：" + r.item.replace("minecraft:", "") + " ×" + r.count);
      }
      case "inv": case "背包": {
        const its = bot.inventory.items();
        if (!its.length) return reply("背包是空的");
        return reply("背包 " + its.length + " 种：" + its.slice(0, 8).map((i) => i.name.replace("minecraft:", "") + "×" + i.count).join("、"));
      }
      case "where": case "pos": case "位置": {
        const p = bot.entity.position;
        return reply("我在 " + p.x.toFixed(0) + ", " + p.y.toFixed(0) + ", " + p.z.toFixed(0) + "  hp=" + Math.round(bot.health) + " 饥饿=" + Math.round(bot.food));
      }
      case "state": case "状态": {
        const r = await bridgeSelfCall({ type: "state" });
        return reply("online=" + r.online + " authed=" + r.authed + " hp=" + r.health + " lv=" + (r.experience && r.experience.level) + " 重连=" + r.reconnects);
      }
      case "say": {
        if (tail) bot.chat(tail.slice(0, 200));
        return;
      }
      case "stop": case "停": {
        try { if (bot.pathfinder) bot.pathfinder.setGoal(null); } catch (e) { }
        try { bot.clearControlStates(); } catch (e) { }
        return reply("已停止当前动作");
      }
      case "attack": case "打": {
        const r = await attackNearestOnce();
        if (!r.ok) return reply("没打：" + r.error);
        return reply("点按攻击 " + r.target + "（" + r.weapon + "，距离 " + r.dist + "）");
      }
      case "raw": {
        let obj;
        try { obj = JSON.parse(tail); } catch (e) { return reply("raw 需要合法 JSON"); }
        const r = await bridgeSelfCall(obj);
        return reply(JSON.stringify(r).slice(0, 200));
      }
      default: {
        // 其余一律当桥接动作：@//bot/ bd_read_net  或  @//bot/ bd_withdraw {"item":"diamond","count":8}
        const obj = { type: head };
        if (tail) {
          if (tail.startsWith("{")) { try { Object.assign(obj, JSON.parse(tail)); } catch (e) { obj.text = tail; } }
          else obj.text = tail;
        }
        const r = await bridgeSelfCall(obj);
        return reply(head + " → " + JSON.stringify(r).slice(0, 180));
      }
    }
  } catch (e) {
    reply("执行出错: " + e.message);
  }
}

// ===== 超越维度：喂食护符 / 管理员连接符 集成 =====
// 关键事实（已查源码确认）：
//  · net_manager_inviter（管理员连接符）：右键(主手/不潜行) → 把玩家加为网络管理员并设为该玩家主网络；连接符会被消耗。
//    前提：玩家当前无主网络(getPrimaryNetFromPlayer==null) 且 连接符已绑定(NET_ID_DATA>=0)。
//  · net_feeder_item（喂食护符）：本身就是一个"机器物品"，会随 inventoryTick 周期性工作——它自行从绑定的
//    维度网络按白名单(ISTACK_SLOTS，始终 WHITE)取食物进食。=> 喂食逻辑由模组完成，bot 只需：①让护符待在
//    背包(任意会被 tick 的槽)或 Curios 饰品栏；②确保护符已绑定网络；③(可选)用 bot 侧兜底自动喂食。
//  · Curios：beyonddimensions 通过 integration 给这些物品挂了 ICurio 能力，所以护符可进饰品栏(且 curioTick 也触发)。
//    但即便只在普通背包槽也会经 inventoryTick 自动喂食，功能等价。

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 默认白名单（bot 侧兜底自动喂食用的食物；模组喂食护符用自己的内部白名单，两者独立）
let BD_FEED_WHITELIST = ["cooked_beef", "bread", "golden_carrot", "cooked_porkchop", "baked_potato", "apple", "cooked_chicken"];
const BD_FEED_THRESHOLD = 14;     // 饥饿值 ≤ 此值触发兜底喂食
let BD_AUTO_FEED = false;         // 是否启用 bot 侧兜底自动喂食（模组喂食护符为主）
let BD_FOOD_MONITOR = null;

// 绑定网络：手持管理员连接符右键使用
async function bdBindNetwork(sel) {
  if (!client || !bot) return { ok: false, error: "bot 未连接" };
  let it = null;
  if (sel != null && sel !== "") {
    const n = Number(sel);
    if (Number.isFinite(n)) it = bot.inventory.slots[n] || bdFindItem(sel);
    else it = bdFindItem(sel);
  }
  if (!it) it = bdFindItem("net_manager_inviter") || bdFindItem("管理员连接符") || bdFindItem("连接符") || bdFindItem("inviter") || bdFindItem("manager");
  if (!it) return { ok: false, error: "背包里没找到连接符（模组物品无名字时请传 slot 或 type）" };
  try { await bot.equip(it, "hand"); } catch (e) { return { ok: false, error: "装备连接符到主手失败:" + e.message }; }
  await sleep(200);
  try { await bot.activateItem(); } catch (e) { try { bot.deactivateItem(); } catch (_) {} return { ok: false, error: "右键使用连接符失败:" + e.message }; }
  try { bot.deactivateItem(); } catch (e) {}
  await sleep(350);
  return { ok: true, action: "bd_bind_network", sent: true, note: "右键连接符→绑定为管理员并设为主网络；连接符会被消耗。之后 O 键可开维度网络。" };
}

// 装备喂食护符：确保它在背包（自动喂食），并尽力用 Curios GUI 把它移入饰品栏（失败也不影响喂食）
async function bdEquipFeeder(sel) {
  if (!client || !bot) return { ok: false, error: "bot 未连接" };
  let it = null;
  if (sel != null && sel !== "") {
    const n = Number(sel);
    if (Number.isFinite(n)) it = bot.inventory.slots[n] || bdFindItem(sel);
    else it = bdFindItem(sel);
  }
  if (!it) it = bdFindItem("net_feeder_item") || bdFindItem("喂食护符") || bdFindItem("喂食") || bdFindItem("护符") || bdFindItem("feeder");
  if (!it) return { ok: false, error: "背包里没找到喂食护符（模组物品无名字时请传 slot 或 type）" };
  let curios = "未尝试";
  try {
    // 打开饰品 GUI（curios:open_curios，data=单字节 0x00 表示空 ItemStack=仅打开）
    client.write("custom_payload", { channel: "curios:open_curios", data: Buffer.from([0]) });
    let win = null;
    for (let i = 0; i < 25 && !win; i++) { await sleep(200); win = bot.currentWindow; }
    if (win) {
      const feederSlot = win.slots.find((s) => s && s.type && s.count > 0 && ((s.name && s.name !== "unknown" ? s.name : ((bot.registry.items[s.type] || {}).name || ""))).includes("feeder"));
      if (feederSlot) {
        try { await bot.clickWindow(feederSlot.slot, 0, 1, win); curios = "已 shift-click 进饰品栏(feederSlot=" + feederSlot.slot + ")"; }
        catch (e) { curios = "shift-click 失败:" + e.message; }
      } else curios = "饰品窗口里没找到喂食护符(可能在玩家背包部分)";
      try { bot.closeWindow(win); } catch (e) {}
    } else curios = "未打开饰品窗口(可能此版本 Curios 菜单不可用/无权限)";
  } catch (e) { curios = "打开饰品 GUI 失败:" + e.message; }
  return { ok: true, action: "bd_equip_feeder", feederFound: true, curios, note: "喂食护符在普通背包槽也会经 inventoryTick 自动喂食，Curios 仅为可视化/槽位；模组按护符自身白名单进食。" };
}

// 立即从维度网络取白名单食物并进食（bot 侧兜底，优先用于模组喂食护符未配置时）
async function bdFeedNow() {
  if (!client || !bot) return { ok: false, error: "bot 未连接" };
  for (const food of BD_FEED_WHITELIST) {
    const id = bdResolveItemId(food);
    if (id == null) continue;
    if (bot.heldItem) { try { await bot.unequip("hand"); } catch (e) {} await sleep(150); }
    client.write("custom_payload", { channel: "beyonddimensions:pick_block_from_net_packet", data: bdItemStackBuffer(id, 1) });
    await sleep(350);
    const got = bot.heldItem;
    const fn = food.replace("minecraft:", "");
    if (got && got.name && got.name.toLowerCase().includes(fn)) {
      try { await bot.consume(); } catch (e) { return { ok: false, error: "进食失败:" + e.message }; }
      await sleep(900);
      return { ok: true, action: "bd_feed_now", ate: got.name, foodLevelAfter: bot.food };
    }
  }
  return { ok: false, error: "维度网络里没有白名单食物(" + BD_FEED_WHITELIST.join(",") + ")" };
}

// 启动/停止 bot 侧兜底自动喂食监控
function bdStartFoodMonitor() {
  if (BD_FOOD_MONITOR) return { ok: true, already: true };
  BD_AUTO_FEED = true;
  BD_FOOD_MONITOR = setInterval(async () => {
    if (!bot || !client) return;
    try {
      const f = bot.food;
      if (BD_AUTO_FEED && f != null && f <= BD_FEED_THRESHOLD) {
        console.log("[BD喂食] 饥饿值=" + f + " ≤ " + BD_FEED_THRESHOLD + "，尝试从网络取食");
        const r = await bdFeedNow();
        console.log("[BD喂食] " + JSON.stringify(r));
      }
    } catch (e) { console.log("[BD喂食] 监控异常:" + e.message); }
  }, 5000);
  return { ok: true, action: "bd_start_food_monitor", threshold: BD_FEED_THRESHOLD };
}
function bdStopFoodMonitor() {
  BD_AUTO_FEED = false;
  if (BD_FOOD_MONITOR) { clearInterval(BD_FOOD_MONITOR); BD_FOOD_MONITOR = null; }
  return { ok: true, action: "bd_stop_food_monitor" };
}

// 从自然语言里抠出物品名（去掉 @bot / 指令词 / 标点）
function bdExtractItemName(text) {
  if (!text) return null;
  let s = String(text)
    .replace(/@?\s*bot[_-]?one|bot[_-]?two|@bot/gi, "")
    .replace(/把|将|给|从网络|进网络|入网络|存进|存入|放进|放入|存|收|放|入库|进|取|拿|出|领|提取|取出|到主手|网络|维度|里|一下|一个|些|我|的/g, "")
    .replace(/[\s，。、！？!?,.]/g, "")
    .trim();
  return s || null;
}

// ===== Create: Storage（fxntstorage）背包 + 喷气背包 集成 =====
// 关键事实（已查源码 net.fxnt.fxntstorage 1.21.1 + 本地 jar 确认）：
//  · 背包物品：fxntstorage:hardened_backpack（硬化背包）等，注册为 Curios 物品，槽位标识符 "back"。
//  · 穿戴：equip 到 Curios "back" 槽（curios:open_curios 打开饰品 GUI 后 shift-click 进背槽）。
//    穿在 Curios 背槽：升级/jetpack/机械心脏 经 ICurio curioTick 生效，且死亡不掉（CURIOS_KEEP_BACKPACK）。
//  · 打开已穿戴背包：fxntstorage:key_pressed(hotKey=OPEN_BACKPACK=2) → 服务端 openBackpackFromInventory(WORN)，开标准容器(BackpackMenu)。
//  · 喷气背包：fxntstorage:jetpack_flying(flying:bool, hovering:bool)；fxntstorage:player_input(forward:float, left:float)。
//    TOGGLE_JETPACK=7 切换 FLIGHT 升级激活；TOGGLE_HOVER=5 切换悬停；JETPACK_KEY_PRESS=0/RELEASE=1 直接起降。
//  · 燃料同步（S2C）：fxntstorage:jetpack_fuel_sync(float fuelRemaining, varlong serverTime, varint modifier) → 剩余飞行秒数≈fuelRemaining。
//  · 升级英文名（整合包未汉化）：喷气=backpack_flight_upgrade 坠落=backpack_falldamage_upgrade 机械心脏=backpack_health_upgrade。
//  · 用户提前把升级放进背包升级栏再给 bot，bot 只需穿戴（无需放升级、无需编码背包 NBT）。

let CS_LAST_FUEL = null;   // 最近一次燃料同步的剩余飞行秒数
let CS_FUEL_TIME = null;   // 同步时间戳
let CS_AUTO_FLY = false;   // 自动飞起避障模式
let CS_TRAVEL = false;     // 喷气赶路模式
let CS_JET_ACTIVE = false; // 当前是否在喷气(飞起/悬停)
let CS_MONITOR = null;     // 监控定时器

// 读 VarInt / VarLong（用于解析燃料同步包）
function readVarIntBuf(buf, off) {
  let result = 0, shift = 0, pos = off;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, next: pos };
}
function readVarLongBuf(buf, off) {
  let result = 0n, shift = 0n, pos = off;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: Number(result), next: pos };
}
// 辅助：bool 字节 / float 4字节大端
function bdBool(b) { return Buffer.from([b ? 1 : 0]); }
function bdFloat(f) { const b = Buffer.alloc(4); b.writeFloatBE(f, 0); return b; }
function csItemNameMatch(name, kw) { return !!(name && name.toLowerCase().includes(kw.toLowerCase())); }

// ───────────────────────────────────────────────────────────────────────────
// 1.21.1 window_items 原始字节解析：逐槽定位某个物品的真实协议槽位下标。
// 关键：Curios 菜单的真实协议槽位 ≠ mineflayer 数组下标 ≠ 公式推算。
//       喂食护符(25009)正是靠解析原始包找到真实槽位 36 才成功装备的。
// 这里复刻 analyze-slot.mjs 的容错逻辑：坏组件尽量跳过，返回已解析到的 slots 数组。
// 返回 { wid, stateId, slots:[itemId|null], ok, err }
// ───────────────────────────────────────────────────────────────────────────
function csParseWinItems(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return { wid: null, stateId: null, slots: [], ok: false, err: "buf 太短" };
  const o0 = (buf[0] === 0x13) ? 1 : 0; // 跳过 packet id 字节
  let o = o0;
  const rv = () => { let v = 0, s = 0, n; do { n = buf[o + s]; v += (n & 0x7f) * Math.pow(2, 7 * s); s++; } while (n & 0x80); o += s; return v; };
  const u8 = () => buf[o++];
  const i32 = () => { const v = buf.readInt32BE(o); o += 4; return v; };
  const u16 = () => { const v = buf.readUInt16BE(o); o += 2; return v; };
  function nbtBody(t) {
    switch (t) {
      case 1: o += 1; break;
      case 2: o += 2; break;
      case 3: o += 4; break;
      case 4: o += 8; break;
      case 5: o += 4; break;
      case 6: o += 8; break;
      case 7: { const n = i32(); o += n; break; }
      case 8: { const n = u16(); o += n; break; }
      case 9: { const et = u8(); const n = i32(); for (let i = 0; i < n; i++) nbtBody(et); break; }
      case 10: { for (;;) { const tt = u8(); if (tt === 0) break; const nl = u16(); o += nl; nbtBody(tt); } break; }
      case 11: { const n = i32(); o += n * 4; break; }
      case 12: { const n = i32(); o += n * 8; break; }
      default: throw new Error("NBT tag=" + t + " @" + o);
    }
  }
  function nbt() { const t = u8(); if (t === 0) return; nbtBody(t); }
  function component() {
    const t = rv();
    switch (t) {
      case 0: case 5: case 6: case 36: case 37: case 38: case 39: nbt(); return;
      case 1: case 2: case 3: case 13: case 16: case 24: case 25: case 26: case 28: case 40: case 41: case 50: rv(); return;
      case 4: case 18: u8(); return;
      case 8: rv(); return;
      case 14: case 15: case 17: case 19: case 21: return;
      case 7: { const n = rv(); for (let i = 0; i < n; i++) { const p = u8(); if (p) nbt(); } return; }
      case 9: case 23: { const n = rv(); for (let i = 0; i < n; i++) { rv(); rv(); } u8(); return; }
      case 29: case 30: case 52: { const n = rv(); for (let i = 0; i < n; i++) slot(); return; }
      case 32: case 43: case 51: { const n = rv(); for (let i = 0; i < n; i++) rv(); return; }
      case 49: { const n = rv(); for (let i = 0; i < n; i++) { rv(); rv(); } return; }
      default: { // NeoForge 自定义组件：varint 计数 + 每条目(varint 长度 + 字节 + 1 字节标志)
        const cnt = rv();
        for (let i = 0; i < cnt; i++) { const n = rv(); o += n; o += 1; }
        return;
      }
    }
  }
  function slot() {
    const cnt = rv();
    if (cnt === 0) return; // 空槽
    const itemId = rv();
    slots.push(itemId);
    const added = rv();
    const removed = rv();
    for (let k = 0; k < added; k++) component();
    for (let k = 0; k < removed; k++) rv();
  }
  let wid, stateId, n;
  const slots = [];
  try {
    wid = u8();
    stateId = rv();
    n = rv();
    for (let i = 0; i < n; i++) slot();
    return { wid, stateId, slots, ok: true };
  } catch (e) {
    return { wid, stateId, slots, ok: false, err: e.message };
  }
}

// 在已解析的 slots 数组里找目标 itemId 第一次出现的协议槽位下标
function csFindSlotByItemId(buf, targetId) {
  const r = csParseWinItems(buf);
  if (!r.ok) return { index: -1, ok: false, err: r.err, partial: r.slots.slice() };
  const idx = r.slots.indexOf(targetId);
  return { index: idx, ok: true, wid: r.wid, stateId: r.stateId, count: r.slots.length };
}

// 在 bot 主物品栏里找背包（名字以 backpack 结尾，且非 upgrade）
function csFindBackpack() {
  if (!bot) return null;
  return (bot.inventory.items() || []).find((it) => it && it.name && /backpack$/.test(it.name.replace("fxntstorage:", ""))) || null;
}
// 发送 fxntstorage:key_pressed（hotKey, pressed, 无 BlockPos → optional 缺席=0x00）
function csKeyPressed(hotKey, pressed = true) {
  if (!client) return;
  const data = Buffer.concat([Buffer.from([hotKey & 0xff]), bdBool(pressed), Buffer.from([0x00])]);
  client.write("custom_payload", { channel: "fxntstorage:key_pressed", data });
  console.log("[CS] key_pressed hotKey=" + hotKey + " pressed=" + pressed);
}
function csJetFlying(flying, hovering) {
  if (!client) return;
  client.write("custom_payload", { channel: "fxntstorage:jetpack_flying", data: Buffer.concat([bdBool(flying), bdBool(hovering)]) });
  CS_JET_ACTIVE = flying;
  console.log("[CS] jetpack_flying flying=" + flying + " hovering=" + hovering);
}
function csJetInput(forward, left) {
  if (!client) return;
  client.write("custom_payload", { channel: "fxntstorage:player_input", data: Buffer.concat([bdFloat(forward), bdFloat(left)]) });
}

// 穿戴背包到 Curios 背槽（打开饰品 GUI 后 shift-click）
// 采用与已验证的 curios_equip 相同的「原始 window_click」方案：
//   · 不依赖 mineflayer 的窗口模型（TPS 低 / 模组组件时 currentWindow.slots 可能为空）；
//   · 用 window_items 原始包头捕获的 windowId/stateId/格数构造点击；
//   · Curios 菜单布局 = [前 C 个饰品槽] + [玩家主背包 27] + [快捷栏 9]，
//     任一玩家背包菜单槽 s 在菜单内的下标 = w.count - 45 + s（C = w.count-36，main 首槽 = C，hotbar 末槽 = 末尾）。
async function csEquipBackpack() {
  if (!client || !bot) return { ok: false, error: "bot 未连接" };
  const bp = csFindBackpack();
  if (!bp) return { ok: false, error: "背包里没找到背包物品(fxntstorage:*backpack)；可能已在饰品栏或已被取走" };
  const baseSlot = Number(bp.slot);
  let curios = "未尝试";
  try {
    client.write("custom_payload", { channel: "curios:open_curios", data: Buffer.from([0]) }); // 仅打开饰品 GUI（空 ItemStack）
    // 等待原始 window_items 捕获（不依赖 mineflayer 是否成功解析菜单）
    let w = null;
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      const lw = global.__lastWinItems;
      if (lw && Date.now() - lw.at < 6000) { w = lw; break; }
    }
    if (!w) {
      // 兜底：退回 mineflayer 窗口模型
      const win2 = bot.currentWindow;
      if (win2 && win2.slots && win2.slots.length) {
        const bpSlot = win2.slots.find((s) => s && s.type && s.count > 0 && /backpack$/.test(((s.name && s.name !== "unknown" ? s.name : ((bot.registry.items[s.type] || {}).name || ""))).replace("fxntstorage:", "")));
        if (bpSlot) { try { await bot.clickWindow(bpSlot.slot, 0, 1, win2); curios = "已 shift-click 进饰品栏(slot=" + bpSlot.slot + ")"; } catch (e) { curios = "shift-click 失败:" + e.message; } }
        else curios = "饰品窗口里没找到背包";
        try { bot.closeWindow(win2); } catch (e) {}
      } else curios = "未捕捉到 curios 窗口数据(饰品菜单未开/解析失败)";
    } else {
      const clickSlot = w.count - 45 + baseSlot; // 通用菜单下标换算
      client.write("window_click", {
        windowId: w.windowId,
        stateId: w.stateId,
        slot: clickSlot,
        mouseButton: 0,
        mode: 1, // shift-click → 服务端 quickMoveStack 自动入 back 槽
        changedSlots: [],
        cursorItem: { itemCount: 0, components: [], removeComponents: [] }
      });
      console.log("[CS] equip_backpack 原始 shift-click window=" + w.windowId + " stateId=" + w.stateId + " baseSlot=" + baseSlot + " clickSlot=" + clickSlot);
      curios = "已发原始 shift-click(clickSlot=" + clickSlot + ")";
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (e) {}
    }
  } catch (e) { curios = "打开饰品 GUI 失败:" + e.message; }
  await sleep(800); // 等服务端回写背包变化
  const stillThere = csFindBackpack();
  return { ok: true, action: "cs_equip_backpack", backpackFound: true, curios, stillInInventory: !!stillThere, leftInventory: !stillThere, maxHealth: bot ? bot.maxHealth : null, note: "穿在 Curios 背槽后：喷气/坠落保护/机械心脏(+血)生效，且死亡不掉。升级需你提前放好。成功判据：stillInInventory=false（背包已离开主背包）" };
}

// 打开已穿戴背包并读取内容（标准容器 BackpackMenu）
async function csReadBackpack() {
  if (!client || !bot) return { ok: false, error: "bot 未连接" };
  return new Promise((resolve) => {
    let done = false; const collected = [];
    const finish = (list) => {
      if (done) return; done = true; clearTimeout(timer);
      try { bot.removeListener("windowItems", onWin); } catch (e) {}
      csKeyPressed(3); // CLOSE_BACKPACK
      resolve({ ok: true, items: list });
    };
    const onWin = (window, slots) => {
      const arr = Array.isArray(slots) ? slots : (window && Array.isArray(window.slots) ? window.slots : []);
      for (const s of arr) {
        if (s && s.type && s.count > 0) {
          const nm = (s.name && s.name !== "unknown" ? s.name : ((bot.registry.items[s.type] || {}).name || ("#" + s.type)));
          collected.push({ slot: s.slot, item: nm, count: s.count });
        }
      }
      setTimeout(() => finish(collected), 250);
    };
    bot.on("windowItems", onWin);
    const timer = setTimeout(() => finish(collected), 1300);
    csKeyPressed(2); // OPEN_BACKPACK
    console.log("[CS] 打开已穿戴背包读取内容");
  });
}

// 存物品进背包（从 bot 主物品栏 shift-click 进背包存储槽）
async function csDeposit(itemKw) {
  if (!client || !bot) return { ok: false, error: "bot 未连接" };
  return new Promise((resolve) => {
    let done = false, res = { ok: false, error: "背包里没找到要存的物品" };
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { bot.removeListener("windowItems", onWin); } catch (e) {} csKeyPressed(3); resolve(r); };
    const onWin = (window, slots) => {
      const arr = Array.isArray(slots) ? slots : (window && Array.isArray(window.slots) ? window.slots : []);
      const invStart = arr.length - 36; // 玩家背包在窗口末尾 36 格
      let target = null;
      for (let i = Math.max(0, invStart); i < arr.length; i++) {
        const s = arr[i];
        if (s && s.type && s.count > 0 && csItemNameMatch((s.name && s.name !== "unknown" ? s.name : ((bot.registry.items[s.type] || {}).name || "")), itemKw)) { target = { slot: s.slot, item: bot.registry.items[s.item]?.name, count: s.count }; break; }
      }
      if (!target) return finish(res);
      bot.clickWindow(target.slot, 0, 1, window).then(() => finish({ ok: true, action: "cs_deposit", item: target.item, count: target.count }))
        .catch((e) => finish({ ok: false, error: "shift-click 失败:" + e.message }));
    };
    bot.on("windowItems", onWin);
    const timer = setTimeout(() => finish(res), 1500);
    csKeyPressed(2);
  });
}

// 从背包取物品（shift-click 背包存储槽里的物品 → bot 主物品栏）
async function csWithdraw(itemKw) {
  if (!client || !bot) return { ok: false, error: "bot 未连接" };
  return new Promise((resolve) => {
    let done = false, res = { ok: false, error: "背包里没找到要取的物品" };
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { bot.removeListener("windowItems", onWin); } catch (e) {} csKeyPressed(3); resolve(r); };
    const onWin = (window, slots) => {
      const arr = Array.isArray(slots) ? slots : (window && Array.isArray(window.slots) ? window.slots : []);
      const invStart = arr.length - 36;
      let target = null;
      for (let i = 0; i < Math.max(0, invStart); i++) { // 背包存储槽在玩家背包之前
        const s = arr[i];
        if (s && s.type && s.count > 0 && csItemNameMatch((s.name && s.name !== "unknown" ? s.name : ((bot.registry.items[s.type] || {}).name || "")), itemKw)) { target = { slot: s.slot, item: bot.registry.items[s.item]?.name, count: s.count }; break; }
      }
      if (!target) return finish(res);
      bot.clickWindow(target.slot, 0, 1, window).then(() => finish({ ok: true, action: "cs_withdraw", item: target.item, count: target.count }))
        .catch((e) => finish({ ok: false, error: "shift-click 失败:" + e.message }));
    };
    bot.on("windowItems", onWin);
    const timer = setTimeout(() => finish(res), 1500);
    csKeyPressed(2);
  });
}

function csJetUp() { csJetFlying(true, false); return { ok: true, action: "cs_jet_up" }; }
function csJetHover() { csJetFlying(true, true); return { ok: true, action: "cs_jet_hover" }; }
function csJetStop() { csJetFlying(false, false); return { ok: true, action: "cs_jet_stop" }; }
function csJetToggle() { csKeyPressed(7, true); return { ok: true, action: "cs_jet_toggle" }; }
function csHoverToggle() { csKeyPressed(5, true); return { ok: true, action: "cs_hover_toggle" }; }
function csFuelStatus() { return { ok: true, action: "cs_fuel_status", fuelRemaining: CS_LAST_FUEL, syncedAt: CS_FUEL_TIME, active: CS_JET_ACTIVE }; }

// 监控：自动飞起避障 + 喷气赶路
function csStartMonitors() {
  if (CS_MONITOR) return;
  let lastPos = null, lastMoveTime = Date.now();
  CS_MONITOR = setInterval(() => {
    if (!bot || !client || !bot.entity) return;
    try {
      const pos = bot.entity.position; const now = Date.now();
      const hasGoal = !!(bot.pathfinder && bot.pathfinder.goal);
      if (lastPos) { const moved = Math.hypot(pos.x - lastPos.x, pos.z - lastPos.z); if (moved > 0.4) lastMoveTime = now; }
      lastPos = { x: pos.x, y: pos.y, z: pos.z };
      if (CS_AUTO_FLY && hasGoal && (now - lastMoveTime) > 1200) { // 卡住 >1.2s → 飞起 1s 越障
        console.log("[CS] 检测到卡住，飞起避障");
        csJetUp(); setTimeout(() => { if (CS_AUTO_FLY) csJetStop(); }, 1000); lastMoveTime = now;
      }
      if (CS_TRAVEL) { csJetHover(); csJetInput(1, 0); } // 保持悬停 + 前进输入，由 pathfinder 带方向
    } catch (e) {}
  }, 500);
}
function csSetAutoFly(on) { CS_AUTO_FLY = on; if (on) csStartMonitors(); return { ok: true, autoFly: on }; }
function csSetTravel(on) { CS_TRAVEL = on; if (on) { csStartMonitors(); csJetHover(); } else csJetStop(); return { ok: true, travel: on }; }

// ---- 决策桥（HTTP） ----
const bridge = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "GET" && req.url === "/state") {
    const pos = bot?.entity?.position;
    const ents = collectEntities(48); // 实体感知：48 格内聚合（对标 aiplayer entity_groups）
    res.end(JSON.stringify({
      online: !!bot && !!bot.entity,
      username: USER,
      reconnects,
      authed,
      mem_mb: +(process.memoryUsage().rss / 1048576).toFixed(1),
      uptime_s: Math.round((Date.now() - BOT_START) / 1000),
      ping_ms: (bot && bot.players && bot.players[USER] && bot.players[USER].ping != null) ? bot.players[USER].ping : null,
      position: pos ? { x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) } : null,
      yaw: bot?.entity?.yaw?.toFixed(1),
      health: bot?.health,
      food: bot?.food,
      saturation: (typeof (bot?.foodSaturation ?? bot?.foodSaturationLevel) === "number") ? +((bot.foodSaturation ?? bot.foodSaturationLevel) ?? 0).toFixed(1) : null,
      foodMax: 20,
      experience: bot?.experience ? { level: bot.experience.level, points: bot.experience.points, progress: +(bot.experience.progress ?? 0).toFixed(3) } : null,
      gamemode: bot?.game?.gameMode,
      heldItem: bot?.heldItem?.name,
      night: bot?.time ? { timeOfDay: bot.time.timeOfDay, isNight: isNightTime(), sleeping: !!bot.isSleeping } : null,
      entity_groups: ents.groups.length ? ents.groups : null,
      entities: ents.nearest.length ? ents.nearest.map((e) => ({ name: e.name, type: e.type, dist: e.dist })) : null,
      chat: chatBuf.slice(-12),
    }));
    return;
  }
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", async () => {
      let out = { ok: false, error: "bot 未在线" };
      try {
        const a = JSON.parse(body);
        const offlineSafe = a.type === "say"; // say 允许离线：进待发队列，登录后自动补发
        if ((!bot || !bot.entity) && !offlineSafe) { res.end(JSON.stringify(out)); return; }
        switch (a.type) {
          case "rawchat": {
            // 实验（已证伪）：手动发带假签名的 chat_message，验证服务器是否只做"签名非空"检查。
            // 结论：服务器真实验签，离线账号无 Mojang 密钥，假签名必被丢弃，此路不通。
            const msg = String(a.text ?? "").slice(0, 90);
            const fakeSig = crypto.randomBytes(256);
            client.write("chat_message", {
              message: msg,
              timestamp: BigInt(Date.now()),
              salt: 1n,
              signature: fakeSig,
              offset: 0,
              acknowledged: Buffer.alloc(3),
            });
            console.log("[rawchat] 已发带假签名的 chat_message:", msg);
            out = { ok: true, action: "rawchat", text: msg, sigLen: fakeSig.length };
            break;
          }
          case "say": {
            // 普通聊天（chat_message）：实测全服可见，格式 [world] <bot> xxx（用户截图证实）。
            // 注意：bot 自身收不到玩家聊天回显（player_chat 接收问题），聊天流无回显≠发送失败。
            // 离线/未登录时自动入待发队列（落盘），登录成功后补发——根治掉线窗口消息丢失。
            const txt = String(a.text ?? "").slice(0, 90);
            if (!canSay()) {
              pendingSay.push({ text: txt, at: Date.now() });
              savePendingSay();
              console.log("[say-queue] bot 未就绪，消息入队（共 " + pendingSay.length + " 条）:", txt);
              out = { ok: true, action: "say", queued: true, pending: pendingSay.length, text: txt };
              break;
            }
            bot.chat(txt);
            console.log("[say] 已发普通聊天:", txt);   // 排错用：日志里有这行 = 客户端确实发出去了
            out = { ok: true, action: "say", via: "chat", text: txt };
            break;
          }
          case "raw_say": {
            // 实验：真正普通聊天（bot.chat 纯文本，不带 /me）。验证 TrChat 频道权限是否为根因。
            const txt = String(a.text ?? "").slice(0, 90);
            bot.chat(txt);
            console.log("[raw_say] 已发普通聊天:", txt);
            out = { ok: true, action: "raw_say", text: txt };
            break;
          }
          case "cmd": {
            const t = String(a.text ?? "").trim();
            bot.chat(t.startsWith("/") ? t : "/" + t);
            out = { ok: true, action: "cmd", text: t };
            break;
          }
          case "goto":
          case "goto_block": {
            let tx, ty, tz;
            if (a.type === "goto_block") {
              const names = String(a.match ?? "").split(",").map((s) => s.trim()).filter(Boolean);
              const b = findNearestBlock(names, Number(a.maxDist ?? 128));
              if (!b) { out = { ok: false, error: "范围内没找到 " + a.match }; res.end(JSON.stringify(out)); return; }
              tx = b.position.x; ty = b.position.y; tz = b.position.z;
              console.log("[goto_block] 找到 " + b.name + " @ " + tx + "," + ty + "," + tz);
            } else {
              tx = Number(a.x); tz = Number(a.z);
              ty = Number(a.y ?? bot.entity.position.y);
            }
            const range = Number(a.range ?? 2);
            const myBot = bot;
            const start = myBot.entity.position;
            const total = Math.sqrt((tx - start.x) ** 2 + (tz - start.z) ** 2);
            const legTimer = { t: null };
            const myVer = ++gotoVersion; // 版本号：后续 goto/stop 会让本链作废
            let lastPos = null;          // 卡住检测：上一次采样位置
            let lastMoveAt = Date.now(); // 最后一次有效位移时间
            let sideDir = 1;             // 侧移方向（左右交替）
            myBot.once("end", () => { if (legTimer.t) clearTimeout(legTimer.t); });
            function walkLeg() {
              if (myVer !== gotoVersion) return; // 已有更新的 goto/stop，本链作废
              if (bot !== myBot || !myBot.entity) return; // 实例已换代，作废
              const p = myBot.entity.position;
              const dist = Math.sqrt((tx - p.x) ** 2 + (tz - p.z) ** 2);
              if (dist <= Math.max(range, 1.5)) { console.log("[goto] 到达目的地 (" + Math.round(p.x) + "," + Math.round(p.y) + "," + Math.round(p.z) + ")"); announce("[到达] 已到达目标 (" + Math.round(p.x) + "," + Math.round(p.y) + "," + Math.round(p.z) + ")"); return; }
              // 卡住检测：位移 <0.6 格持续 6 秒 → 侧移避障（左右交替）
              if (lastPos) {
                const moved = Math.hypot(p.x - lastPos.x, p.z - lastPos.z);
                if (moved < 0.6) {
                  const stuckMs = Date.now() - lastMoveAt;
                  if (stuckMs > 5000) {
                    const ang = Math.atan2(tz - p.z, tx - p.x); // 朝向目标的方向
                    sideDir = -sideDir;
                    const sideAng = ang + (sideDir > 0 ? Math.PI / 2 : -Math.PI / 2);
                    const sx = p.x + Math.cos(sideAng) * 4;
                    const sz = p.z + Math.sin(sideAng) * 4;
                    console.log("[赶路] 卡住 " + Math.round(stuckMs / 1000) + " 秒无位移，侧移避障 → " + Math.round(sx) + "," + Math.round(sz));
                    myBot.pathfinder.setGoal(new goals.GoalNear(sx, p.y, sz, 1.5));
                    lastMoveAt = Date.now();
                    lastPos = { x: p.x, y: p.y, z: p.z };
                    if (legTimer.t) clearTimeout(legTimer.t);
                    legTimer.t = setTimeout(walkLeg, 4500);
                    return;
                  }
                } else {
                  lastPos = { x: p.x, y: p.y, z: p.z };
                  lastMoveAt = Date.now();
                }
              } else {
                lastPos = { x: p.x, y: p.y, z: p.z };
              }
              let gx = tx, gy = ty, gz = tz;
              const legRange = range;
              if (dist > 60) {
                const ratio = 55 / dist;
                gx = p.x + (tx - p.x) * ratio;
                gz = p.z + (tz - p.z) * ratio;
                gy = p.y;
              }
              myBot.pathfinder.setGoal(new goals.GoalNear(gx, gy, gz, dist > 60 ? 4 : legRange));
              if (dist > 60) announce("[赶路] 赶路中：已到 " + Math.round(p.x) + "," + Math.round(p.z) + "，剩余约 " + Math.round(dist) + " 格");
              legTimer.t = setTimeout(walkLeg, dist > 60 ? 6000 : 8000);
            }
            walkLeg();
            out = { ok: true, action: a.type, target: { x: tx, y: ty, z: tz }, total: Math.round(total) };
            break;
          }
          case "list_blocks": {
            // 探测：查询注册表中名字含关键词的方块
            const kw = String(a.keyword ?? "").toLowerCase();
            const reg = (bot && bot.registry && bot.registry.blocksByName) || mcDataBlocks;
            const all = Object.keys(reg);
            const names = all.filter((k) => !kw || k.includes(kw)).slice(0, 100);
            out = { ok: true, total: all.length, matched: names.length, names };
            break;
          }
          case "probe_block": {
            // 只读：批量查指定坐标上是什么方块。不右键、不触发交互，
            // 用来远程校验 knownWaystones 里的坐标是否还有效（ws_open 对空气右键会导致断线）。
            const Vec3p = bot.entity.position.constructor;
            const pts = Array.isArray(a.points) ? a.points : [{ x: a.x, y: a.y, z: a.z }];
            const res = pts.map((pt) => {
              const b = bot.blockAt(new Vec3p(Number(pt.x), Number(pt.y), Number(pt.z)), false);
              return { x: Number(pt.x), y: Number(pt.y), z: Number(pt.z),
                       name: b ? b.name : null, stateId: b ? b.stateId : null };
            });
            out = { ok: true, action: "probe_block", blocks: res };
            break;
          }
          case "use_entity": {
            // 右键实体（corpse 尸体取物等）。按 type/name 模糊匹配，取最近的
            const kw = String(a.name ?? "corpse");
            const ents = Object.values(bot.entities).filter((e) =>
              ((e.name || "").toLowerCase().includes(kw.toLowerCase()) ||
               (e.username || "").includes(kw)));
            if (!ents.length) { out = { ok: false, error: "附近没有实体: " + kw }; break; }
            ents.sort((p, q) => bot.entity.position.distanceTo(p.position) - bot.entity.position.distanceTo(q.position));
            const e0 = ents[0];
            const d0 = bot.entity.position.distanceTo(e0.position).toFixed(1);
            out = { ok: true, action: "use_entity", target: e0.name || e0.username, dist: d0 };
            (async () => {
              try {
                await bot.lookAt(e0.position.offset(0, (e0.height || 1) / 2, 0), true);
                await new Promise((r) => setTimeout(r, 250));
                await bot.activateEntity(e0);
                console.log("[use_entity] 已右键实体 " + (e0.name || e0.username) + " dist=" + d0);
                await new Promise((r) => setTimeout(r, 900));
                console.log("[use_entity] currentWindow = " + (bot.currentWindow ? bot.currentWindow.type : "null"));
              } catch (err) { console.log("[use_entity] 异常: " + err.message); }
            })();
            break;
          }
          case "map_slice": {
            // 战术视图用：以 bot 为中心取 ±r 格，每列取最顶层非空气方块（名称 + y）
            // 只读，不改变任何状态。payload ≈ 6 万字节，仅供本机控制台使用。
            const r = Math.max(2, Math.min(Number(a.radius ?? 24), 32));
            const base = bot.entity.position;
            const yTop = Math.floor(base.y) + 12, yBot = Math.floor(base.y) - 24;
            const grid = [];
            for (let dz = -r; dz <= r; dz++) {
              const row = [];
              for (let dx = -r; dx <= r; dx++) {
                let hit = null;
                for (let y = yTop; y >= yBot; y--) {
                  const b = bot.blockAt(base.offset(dx, y - base.y, dz), false);
                  if (b && b.name && b.name !== "air" && b.name !== "cave_air" && b.name !== "void_air") {
                    hit = [b.name, y];
                    break;
                  }
                  if (b && !b.name && b.stateId) {
                    // 模组方块（名字映射缺失，如 black_sharestone）：用 stateId 占位，地图可标记
                    hit = ["sid:" + b.stateId, y];
                    break;
                  }
                }
                row.push(hit);
              }
              grid.push(row);
            }
            out = { ok: true, action: "map_slice", r,
                    origin: { x: Math.round(base.x), y: Math.round(base.y), z: Math.round(base.z) },
                    grid };
            break;
          }
          case "scan_area": {
            // 探测：扫描半径内所有方块，按名字/stateId 聚合（看 waystone 等模组方块能否被识别）
            const r = Math.min(Number(a.radius ?? 16), 32);
            const center = bot.entity.position;
            const uniq = {};
            const bySid = {}; // stateId → { count, min, max, samples }
            let count = 0;
            const track = (sid, x, y, z) => {
              if (!bySid[sid]) bySid[sid] = { count: 0, min: { x: 1e9, y: 1e9, z: 1e9 }, max: { x: -1e9, y: -1e9, z: -1e9 }, samples: [] };
              const g = bySid[sid];
              g.count++;
              g.min.x = Math.min(g.min.x, x); g.min.y = Math.min(g.min.y, y); g.min.z = Math.min(g.min.z, z);
              g.max.x = Math.max(g.max.x, x); g.max.y = Math.max(g.max.y, y); g.max.z = Math.max(g.max.z, z);
              if (g.samples.length < 6) g.samples.push([x, y, z]);
            };
            for (let dx = -r; dx <= r; dx++) {
              for (let dz = -r; dz <= r; dz++) {
                for (let dy = -10; dy <= 10; dy++) {
                  try {
                    const b = bot.blockAt(center.offset(dx, dy, dz));
                    if (!b) continue;
                    count++;
                    if (!b.name) {
                      track(b.stateId, Math.round(b.position.x), Math.round(b.position.y), Math.round(b.position.z));
                      continue;
                    }
                    uniq[b.name] = (uniq[b.name] || 0) + 1;
                  } catch (e) {}
                }
              }
            }
            const sorted = Object.entries(uniq).sort((x, y) => y[1] - x[1]);
            out = { ok: true, scanned: count, uniqueCount: sorted.length, unique: sorted.slice(0, 60), unknownByStateId: bySid };
            break;
          }
          case "activate_at": {
            // 走到指定坐标并右键交互（用于验证未知 stateId 方块是否可交互，如石碑）
            const Vec3c = bot.entity.position.constructor;
            const b = bot.blockAt(new Vec3c(Number(a.x), Number(a.y), Number(a.z)));
            if (!b) { out = { ok: false, error: "该位置读不到方块" }; break; }
            console.log("[activate_at] 目标 " + (b.name || "unknown") + " stateId=" + b.stateId + " @" + a.x + "," + a.y + "," + a.z);
            walkAndActivate(b, (ok, err) => {
              if (ok) announce("[交互] 已右键 " + (b.name || "未知方块") + " @" + Math.round(b.position.x) + "," + Math.round(b.position.z));
              else announce("[交互] 失败：" + String(err?.message || "").slice(0, 30));
            });
            out = { ok: true, action: "activate_at", block: b.name || null, stateId: b.stateId, pos: { x: a.x, y: a.y, z: a.z } };
            break;
          }
          case "waystone":
          case "goto_waystone": {
            // 石碑交互：从已同步的传送点列表找最近的（或按名字）→ 走近 → 右键打开
            const w = a.name ? findWaystoneByName(String(a.name)) : nearestWaystone();
            if (!w) { out = { ok: false, error: a.name ? "没有名字含「" + a.name + "」的石碑" : "石碑数据未同步（等待服务器包）" }; break; }
            const wd = Math.round(Math.sqrt((w.x - bot.entity.position.x) ** 2 + (w.z - bot.entity.position.z) ** 2));
            console.log("[waystone] 目标「" + w.name + "」@ " + w.x + "," + w.y + "," + w.z + "（" + wd + " 格）");
            gotoWaystoneAndOpen(w, (ok, err, opened) => {
              if (ok && opened) announce("[石碑] 已打开「" + w.name + "」石碑界面");
              else if (ok) announce("[石碑] 已右键「" + w.name + "」（界面未确认）");
              else announce("[石碑] 交互失败：" + String(err?.message || "").slice(0, 30));
            });
            out = { ok: true, action: "waystone", name: w.name, pos: { x: w.x, y: w.y, z: w.z }, dist: wd };
            break;
          }
          case "ws_blocktypes": {
            // 诊断：运行时注册表里所有含 waystone 的方块名（确认服务器侧石碑方块叫什么）
            const names = [];
            const info = {};
            try {
              const reg = bot.registry || {};
              info.regKeys = Object.keys(reg).slice(0, 24);
              info.hasBlocks = Array.isArray(reg.blocks);
              info.blocksByNameType = typeof reg.blocksByName;
              info.blockTypesByNameType = typeof reg.blockTypesByName;
              if (reg.blocksByName && typeof reg.blocksByName === "object") {
                for (const k of Object.keys(reg.blocksByName)) if (/waystone/i.test(k)) names.push(k);
              }
              if (reg.blockTypesByName && typeof reg.blockTypesByName.forEach === "function") {
                reg.blockTypesByName.forEach((v, k) => { if (/waystone/i.test(String(k)) && !names.includes(k)) names.push(k); });
              }
              if (reg.blocks && Array.isArray(reg.blocks)) {
                for (const b of reg.blocks) if (b && b.name && /waystone/i.test(b.name) && !names.includes(b.name)) names.push(b.name);
              }
            } catch (e) { names.push("ERR:" + e.message); }
            out = { ok: true, count: names.length, blockTypes: names, info };
            break;
          }
          case "move_slot": {
            // 任意槽位互移（从主手/副手/盔甲拖回背包）
            const from = Number(a.from), to = Number(a.to);
            if (!Number.isInteger(from) || !Number.isInteger(to)) {
              out = { ok: false, error: "from/to 必填（数字槽位）" }; break;
            }
            try {
              await bot.moveSlotItem(from, to);
              out = { ok: true, from, to };
            } catch (e) { out = { ok: false, error: "移动失败: " + e.message }; }
            break;
          }
          case "use_item": {
            // 使用手持物品（右键：吃/放/激活）
            try {
              bot.activateItem(a.offhand === true);
              out = { ok: true, hand: a.offhand === true ? "off-hand" : "hand" };
            } catch (e) { out = { ok: false, error: "使用失败: " + e.message }; }
            break;
          }
          case "equip": {
            // 按槽位或名字把背包物品装备到主手（供控制台物品栏交互）
            try {
              const inv = bot.inventory;
              const items = inv ? inv.items() : [];
              let it = null;
              if (a.slot !== undefined && a.slot !== null && a.slot !== "") {
                const s = Number(a.slot);
                it = inv ? inv.slots[s] : null;
                if (!it) it = items.find((i) => i.slot === s);
              } else if (a.name) {
                const n = String(a.name);
                it = items.find((i) => i.name === n)
                  || items.find((i) => (i.displayName || "").includes(n));
              }
              if (!it) { out = { ok: false, error: "背包里没有该物品/槽位" }; break; }
              const DEST_OK = ["hand", "off-hand", "head", "torso", "legs", "feet"];
              const dest = DEST_OK.includes(a.destination) ? a.destination : "hand";
              await bot.equip(it, dest);
              const off = bot.inventory ? bot.inventory.slots[45] : null;
              out = { ok: true, dest,
                      held: bot.heldItem ? bot.heldItem.name : null,
                      count: bot.heldItem ? bot.heldItem.count : 0,
                      offhand: off ? off.name : null,
                      slot: it.slot };
            } catch (e) { out = { ok: false, error: "装备失败: " + e.message }; }
            break;
          }
          case "inv_list": {
            // 背包 + 热栏(9格) + 主手/副手，供控制台物品栏 UI
            const res = { ok: true };
            try {
              const mk = (it) => it ? { name: it.name, displayName: it.displayName || it.name, count: it.count, slot: it.slot } : null;
              res.heldItem = bot.heldItem ? (bot.heldItem.name + " x" + bot.heldItem.count) : null;
              const inv = bot.inventory;
              const items = inv ? inv.items() : [];
              res.itemCount = items.length;
              res.items = items.slice(0, 50).map(mk);
              res.slotsLen = inv ? inv.slots.length : -1;
              // 热栏 36-44（mineflayer 槽位），带空格
              res.hotbar = [];
              for (let s = 36; s <= 44; s++) res.hotbar.push(inv ? mk(inv.slots[s]) : null);
              res.quickBarSlot = (typeof bot.quickBarSlot === "number") ? bot.quickBarSlot : 0;
              res.offhand = inv ? mk(inv.slots[45]) : null;   // 副手
              res.armor = [5, 6, 7, 8].map((s) => inv ? mk(inv.slots[s]) : null);
            } catch (e) { res.err = e.message; }
            out = res;
            break;
          }
          case "list_waystones": {
            const p0 = bot.entity.position;
            const wlist = knownWaystones
              .filter((x) => x.dim === "minecraft:overworld")
              .map((x) => ({ name: x.name, x: x.x, y: x.y, z: x.z, uuid: x.uuid || null, wtype: (x.wtype || "").replace("waystones:", ""), dist: Math.round(Math.sqrt((x.x - p0.x) ** 2 + (x.z - p0.z) ** 2)) }))
              .sort((x, y) => x.dist - y.dist);
            out = { ok: true, total: wlist.length, nearest: wlist.slice(0, Number(a.limit ?? 12)), all: a.all ? wlist : undefined };
            break;
          }
          case "warp_to": {
            // 传送：支持普通传送石碑与共享石碑（共享石碑会先右键打开共享石碑 GUI 再选目标）
            const kw = String(a.name ?? "");
            if (!kw) { out = { ok: false, error: "缺少 name 参数" }; break; }
            const r = await warpToByName(kw);
            out = { ok: r.ok, result: r };
            break;
          }
          case "find_beds": {
            // 查询附近的床（半径内 name 含 "bed" 的方块），返回坐标+距离
            const beds = findBeds(Number(a.radius ?? 32));
            out = { ok: true, count: beds.length, radius: Number(a.radius ?? 32), beds };
            break;
          }
          case "set_spawn": {
            // 走到最近床并右键设置出生点（先查询→走到→activateBlock）
            const r = await setSpawnAtNearestBed(Number(a.radius ?? 32));
            out = { ok: r.ok, result: r };
            break;
          }
          case "equip_warp_stone": {
            // best-effort：把背包里的传送石装备到主手（依赖背包可读性）
            (async () => {
              const it = findWarpStoneItem();
              if (!it) { out = { ok: false, error: "背包里找不到传送石（本服可能读不到背包）", hint: "请确认已把传送石丢给 bot 且已拾取" }; return; }
              try {
                await bot.equip(it, "hand");
                console.log("[warp_stone] 已装备到主手: " + it.name);
                out = { ok: true, name: it.name, count: it.count };
              } catch (e) { out = { ok: false, error: "装备失败: " + e.message }; }
            })();
            out = { ok: true, action: "equip_warp_stone", queued: true };
            break;
          }
          case "use_warp_stone": {
            // 使用主手传送石（共享函数：best-effort 装备 + 右键触发）
            (async () => {
              try {
                const r = await useWarpStoneItem();
                console.log("[warp_stone] 已右键使用主手物品（传送石），装备=" + r.equipped);
                out = { ok: true, action: "use_warp_stone", equipped: r.equipped };
              } catch (e) { console.log("[warp_stone] 使用失败:", e.message); out = { ok: false, error: e.message }; }
            })();
            out = { ok: true, action: "use_warp_stone", queued: true };
            break;
          }
          case "stop":
            gotoVersion++; // 作废所有赶路链
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
            out = { ok: true, action: "stop" };
            break;
          case "work": {
            const m = a.mode;
            if (m === "log" || m === "stone" || m === "patrol") {
              startWork(m, { anchors: a.anchors });
              out = { ok: true, action: "work", mode: m, name: WORK_NAMES[m] };
            } else if (m === "stop") {
              stopWork("决策桥指令");
              out = { ok: true, action: "work", mode: "stop" };
            } else out = { ok: false, error: "mode 须为 log/stone/patrol/stop" };
            break;
          }
          case "follow": {
            const who = bot.players[String(a.player ?? "")];
            const pe = who?.entity?.position;
            if (!pe) { out = { ok: false, error: "找不到该玩家（不在视野）" }; break; }
            myBotGoto(pe.x, pe.y, pe.z, Number(a.range ?? 2));
            out = { ok: true, action: "follow", player: a.player, target: { x: +pe.x.toFixed(0), z: +pe.z.toFixed(0) } };
            break;
          }
          case "ws_send": {
            // 通用发送 waystones 自定义包（channel + hex payload）
            const ch2 = String(a.channel ?? "");
            const hex2 = String(a.hex ?? "").replace(/[^0-9a-fA-F]/g, "");
            if (!ch2.startsWith("waystones:")) { out = { ok: false, error: "channel 需 waystones:*" }; break; }
            try {
              client.write("custom_payload", { channel: ch2, data: Buffer.from(hex2, "hex") });
              console.log("[ws_send] → " + ch2 + " payload=" + (hex2 || "(空)"));
              out = { ok: true, action: "ws_send", channel: ch2, hex: hex2 };
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "bd_send": {
            // 通用自定义包发送：任意 channel + hex payload（用于逆向模组协议）
            const ch3 = String(a.channel ?? "");
            const hex3 = String(a.hex ?? "").replace(/[^0-9a-fA-F]/g, "");
            if (!ch3) { out = { ok: false, error: "缺少 channel" }; break; }
            if (hex3.length % 2 !== 0) { out = { ok: false, error: "hex 长度为奇数" }; break; }
            try {
              client.write("custom_payload", { channel: ch3, data: Buffer.from(hex3, "hex") });
              console.log("[bd_send] → " + ch3 + " payload=" + (hex3 || "(空)") + " (" + hex3.length / 2 + "B)");
              out = { ok: true, action: "bd_send", channel: ch3, bytes: hex3.length / 2 };
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "win_slots": {
            // 诊断：列出当前打开窗口的全部非空槽位（含容器槽与玩家背包槽），用于摸清模组菜单布局
            const w0 = bot.currentWindow;
            if (!w0) { out = { ok: false, error: "当前没有打开的窗口" }; break; }
            const list0 = netCollectSlots(w0, w0.slots);
            out = {
              ok: true, action: "win_slots", windowId: w0.id, type: w0.type, slots: (w0.slots || []).length,
              inventoryStart: w0.inventoryStart, inventoryEnd: w0.inventoryEnd, stateId: w0.stateId,
              selectedItem: w0.selectedItem ? (w0.selectedItem.name || ("#" + w0.selectedItem.type)) : null,
              count: list0.length, items: list0,
            };
            break;
          }
          case "win_click": {
            // 诊断：对当前窗口发一次原始点击 {slot, button, mode}
            // mode: 0=左/右键 1=shift 2=数字键 4=丢弃
            const w1 = bot.currentWindow;
            if (!w1) { out = { ok: false, error: "当前没有打开的窗口" }; break; }
            const slot = Number(a.slot);
            const button = Number(a.button || 0);
            const mode = Number(a.mode || 0);
            try {
              await bot.clickWindow(slot, button, mode);
              out = { ok: true, action: "win_click", slot, button, mode, selectedItem: w1.selectedItem ? (w1.selectedItem.name || ("#" + w1.selectedItem.type)) : null };
              console.log("[win_click] slot=" + slot + " button=" + button + " mode=" + mode);
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "probe_chan": {
            // 诊断：发任意自定义通道，等待后回报是否打开了窗口（判断该通道是否真被服务端处理）
            const chx = String(a.channel || "");
            const hx = String(a.hex || "").replace(/[^0-9a-fA-F]/g, "");
            const wait = Number(a.wait || 1500);
            if (!chx) { out = { ok: false, error: "缺少 channel" }; break; }
            try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (e) { }
            await sleep(300);
            client.write("custom_payload", { channel: chx, data: Buffer.from(hx, "hex") });
            await sleep(wait);
            const w = bot.currentWindow;
            out = {
              ok: true, action: "probe_chan", channel: chx, bytes: hx.length / 2,
              window: w ? { id: w.id, type: w.type, slots: (w.slots || []).length, title: String(w.title || "") } : null,
            };
            console.log("[probe] " + chx + " → " + (w ? ("窗口 id=" + w.id + " slots=" + (w.slots || []).length) : "无窗口"));
            break;
          }
          case "pkt_names": {
            // 诊断：入站包名计数（确认某个包到底有没有到达客户端）
            const cnt = global.__pktCount || {};
            const arr = Object.entries(cnt).map(([k, v]) => ({ name: k, count: v })).sort((x, y) => y.count - x.count);
            out = { ok: true, action: "pkt_names", total: arr.reduce((s2, x) => s2 + x.count, 0), top: arr.slice(0, Number(a.limit || 40)) };
            break;
          }
          case "bd_switcher": {
            // 打开"主网络切换器"（空载荷）——若 bot 已在某网络内，服务端会 openMenu
            try {
              client.write("custom_payload", { channel: "beyonddimensions:open_primary_net_switcher_packet", data: Buffer.alloc(0) });
              console.log("[BD] 发送 open_primary_net_switcher_packet（空）");
              out = { ok: true, action: "bd_switcher" };
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "bd_cycle_primary": {
            // 主网络循环切换：PrimaryNetSwitchAction 用**字符串名**编码 + varint targetNetId
            try {
              const act = String(a.action || "CYCLE_NEXT").toUpperCase();
              const body = Buffer.concat([bdUtf8(act), bdVarInt(Number(a.netId || 0))]);
              client.write("custom_payload", { channel: "beyonddimensions:primary_net_switch_action_packet", data: body });
              console.log("[BD] primary_net_switch_action " + act + " netId=" + Number(a.netId || 0));
              out = { ok: true, action: "bd_cycle_primary", act, bytes: body.length };
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "equip_weapon": {
            // 手动让 bot 换上当前最强的武器（用于验证武器识别）
            const w = pickWeapon();
            if (!w) { out = { ok: false, error: "背包里没有识别到武器", held: bot.heldItem ? bot.heldItem.name : null }; break; }
            try {
              await bot.equip(w, "hand");
              out = { ok: true, action: "equip_weapon", name: w.name, type: w.type, count: w.count };
            } catch (e) { out = { ok: false, error: e.message, name: w.name }; }
            break;
          }
          case "ws_close": {
            // 发送容器关闭包（清理服务器侧"界面开着"状态）
            const ids = a.windowId != null ? [Number(a.windowId)] : [0, 1, 2, 3];
            for (const wid of ids) {
              try { client.write("container_close", { windowId: wid }); console.log("[ws_close] 发送 container_close windowId=" + wid); } catch (e) { console.log("[ws_close] 失败:", e.message); }
            }
            out = { ok: true, action: "ws_close", tried: ids };
            break;
          }
          case "ws_open2": {
            // 对照版：不发 container_close（原 ws_open 会提前关 0..3 号窗口），只做 look+右键一次
            const Vec3v = bot.entity.position.constructor;
            const bx = Number(a.x), by = Number(a.y), bz = Number(a.z);
            const bb = bot.blockAt(new Vec3v(bx, by, bz), false);
            if (!bb) { out = { ok: false, error: "读不到该位置方块" }; break; }
            out = { ok: true, action: "ws_open2", blockName: bb.name, stateId: bb.stateId,
                    currentWindow: bot.currentWindow ? bot.currentWindow.type : null };
            (async () => {
              try {
                await bot.lookAt(new Vec3v(bx + 0.5, by + 0.5, bz + 0.5), true);
                await new Promise((r) => setTimeout(r, 250));
                await bot.activateBlock(bb);
                console.log("[ws_open2] 右键完成");
                await new Promise((r) => setTimeout(r, 800));
                console.log("[ws_open2] 右键后 currentWindow = " +
                  (bot.currentWindow ? (bot.currentWindow.type + "(" + bot.currentWindow.slots.length + "槽)") : "null"));
              } catch (e) { console.log("[ws_open2] 异常: " + e.message); }
            })();
            break;
          }
          case "ws_open": {
            // 快速版：关闭界面 → lookAt（不等待）→ 400ms 右键 → 1.4s 再右键（全程 fire-and-forget，抗掉线）
            const Vec3o = bot.entity.position.constructor;
            const bo = bot.blockAt(new Vec3o(Number(a.x), Number(a.y), Number(a.z)));
            if (!bo) { out = { ok: false, error: "该位置读不到方块" }; break; }
            for (const wid of [0, 1, 2, 3]) { try { client.write("container_close", { windowId: wid }); } catch (e) {} }
            try { bot.lookAt(new Vec3o(bo.position.x + 0.5, bo.position.y + 0.5, bo.position.z + 0.5)).catch(() => {}); } catch (e) {}
            setTimeout(() => { try { bot.activateBlock(bo).catch(() => {}); console.log("[ws_open] 右键#1 @" + bo.position.x + "," + bo.position.y + "," + bo.position.z); } catch (e) {} }, 400);
            setTimeout(() => { try { bot.activateBlock(bo).catch(() => {}); console.log("[ws_open] 右键#2"); } catch (e) {} }, 1400);
            out = { ok: true, action: "ws_open", stateId: bo.stateId, fast: true };
            break;
          }
          case "ws_select": {
            // Waystones 传送：发送 select_waystone 包（payload = 16B UUID）。前置：先右键打开石碑界面。
            let uuid = String(a.uuid ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
            let wname = null;
            if (!uuid && a.name) {
              const hit = knownWaystones.find((w) => w.uuid && w.name && w.name.includes(String(a.name)));
              if (hit) { uuid = hit.uuid; wname = hit.name; }
            }
            if (!uuid || uuid.length !== 32) { out = { ok: false, error: "需 32 位 hex UUID，或提供含 UUID 的 name" }; break; }
            try {
              client.write("custom_payload", { channel: "waystones:select_waystone", data: Buffer.from(uuid, "hex") });
              console.log("[ws_select] 已发送 select_waystone uuid=" + uuid + (wname ? "（" + wname + "）" : ""));
              out = { ok: true, action: "ws_select", uuid, name: wname };
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "test_waystone":
            // 完整石碑测试：列出 → 走过去打开界面 → 选远处目标传送 → 验证位移（带分步报告）
            out = await test_waystone();
            break;
          case "use_xp": {
            // 右键使用背包里的经验物品（异步执行，返回 started）
            useXpItems(Number(a.max ?? 64)).then((n) => {
              console.log("[use_xp] 完成：使用 " + n + " 个，level=" + (bot?.experience?.level ?? "?"));
            });
            out = { ok: true, action: "use_xp", started: true, hasItem: !!findXpItem(), level: bot?.experience?.level ?? null };
            break;
          }
          case "list_items": {
            // 查询物品注册表（找"经验颗粒"真实 ID）
            const kw2 = String(a.keyword ?? "").toLowerCase();
            const regI = (bot && bot.registry && bot.registry.itemsByName) || {};
            const allI = Object.keys(regI);
            const hitI = allI.filter((n) => !kw2 || n.toLowerCase().includes(kw2));
            out = { ok: true, keyword: kw2, total: allI.length, items: hitI.slice(0, 80) };
            break;
          }
          case "use_item": {
            // 按 slot/type 右键使用指定物品（用于测试模组未知物品，如经验颗粒）
            const slotI = a.slot != null ? Number(a.slot) : null;
            const typeI = a.itemType != null ? Number(a.itemType) : null;
            const itemsI = bot.inventory.items();
            const itI = slotI != null ? itemsI.find((x) => x.slot === slotI) : itemsI.find((x) => x.type === typeI);
            if (!itI) { out = { ok: false, error: "找不到该物品" }; break; }
            (async () => {
              try {
                await bot.equip(itI, "hand");
                await bot.activateItem();
                try { bot.deactivateItem(); } catch (e) {}
                console.log("[use_item] 已右键 " + itI.name + " type=" + itI.type + " slot=" + itI.slot + " count=" + itI.count);
                await new Promise((r) => setTimeout(r, 1500));
                const left = bot.inventory.items().find((x) => x.slot === itI.slot);
                console.log("[use_item] 使用后 level=" + (bot?.experience?.level ?? "?") + " 剩余=" + (left?.count ?? 0));
              } catch (e) { console.log("[use_item] 失败:", e.message); }
            })();
            out = { ok: true, action: "use_item", name: itI.name, type: itI.type, slot: itI.slot, count: itI.count };
            break;
          }
          case "curios_wear": {
            // 把背包里名字含 <item> 关键字的物品 shift-click 进 Curios 饰品栏。
            // 与 curios_equip 的区别：不依赖原始包头，改为轮询 bot.currentWindow 并按物品名定位槽位
            // （服务器 TPS 低时窗口可能 1 秒后才到，curios_equip 的固定等待会误判为"未打开"）。
            const kw = String(a.item || a.text || "backpack").toLowerCase();
            try {
              try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (e) { }
              await sleep(400);
              client.write("custom_payload", { channel: "curios:open_curios", data: Buffer.from([0]) });
              let w = null;
              for (let i = 0; i < 25 && !w; i++) { await sleep(200); w = bot.currentWindow; }
              if (!w) { out = { ok: false, error: "Curios 窗口未打开（25×200ms 超时）" }; break; }
              // 等 window_items 把槽位填进来
              for (let i = 0; i < 12; i++) {
                await sleep(150);
                if ((w.slots || []).some((s) => s && s.type)) break;
              }
              const arr = w.slots || [];
              const idx = arr.findIndex((s) => s && s.type && String(s.name || "").toLowerCase().includes(kw));
              if (idx < 0) {
                out = { ok: false, error: "窗口里没找到含「" + kw + "」的物品", slots: arr.length, windowId: w.id };
                break;
              }
              const item = arr[idx];
              let clickErr = null;
              try { await bot.clickWindow(idx, 0, 1); } catch (e) { clickErr = e.message; }
              out = { ok: !clickErr, action: "curios_wear", windowId: w.id, slots: arr.length, menuSlot: idx, item: item.name, error: clickErr || undefined };
              console.log("[curios_wear] " + item.name + " @menuSlot " + idx + " / " + arr.length + " 格 " + (clickErr ? "失败:" + clickErr : "shift-click 已发"));
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "curios_equip": {
            // 把玩家背包里的物品 shift-click 进 Curios 饰品栏。
            // 不依赖 mineflayer 的背包模型：只发 curios:open_curios，
            // 再用原始 window_items 包头里的 windowId/stateId/格数构造 window_click。
            try {
              client.write("custom_payload", { channel: "curios:open_curios", data: Buffer.from([0]) });
              await new Promise((r) => setTimeout(r, 1000));
              const w = global.__lastWinItems;
              if (!w || Date.now() - w.at > 8000) {
                out = { ok: false, error: "未捕捉到 curios 窗口数据（window_items 未到达）", last: w || null };
                break;
              }
              // 玩家背包在容器窗口的最后 36 格：主背包(27) + 快捷栏(9)
              const baseSlot = Number(a.slot != null ? a.slot : 36); // 玩家背包菜单槽（36-44=快捷栏）
              // winSlot：直接指定该窗口内观测到的槽位（模组菜单布局不一定是"容器在前"，以实测为准）
              const clickSlot = a.winSlot != null
                ? Number(a.winSlot)
                : (Math.max(0, w.count - 9) + (baseSlot - 36));
              client.write("window_click", {
                windowId: w.windowId,
                stateId: w.stateId,
                slot: clickSlot,
                mouseButton: 0,
                mode: 1, // shift-click
                changedSlots: [],
                cursorItem: { itemCount: 0, components: [], removeComponents: [] }
              });
              console.log("[curios_equip] window=" + w.windowId + " slots=" + w.count + " stateId=" + w.stateId + " shift-click slot=" + clickSlot);
              out = { ok: true, action: "curios_equip", windowId: w.windowId, stateId: w.stateId, slots: w.count, clickSlot, baseSlot };
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "drop_slot": {
            // 丢弃指定菜单槽位的物品。快捷栏(36-44)走"切主手 + block_dig(DROP_ALL)"，不需要 stateId，
            // 在背包解析失败（无 window_items → stateId 不可信）时也能用；其余槽位退回 window_click(mode=4)。
            try {
              const s = Number(a.slot);
              if (!Number.isInteger(s) || s < 0 || s > 45) { out = { ok: false, error: "slot 需 0-45" }; break; }
              if (s >= 36 && s <= 44) {
                const hb = s - 36;
                bot.setQuickBarSlot(hb);
                await new Promise((r) => setTimeout(r, 250));
                client.write("block_dig", { status: 3, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: 0 });
                console.log("[drop_slot] 快捷栏 " + hb + "（菜单槽 " + s + "）→ block_dig status=3 已发送");
                out = { ok: true, action: "drop_slot", slot: s, via: "hotbar+block_dig", hotbar: hb };
              } else {
                bot.clickWindow(s, 0, 4);
                console.log("[drop_slot] 菜单槽 " + s + " → window_click mode=4 已发送");
                out = { ok: true, action: "drop_slot", slot: s, via: "window_click" };
              }
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "hotbar": {
            // 切换快捷栏槽位（0-8）。用于绕过 mineflayer 破损的背包同步：
            // 背包解析失败时 bot.heldItem 为空，但服务端知道主手是什么，切换后 use_held 即可生效。
            try {
              const n = Number(a.slot);
              if (!(n >= 0 && n <= 8)) { out = { ok: false, error: "slot 需 0-8" }; break; }
              bot.setQuickBarSlot(n);
              await new Promise((r) => setTimeout(r, 200));
              out = { ok: true, action: "hotbar", slot: n, heldItem: bot.heldItem ? bot.heldItem.name : null, heldType: bot.heldItem ? bot.heldItem.type : null };
              console.log("[hotbar] 切到快捷栏 " + n + " held=" + (bot.heldItem ? bot.heldItem.name : "null"));
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "warp_stone": {
            // 使用传送石：长按右键直到服务端下发 advanced_open_screen（打开选择菜单）再松手。
            // 事件驱动，不用猜时长——warpStoneUseTime=32 tick，但服务器 TPS 低时实际要 8~12 秒。
            // 可选参数：timeout(ms, 默认 25000)、hand(0/1)、then(name/uuid 直接选目标)
            try {
              const timeout = Math.max(2000, Number(a.timeout != null ? a.timeout : 25000));
              const hand = Number(a.hand) === 1;
              const before = global.__lastOpenScreenAt || 0;
              const t0 = Date.now();
              bot.activateItem(hand);
              let opened = false;
              while (Date.now() - t0 < timeout) {
                await new Promise((r) => setTimeout(r, 200));
                if ((global.__lastOpenScreenAt || 0) > before) { opened = true; break; }
              }
              try { bot.deactivateItem(); } catch (_) {}
              const waited = Date.now() - t0;
              console.log("[warp_stone] " + (opened ? "界面已开" : "超时未开界面") + "，按住 " + waited + "ms 后释放");
              // 可选：界面开后直接选目标（then=名字片段 或 uuid=32位hex）
              let selected = null;
              if (opened && (a.then || a.uuid)) {
                let uuid = String(a.uuid || "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
                if (!uuid && a.then) {
                  const hit = knownWaystones.find((w) => w.uuid && w.name && w.name.includes(String(a.then)));
                  if (hit) { uuid = hit.uuid; selected = hit.name; }
                }
                if (uuid.length === 32) {
                  await new Promise((r) => setTimeout(r, 600));
                  client.write("custom_payload", { channel: "waystones:select_waystone", data: Buffer.from(uuid, "hex") });
                  selected = selected || uuid;
                  console.log("[warp_stone] 已选目标 " + selected);
                }
              }
              out = { ok: opened, action: "warp_stone", opened, waited, timeout, selected };
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "use_hold": {
            // 长按右键蓄力（传送石等需要 hold 的物品）。ms 为按住时长，默认 1500ms。
            try {
              const ms = Math.max(100, Number(a.ms != null ? a.ms : 1500));
              const off = a.offHand === true;
              bot.activateItem(off);
              await new Promise((r) => setTimeout(r, ms));
              try { bot.deactivateItem(); } catch (_) {}
              console.log("[use_hold] 按住右键 " + ms + "ms 后释放 offHand=" + off);
              out = { ok: true, action: "use_hold", ms, offHand: off };
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "use_held": {
            // ★ 直接右键使用主手物品（绕过 mineflayer 破损的背包同步）：
            // 服务端根据自己权威的背包（头盔确在主手）自动把护甲穿到对应槽位。
            // offHand=true 时用副手。
            (async () => {
              try {
                const off = a.offHand === true;
                await bot.activateItem(off);
                await new Promise((r) => setTimeout(r, 150));
                try { bot.deactivateItem(); } catch (e) {}
                console.log("[use_held] 已发送主手 use_item（右键）offHand=" + off);
                out = { ok: true, action: "use_held", sent: true, offHand: off };
              } catch (e) { console.log("[use_held] 失败:", e.message); out = { ok: false, error: e.message }; }
            })();
            out = { ok: true, action: "use_held", queued: true };
            break;
          }
          case "equip_armor": {
            // 智能穿戴：按物品名自动识别护甲槽位（helmet/chestplate/leggings/boots）
            // 也可显式传 slotTarget；武器走 hand
            (async () => {
              try {
                const target = String(a.slotTarget || "").toLowerCase();
                const name = String(a.name || "").toLowerCase();
                let dest = target;
                if (!dest) {
                  if (name.includes("helmet")) dest = "head";
                  else if (name.includes("chestplate")) dest = "torso";
                  else if (name.includes("leggings")) dest = "legs";
                  else if (name.includes("boots")) dest = "feet";
                  else dest = "hand";
                }
                const its = bot.inventory.slots.filter((s) => s && s.name);
                // 支持按 name / slot / type 定位物品（含护甲槽/副手等原始槽位，items() 会漏掉）
                const it = a.slot != null ? its.find((x) => x.slot === Number(a.slot))
                         : a.itemType != null ? its.find((x) => x.type === Number(a.itemType))
                         : name ? its.find((x) => String(x.name).toLowerCase() === name)
                         : null;
                if (!it) { console.log("[equip_armor] 找不到物品 name=" + (a.name || "?") + " slot=" + (a.slot ?? "?")); return; }
                await bot.equip(it, dest);
                await new Promise((r) => setTimeout(r, 600));
                console.log("[equip_armor] 已装备 " + it.name + " (type=" + it.type + ") → " + dest + " 槽位");
                announce("[装备] 穿上「" + it.displayName + "」到 " + dest);
                out = { ok: true, action: "equip_armor", name: it.name, type: it.type, slot: it.slot, dest };
              } catch (e) { console.log("[equip_armor] 失败:", e.message); out = { ok: false, error: e.message }; }
            })();
            out = { ok: true, action: "equip_armor", queued: true };
            break;
          }
          case "probe_equip": {
            // ★ 实测多种穿戴写法，读回槽位确认，不再假成功
            // mineflayer 官方注释：window0 slots 5-8 = armor head→feet
            (async () => {
              const its = bot.inventory.items();
              if (!its.length) { console.log("[probe] 背包为空，无法测"); return; }
              const it = its[0];
              const S = bot.inventory.slots;
              const snap = () => [S[5]?.name ?? null, S[6]?.name ?? null, S[7]?.name ?? null, S[8]?.name ?? null].join("|");
              console.log("[probe] 物品 " + it.name + " type=" + it.type + " invSlot=" + it.slot);
              console.log("[probe] 初始 5-8: " + snap());

              const trials = [];
              // 试1：bot.equip 字符串
              trials.push({ label: 'equip(it,"head")', fn: async () => { await bot.equip(it, "head"); } });
              // 试2：bot.equip 数字
              trials.push({ trials: 0, label: 'equip(it,5)', fn: async () => { await bot.equip(it, 5); } });

              for (const t of trials) {
                let err = null;
                try { await t.fn(); } catch (e) { err = e.message; }
                await new Promise(r => setTimeout(r, 1500));
                const s = snap();
                const moved = !bot.inventory.items().find(x => x.type === it.type) || s !== "null|null|null|null";
                console.log("[probe] " + t.label + " → moved=" + moved + " | 5-8: " + s + (err ? " | err=" + err : ""));
                if (moved) { console.log("[probe] ★ 成功写法：" + t.label); break; }
              }

              // 试3：原生 click_window（直接操作协议，不依赖 equip 抽象）
              if (bot.inventory.items().find(x => x.type === it.type)) {
                console.log("[probe] 上面都没成功，改用原生 click_window");
                try {
                  // shift-click 背包物品 → 自动进护甲槽
                  await bot.clickWindow(it.slot, 0, 1);
                  await new Promise(r => setTimeout(r, 1500));
                  console.log("[probe] clickWindow(shift) → 5-8: " + snap());
                } catch (e) { console.log("[probe] clickWindow 失败: " + e.message); }
              }
              console.log("[probe] === 最终 5-8: " + snap() + " ===");
              out = { ok: true, action: "probe_equip", armorSlots: snap().split("|") };
            })();
            out = { ok: true, action: "probe_equip", queued: true };
            break;
          }
          case "equip_slot": {
            // ★ 对指定槽位做 shift-click（服务器自动分配护甲槽）
            (async () => {
              const list = Array.isArray(a.slots) ? a.slots : (a.slot != null ? [a.slot] : [36, 37, 38, 39, 40, 41, 42, 43]);
              const log = [];
              for (const s of list) {
                const before = bot.inventory.slots[s];
                if (!before) { log.push({ slot: s, skipped: "空槽或不可见" }); continue; }
                try {
                  await bot.clickWindow(s, 0, 1);   // shift+click
                  await new Promise(r => setTimeout(r, 900));
                  const after = bot.inventory.slots[s];
                  log.push({ slot: s, item: before.name + "(t" + before.type + ")", ok: true,
                              stillThere: !!after });
                  console.log("[equip_slot] slot" + s + " " + before.name + " → shift-click 完成，剩余=" + (after ? after.count : 0));
                } catch (e) {
                  log.push({ slot: s, item: before.name, err: e.message });
                  console.log("[equip_slot] slot" + s + " 失败: " + e.message);
                }
              }
              out = { ok: true, action: "equip_slot", log };
            })();
            out = { ok: true, action: "equip_slot", queued: true };
            break;
          }
          case "armor_status": {
            try {
              const slots = bot.inventory.slots;
              const dump = {};
              for (let i = 0; i <= 46; i++) { const it = slots[i]; if (it) dump[i] = it.name + "(t" + it.type + ")"; }
              // ★ 关键：护甲不一定在 inventory.slots 里，要读 entity.equipment（entity_equipment 包）
              // head/torso/legs/feet 是实体视角的装备槽，服务端广播什么就是什么
              let equip = null;
              try {
                const eq = bot.entity && bot.entity.equipment;
                if (eq) {
                  equip = {};
                  ["head", "torso", "legs", "feet"].forEach((k) => {
                    const it = eq[k];
                    equip[k] = it ? { name: it.name, type: it.type, count: it.count, displayName: it.displayName || it.name, durability: itemDurability(it) } : null;
                  });
                  equip.available = true;
                } else equip = { available: false, note: "entity.equipment 未定义" };
              } catch (e) { equip = { available: false, err: e.message }; }
              out = { ok: true, action: "armor_status", allSlots: dump,
                      equipment: equip,
                      durability: gearDurabilityReport(),
                      slotCount: Object.keys(slots).length,
                      hand: bot.heldItem ? { name: bot.heldItem.name, type: bot.heldItem.type, displayName: (bot.heldItem.displayName || bot.heldItem.name), durability: itemDurability(bot.heldItem) } : null,
                      health: bot.health, food: bot.food };
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          case "armor_grab": {
            // ★ 不依赖 bot.equip：直接 shift-click 背包物品让服务器自动进护甲槽
            (async () => {
              const its = bot.inventory.slots.filter((s) => s && s.name);
              if (!its.length) { out = { ok: false, error: "背包为空" }; return; }
              const results = [];
              for (const it of its) {
                const nm = it.name || "";
                // 只处理护甲类
                if (!/helmet|chestplate|leggings|boots/.test(nm)) { results.push({ name: nm, skipped: "非护甲" }); continue; }
                try {
                  // shift+click（mode 1）= 快速移动，护甲会自动进对应槽
                  await bot.clickWindow(it.slot, 0, 1);
                  await new Promise(r => setTimeout(r, 900));
                  const S = bot.inventory.slots;
                  results.push({ name: nm, ok: true, slots: [S[5]?.name, S[6]?.name, S[7]?.name, S[8]?.name] });
                } catch (e) { results.push({ name: nm, ok: false, err: e.message }); }
              }
              const S = bot.inventory.slots;
              console.log("[armor_grab] " + JSON.stringify(results));
              console.log("[armor_grab] 最终 5-8 = " + [S[5]?.name, S[6]?.name, S[7]?.name, S[8]?.name].join(" | "));
              out = { ok: true, action: "armor_grab", results,
                      final: [S[5]?.name ?? null, S[6]?.name ?? null, S[7]?.name ?? null, S[8]?.name ?? null] };
            })();
            out = { ok: true, action: "armor_grab", queued: true };
            break;
          }
          case "armor_grab_unknown": {
            // ★ 针对 name=unknown 的模组护甲：shift-click 全部，逐个验证
            (async () => {
              const log = [];
              for (let round = 0; round < 6; round++) {
                const its = bot.inventory.items();
                if (!its.length) { log.push({ round, note: "背包已空" }); break; }
                const it = its[0];
                const before = [5, 6, 7, 8].map(i => bot.inventory.slots[i]?.name ?? null);
                try {
                  await bot.clickWindow(it.slot, 0, 1);
                  await new Promise(r => setTimeout(r, 1000));
                  const after = [5, 6, 7, 8].map(i => bot.inventory.slots[i]?.name ?? null);
                  const changed = JSON.stringify(before) !== JSON.stringify(after);
                  log.push({ round, item: it.name + "(" + it.type + ")", invSlot: it.slot, changed, after });
                  console.log("[grabU] 轮" + round + " " + it.name + "(" + it.type + ") invSlot=" + it.slot + " changed=" + changed + " 5-8=" + after.join("|"));
                } catch (e) {
                  log.push({ round, item: it.name, err: e.message });
                  console.log("[grabU] 轮" + round + " 失败: " + e.message);
                  break;
                }
              }
              const S = bot.inventory.slots;
              out = { ok: true, action: "armor_grab_unknown", log,
                      final: [S[5]?.name ?? null, S[6]?.name ?? null, S[7]?.name ?? null, S[8]?.name ?? null] };
            })();
            out = { ok: true, action: "armor_grab_unknown", queued: true };
            break;
          }
          case "registry_dump": {
            // 反查注册表状态：模组物品（名字含 modid:）+ 仍未知的 id + 已同步的注册表清单
            const items = (bot.registry && bot.registry.items) || {};
            const modItems = [];
            const unknownIds = [];
            for (const k of Object.keys(items)) {
              const it = items[k];
              const nm = (it && it.name) || "?";
              const id = Number(k);
              if (nm === "unknown") unknownIds.push(id);
              else if (String(nm).includes(":")) modItems.push({ id, name: nm }); // 规范化后原版名不带冒号
            }
            const registries = {};
            for (const rid in (global.__regMaps || {})) {
              const m = global.__regMaps[rid] || [];
              registries[rid] = m.filter(Boolean).length;
            }
            out = {
              ok: true, action: "registry_dump",
              modItemsCount: modItems.length,
              modItems: a.all ? modItems : modItems.slice(0, Number(a.limit ?? 40)),
              unknownIds,
              registries,
              savedAt: global.__regSaveT ? "已排程落盘" : null
            };
            break;
          }
          case "inv_detail": {
            // 背包物品详细信息（name/displayName/customName/type/nbt），用于识别 unknown 模组物品
            const its = bot.inventory.items().map((it) => ({
              slot: it.slot,
              name: it.name,
              displayName: it.displayName,
              customName: it.customName,
              type: it.type,
              count: it.count,
              nbtKeys: it.nbt ? Object.keys(it.nbt) : null,
              nbtName: it.nbt && it.nbt.value && it.nbt.value.display ? JSON.stringify(it.nbt.value.display).slice(0, 200) : null,
            }));
            out = { ok: true, count: its.length, items: its };
            break;
          }
          case "xpguard": {
            // 经验守护开关：{enabled:true/false} 启用/关闭；不带参数返回当前状态
            if (typeof a.enabled === "boolean") {
              xpGuardEnabled = a.enabled;
              if (!xpGuardEnabled) xpGuardMoving = false; // 关闭时清掉赶路状态
              console.log("[xpguard] 开关 → " + (xpGuardEnabled ? "开启" : "关闭"));
            }
            out = {
              ok: true,
              action: "xpguard",
              enabled: xpGuardEnabled,
              lowLevel: XP_LOW_LEVEL,
              spot: XP_SPOT,
              level: bot?.experience?.level ?? null,
              moving: xpGuardMoving,
            };
            break;
          }
          case "greet": {
            // 手动触发一次随机问候（在线且有其他玩家时生效；会话窗口 10 分钟）
            tryRandomGreet();
            out = { ok: true, action: "greet", active: [...greetActive.keys()] };
            break;
          }
          case "players": {
            // 在线玩家列表（服务器 Tab 列表：bot.players 含全部在线玩家）
            const list = Object.values(bot.players).map((p) => ({
              name: p.username,
              ping: p.ping ?? null,
              inRange: !!p.entity, // 是否在视野加载范围内
              pos: p.entity ? { x: Math.round(p.entity.position.x), y: Math.round(p.entity.position.y), z: Math.round(p.entity.position.z) } : null,
            }));
            list.sort((a, b) => (b.inRange ? 1 : 0) - (a.inRange ? 1 : 0));
            out = { ok: true, count: list.length, players: list };
            break;
          }
          case "inv": {
            const items = {};
            for (const it of bot.inventory.items()) {
              if (!it) continue;
              items[it.name] = (items[it.name] || 0) + it.count;
            }
            out = { ok: true, inventory: items, food: bot.food, health: bot.health };
            break;
          }
          case "eat": {
            const foods = bot.inventory.items().filter((it) => it && it.name && FOOD_NAMES.some((n) => it.name.includes(n)));
            if (!foods.length) { out = { ok: false, error: "背包里没有可吃的食物" }; break; }
            const f = foods[0];
            bot.equip(f, "hand").then(() => bot.consume()).then(() => {
              console.log("[eat] 吃了 " + f.name);
            }).catch((e) => console.log("[eat] 失败:", e.message));
            out = { ok: true, action: "eat", food: f.name };
            break;
          }
          case "dig": {
            // 挖脚下/指定方向 1 格内的第一个实体方块
            const base = bot.entity.position.offset(0, -1, 0);
            const targets = [bot.blockAt(base), bot.blockAt(bot.entity.position.offset(0, 0, 1)), bot.blockAt(bot.entity.position.offset(1, 0, 0))].filter((b) => b && b.boundingBox !== "empty");
            if (!targets.length) { out = { ok: false, error: "无可挖方块" }; break; }
            bot.dig(targets[0], true).then(() => { console.log("[dig] 完成 " + targets[0].name); }).catch((e) => console.log("[dig] 失败:", e.message));
            out = { ok: true, action: "dig", block: targets[0].name };
            break;
          }
          // ===== 超越维度 (Beyond Dimensions) 热键 / 存储 集成 =====
          case "bd_open_network": out = bdOpenNetwork(false, a.fmt); break;
          case "bd_open_craft_network": out = bdOpenNetwork(true, a.fmt); break;
          case "bd_toggle_magnet": out = bdToggleMagnet(a.which); break;
          case "bd_open_switcher": out = bdOpenSwitcher(); break;
          case "bd_deposit": {
            const item = a.item || bdExtractItemName(a.text || "");
            if (!item) { out = { ok: false, error: "缺少 item（如 {\"type\":\"bd_deposit\",\"item\":\"diamond\"}）" }; break; }
            out = await bdDeposit(item);
            break;
          }
          case "bd_withdraw": {
            const item = a.item || bdExtractItemName(a.text || "");
            if (!item) { out = { ok: false, error: "缺少 item（如 {\"type\":\"bd_withdraw\",\"item\":\"diamond\"}）" }; break; }
            out = await bdWithdraw(item, a.count);
            break;
          }
          case "net_give": {
            // 从维度网络取物并丢给指定玩家：{"type":"net_give","item":"diamond","count":8,"to":"玩家名"}
            const item = a.item || bdExtractItemName(a.text || "");
            if (!item) { out = { ok: false, error: "缺少 item" }; break; }
            const to = a.to || a.player || a.target;
            if (!to) { out = { ok: false, error: "缺少 to（玩家名）" }; break; }
            out = await netGiveToPlayer(item, a.count || 1, to);
            break;
          }
          case "chat_cmd": {
            // 从外部模拟一条游戏内指令（测试用）：{"type":"chat_cmd","text":"net","player":"名字"}
            if (!a.text) { out = { ok: false, error: "缺少 text" }; break; }
            await handleChatCommand(CHAT_CMD_PREFIX + String(a.text), a.player || "控制台");
            out = { ok: true, action: "chat_cmd" };
            break;
          }
          case "bd_read_net": out = await bdReadNet(); break;
          case "bd_net_dump": {
            // 把缓存的网络存储同步包落盘 + 回报解析进度，便于离线分析
            if (!global.__bdNetSync) { out = { ok: false, error: "还没有缓存到同步包，先执行 bd_read_net" }; break; }
            try {
              const buf = global.__bdNetSync;
              fs.mkdirSync(path.join(HERE, "payload-dump"), { recursive: true });
              fs.writeFileSync(path.join(HERE, "payload-dump", "bd-net-sync.hex"), buf.toString("hex"));
              const d = decodeBdNetSync(buf);
              out = { ok: true, action: "bd_net_dump", bytes: buf.length, file: "payload-dump/bd-net-sync.hex", parsedKeys: d.keys.length, total: d.total, complete: d.complete, parseError: d.error, offset: d.offset, firstKeys: d.keys.slice(0, 10), firstCounts: d.counts.slice(0, 10) };
              console.log("[BD] 同步包落盘 " + buf.length + "B，解析 " + d.keys.length + "/" + d.total + " 条" + (d.error ? "（" + d.error + "）" : ""));
            } catch (e) { out = { ok: false, error: e.message }; }
            break;
          }
          // ===== 超越维度：连接符绑定 / 喂食护符 / 自动喂食 =====
          case "bd_bind_network": out = await bdBindNetwork(a.slot ?? a.type); break;
          case "bd_equip_feeder": out = await bdEquipFeeder(a.slot ?? a.type); break;
          case "bd_feed_now": out = await bdFeedNow(); break;
          case "bd_set_feeder_whitelist": {
            if (Array.isArray(a.list)) { BD_FEED_WHITELIST = a.list.map((s) => String(s).trim().toLowerCase()); out = { ok: true, action: "bd_set_feeder_whitelist", count: BD_FEED_WHITELIST.length, list: BD_FEED_WHITELIST }; }
            else out = { ok: false, error: "缺少 list 数组（如 {\"type\":\"bd_set_feeder_whitelist\",\"list\":[\"cooked_beef\",\"bread\"]}）" };
            break;
          }
          case "bd_auto_feed": {
            if (a.enabled === true) out = bdStartFoodMonitor();
            else if (a.enabled === false) out = bdStopFoodMonitor();
            else out = { ok: true, action: "bd_auto_feed", enabled: BD_AUTO_FEED, threshold: BD_FEED_THRESHOLD, whitelist: BD_FEED_WHITELIST };
            break;
          }
          case "bd_feed_status": out = { ok: true, action: "bd_feed_status", food: bot ? bot.food : null, saturation: bot ? bot.foodSaturation : null, autoFeed: BD_AUTO_FEED, whitelist: BD_FEED_WHITELIST }; break;

          // ===== Create: Storage 背包 + 喷气背包 =====
          case "cs_equip_backpack": out = await csEquipBackpack(); break;
          case "cs_read_backpack": out = await csReadBackpack(); break;
          case "cs_deposit": out = await csDeposit(a.item || ""); break;
          case "cs_withdraw": out = await csWithdraw(a.item || ""); break;
          case "cs_jet_up": out = csJetUp(); break;
          case "cs_jet_hover": out = csJetHover(); break;
          case "cs_jet_stop": out = csJetStop(); break;
          case "cs_jet_toggle": out = csJetToggle(); break;
          case "cs_hover_toggle": out = csHoverToggle(); break;
          case "cs_fuel_status": out = csFuelStatus(); break;
          case "cs_auto_fly": out = csSetAutoFly(!!a.on); break;
          case "cs_travel": out = csSetTravel(!!a.on); break;
          default:
            out = { ok: false, error: "未知动作 " + a.type };
        }
      } catch (e) { out = { ok: false, error: e.message }; }
      res.end(JSON.stringify(out));
    });
    return;
  }
  res.statusCode = 404;
  res.end('{"error":"use GET /state or POST action"}');
});
bridge.listen(BRIDGE_PORT, "127.0.0.1", () => {
  console.log("[" + ts() + "] 决策桥 http://127.0.0.1:" + BRIDGE_PORT + "（GET /state | POST {type:...}）");
  startBot();
});
