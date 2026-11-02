/**
 * core/contract.mjs — 核心契约层（**受保护，改动需走 core-guard --update**）
 *
 * 这一层只做三件事，且刻意保持极小、无第三方依赖、无业务逻辑：
 *   1) 冻结对外常量（契约版本、桥协议版本、事件名）
 *   2) 事件总线：核心在固定位置 emit，附加模块只订阅
 *   3) 动作注册表：附加模块注册新的桥动作，核心的 default 分支兜底转发
 *
 * 设计约束（不要为了"方便"破坏）：
 *   - 这里不能 import 任何业务模块（包括 forge-live.mjs、addons/*）；
 *   - emit 必须吞掉订阅者的异常，绝不让插件错误冒泡到核心；
 *   - 导出的常量对象必须 Object.freeze。
 */

export const CONTRACT_VERSION = "1.1.0";   // 1.1.0: 新增 service / state 贡献
export const BRIDGE_PROTOCOL = 1;

/** 核心会发出的事件（新增事件属于契约变更，需 bump CONTRACT_VERSION） */
export const EVENTS = Object.freeze({
  SPAWN: "spawn",
  DEATH: "death",
  DISCONNECT: "disconnect",
  CHAT: "chat",
  TICK: "tick",
  ACTION: "action",
});

const MAX_LISTENERS = 32;
const listeners = new Map();   // event -> [{fn, once, priority, label}]
const actions = new Map();     // name -> {fn, label}
const stats = { emitted: 0, errors: 0, lastErrors: [] };

function noteError(where, err) {
  stats.errors++;
  const msg = `[contract] ${where}: ${err && err.message ? err.message : err}`;
  stats.lastErrors.push(msg);
  if (stats.lastErrors.length > 20) stats.lastErrors.shift();
  console.error(msg);
}

/**
 * 订阅核心事件。
 * @param {string} event EVENTS 中的值
 * @param {(payload:any, ctx:any)=>void} fn
 * @param {{once?:boolean, priority?:number, label?:string}} [opts] priority 越大越先执行
 * @returns {() => void} 取消订阅
 */
export function on(event, fn, opts = {}) {
  if (typeof event !== "string" || typeof fn !== "function") {
    throw new TypeError("on(event, fn)：event 必须是字符串，fn 必须是函数");
  }
  const list = listeners.get(event) || [];
  if (list.length >= MAX_LISTENERS) {
    noteError("on", new Error(`事件 ${event} 订阅者超过 ${MAX_LISTENERS} 个，已拒绝`));
    return () => {};
  }
  const item = { fn, once: !!opts.once, priority: Number(opts.priority || 0), label: opts.label || "addon" };
  list.push(item);
  list.sort((a, b) => b.priority - a.priority);
  listeners.set(event, list);
  return () => {
    const arr = listeners.get(event) || [];
    const i = arr.indexOf(item);
    if (i >= 0) arr.splice(i, 1);
  };
}

/** 触发事件。订阅者异常被隔离，不影响核心流程。 */
export function emit(event, payload) {
  stats.emitted++;
  const list = listeners.get(event);
  if (!list || !list.length) return;
  for (const item of list.slice()) {
    try {
      item.fn(payload);
    } catch (e) {
      noteError(`${item.label}@${event}`, e);
    }
    if (item.once) {
      const i = list.indexOf(item);
      if (i >= 0) list.splice(i, 1);
    }
  }
}

/**
 * 注册新的桥动作（POST {"type": "<name>", ...}）。
 * 不允许覆盖已注册同名动作，除非显式 replace。
 */
export function registerAction(name, fn, opts = {}) {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("registerAction：name 必须是非空字符串");
  if (typeof fn !== "function") throw new TypeError("registerAction：fn 必须是函数");
  const key = name.trim();
  if (actions.has(key) && !opts.replace) {
    noteError("registerAction", new Error(`动作 ${key} 已注册，忽略（需要覆盖请传 {replace:true}）`));
    return false;
  }
  actions.set(key, { fn, label: opts.label || "addon" });
  return true;
}

/** 核心在桥的 default 分支调用：返回 undefined 表示无人认领。 */
export async function dispatchAction(name, args) {
  const item = actions.get(name);
  if (!item) return undefined;
  return await item.fn(args);
}

export function actionNames() {
  return [...actions.keys()];
}

// ---------- 能力服务：核心把"原语"暴露给 addon，addon 只写策略 ----------
const services = new Map();

/**
 * 注册能力服务（核心侧调用）。addon 只能读取，不能替换核心已注册的键。
 * @param {string} name 如 "bot" / "items" / "config"
 * @param {object} api 方法集合（会被浅拷贝并冻结）
 */
export function registerService(name, api, opts = {}) {
  if (services.has(name) && !opts.replace) {
    noteError("registerService", new Error(`服务 ${name} 已注册，忽略`));
    return false;
  }
  services.set(name, Object.freeze({ ...api }));
  return true;
}

export function getService(name) {
  return services.get(name);
}

export function serviceNames() {
  return [...services.keys()];
}

// ---------- 状态贡献：addon 往 /state 里加字段（核心不解析其含义） ----------
const stateContribs = new Map();

/**
 * 让 addon 往 /state 注入字段。
 * @param {string} key 字段名
 * @param {() => any} fn 返回该字段的值（会被 try/catch 包裹）
 */
export function contributeState(key, fn, opts = {}) {
  if (typeof key !== "string" || !key) throw new TypeError("contributeState：key 必须是非空字符串");
  if (typeof fn !== "function") throw new TypeError("contributeState：fn 必须是函数");
  if (stateContribs.has(key) && !opts.replace) {
    noteError("contributeState", new Error(`状态字段 ${key} 已被占用，忽略`));
    return false;
  }
  stateContribs.set(key, { fn, label: opts.label || "addon" });
  return true;
}

/** 核心拼 /state 时调用；任何贡献者抛错只记日志，不污染整个响应。 */
export function collectState() {
  const out = {};
  for (const [key, item] of stateContribs) {
    try { out[key] = item.fn(); } catch (e) { noteError(`${item.label}@state:${key}`, e); }
  }
  return out;
}

/** 供 /state 之类做自检：核心只暴露计数，不暴露订阅者对象。 */
export function contractStatus() {
  return Object.freeze({
    version: CONTRACT_VERSION,
    bridgeProtocol: BRIDGE_PROTOCOL,
    events: Object.keys(EVENTS).length,
    listeners: [...listeners.values()].reduce((n, l) => n + l.length, 0),
    actions: actions.size,
    services: services.size,
    stateFields: stateContribs.size,
    emitted: stats.emitted,
    errors: stats.errors,
    lastErrors: stats.lastErrors.slice(-5),
  });
}
