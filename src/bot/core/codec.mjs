/**
 * core/codec.mjs — 线格式纯函数（**受保护**）
 *
 * 只做字节 ↔ 值 的转换，不碰 bot、不碰文件、不碰日志。
 * 好处：可以直接单测（selftest 覆盖），换协议版本只改这里。
 */

/** 读 varint；越界返回 null（不抛），调用方自行决定如何处理 */
export function readVarInt(buf, off = 0) {
  let num = 0, len = 0, b;
  while (true) {
    b = buf[off + len];
    if (b === undefined) return null;
    num += (b & 0x7f) * Math.pow(2, 7 * len);
    len++;
    if (!(b & 0x80)) break;
    if (len > 5) return null;   // 畸形长度的保护
  }
  return [num, off + len];
}

/** 读 Minecraft 的 UTF（varint 长度前缀 + UTF-8） */
export function readUtf(buf, off = 0) {
  const r = readVarInt(buf, off);
  if (!r) return null;
  const [len, o] = r;
  if (o + len > buf.length) return null;
  return [buf.slice(o, o + len).toString("utf8"), o + len];
}

export function writeVarInt(n) {
  const out = [];
  let v = n >>> 0;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}

export function writeUtf(s) {
  const b = Buffer.from(String(s), "utf8");
  return Buffer.concat([writeVarInt(b.length), b]);
}

/**
 * 解析 neoforge:frozen_registry 载荷。
 * 格式（实测）：utf(registryId) + varint(count) + count × [varint(id) + utf(name)]
 * @returns {{registryId:string, count:number, names:string[], bytes:number}|null}
 */
export function decodeRegistryPayload(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  const a = readUtf(buf, 0);
  if (!a) return null;
  const [registryId, o1] = a;
  if (!registryId.includes(":")) return null;       // 注册表名一定是 命名空间:路径
  const b = readVarInt(buf, o1);
  if (!b) return null;
  const [count, o2] = b;
  if (count < 0 || count > 2_000_000) return null;

  const names = [];
  let off = o2;
  for (let i = 0; i < count; i++) {
    const c = readVarInt(buf, off);
    if (!c) return null;
    const [id, o3] = c;
    off = o3;
    const d = readUtf(buf, off);
    if (!d) return null;
    const [name, o4] = d;
    off = o4;
    if (id >= 0 && id < count) names[id] = name;
  }
  return { registryId, count, names, bytes: off };
}
