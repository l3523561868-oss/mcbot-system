/**
 * core/registry.mjs — 注册表存储与注入（**受保护**）
 *
 * 取代原先散在 forge-live 里的 global.__regMaps / __itemMap / __frzCount：
 *   - 状态收敛到一个实例（谁需要谁持有，不再挂 global）；
 *   - 注入逻辑是"给定 reg 对象就干活"的函数，方便单测与替换。
 */
import fs from "fs";
import path from "path";

/** registryId → prismarine-registry 的字段名（数组 + 名字表） */
export const REGISTRY_HINTS = Object.freeze({
  "minecraft:item": ["items", "itemsByName"],
  "minecraft:block": ["blocks", "blocksByName"],
  "minecraft:entity_type": ["entities", "entitiesByName"],
  "minecraft:biome": ["biomes", "biomesByName"],
  "minecraft:enchantment": ["enchantments", "enchantmentsByName"],
  "minecraft:particle_type": ["particles", "particlesByName"],
  "minecraft:mob_effect": ["effects", "effectsByName"],
  "minecraft:attribute": ["attributes", "attributesByName"],
  "minecraft:instrument": ["instruments", "instrumentsByName"],
});

/** 规范化：minecraft:xxx → xxx；模组项保留 modid:name */
export const shortName = (nm) => (nm && nm.startsWith("minecraft:") ? nm.slice(10) : nm);

export class RegistryStore {
  constructor() {
    this.maps = new Map();     // registryId -> string[]
    this.accepted = 0;         // 收到的 frozen_registry 包数
    this.lastAt = 0;
  }

  set(registryId, names) {
    this.maps.set(registryId, names);
    this.accepted++;
    this.lastAt = Date.now();
    return names;
  }

  get(registryId) {
    return this.maps.get(registryId);
  }

  has(registryId) {
    return this.maps.has(registryId);
  }

  ids() {
    return [...this.maps.keys()];
  }

  /** 兼容旧用法：返回普通对象（只在落盘/调试时需要） */
  toObject() {
    const out = {};
    for (const [k, v] of this.maps) out[k] = v;
    return out;
  }

  get itemMap() {
    return this.maps.get("minecraft:item") || null;
  }

  /** 落盘快照（调用方负责防抖与异常吞掉） */
  dump(dir, { itemMapFile = "item-id-map.json", allFile = "registry-maps.json" } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, allFile), JSON.stringify(this.toObject()));
    const items = this.itemMap;
    if (items) fs.writeFileSync(path.join(dir, itemMapFile), JSON.stringify(items));
  }
}

/**
 * 把一份注册表灌进 prismarine-registry（原地修改传入的 reg）。
 * @returns {{fixed:number, modded:number, injected:boolean}}
 */
export function injectIntoPrismarine(reg, registryId, names) {
  const hint = REGISTRY_HINTS[registryId];
  if (!hint || !reg || !reg[hint[0]] || !reg[hint[1]]) {
    return { fixed: 0, modded: 0, injected: false };
  }
  const arr = reg[hint[0]], byName = reg[hint[1]];
  let fixed = 0, modded = 0;

  names.forEach((full, id) => {
    if (!full) return;
    const nm = shortName(full);
    if (!String(full).startsWith("minecraft:")) modded++;
    const cur = arr[id];
    if (cur && cur.name === nm) return;          // 原版项：保留（displayName/硬度更完整）
    const obj = Object.assign({}, cur || {}, { id, name: nm, displayName: nm });
    if (obj.stackSize == null) obj.stackSize = 64;
    arr[id] = obj;
    byName[nm] = obj;
    fixed++;
  });

  return { fixed, modded, injected: true };
}
