/**
 * dsh-whale-core · 通道注册表
 *
 * 一个 DSH 插件里可以同时挂好几个「通道」（B 站、QQ、以后可能还有别的）。
 * 每个通道插件在自己 apply() 的时候调 `getRegistry().register({...})` 把自介绍进来；
 * 框架负责：列表、开关、分节、路由分发、生命周期（stop）。
 *
 * 设计约束（改之前想清楚）：
 *   · 框架**不认识任何具体平台** —— 这里的代码里不该出现 bili / qq 这些字样 ✗
 *   · 通道之间**不知道彼此存在**，装一个或装两个都能跑 ✓
 *   · 关闭一个通道 = 它的 start() 不会被调用、它的路由返回 404、它的设置只读 ✓
 *     但**绝不删数据**（关了又重新打开不该丢东西）
 */

/** 通道 id 只允许字母数字和短横 —— 它会被拼进 URL 和文件名 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

// ⚠️ 2026-11-04 的坑：注册表必须挂在 globalThis 上，不能是这个模块自己的一个 `new Map()`。
//   钉住的理由：这个模块可能被加载**两次** ——
//     · 插件读的是 profile 的 node_modules 里那份（软链）
//     · 我自己的脚本/测试从源码目录读的是另一份
//   两份模块各有各的 Map → B 站登记进 A、core 去 B 里查 → 永远查不到（实测就是这个 ✗）。
//   挂到 globalThis 后，不管加载几次都是同一张表 ✓
//   symbol 用 Symbol.for，跨 realm 也能对上。
const REGISTRY_KEY = Symbol.for('dsh-whale-core.registry.v1')
const registry = globalThis[REGISTRY_KEY] ?? (globalThis[REGISTRY_KEY] = new Map())

export class ChannelError extends Error {}

/** 校验通道声明的 configFile：只能是绝对路径字符串，不能跟 channel-config 的默认目录打架 */
function normalizeConfigFile(id, value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new ChannelError(`通道 ${id} 的 configFile 必须是字符串`)
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value)) {
    throw new ChannelError(`通道 ${id} 的 configFile 必须是绝对路径：${value}`)
  }
  return value
}

/**
 * @typedef {object} ChannelDef
 * @property {string}   id           唯一 id（小写，进 URL / 文件名）
 * @property {string}   label        显示名（「B 站」「QQ」）
 * @property {string}   [emoji]      分节标题上那个小图标
 * @property {number}   [order]      排序，小的在前
 * @property {string}   [description] 一句话说明
 * @property {string}   [home]       这个通道自己的数据目录默认值（工作区/日记）
 * @property {boolean}  [defaultEnabled] 没配过的时候默认开还是关
 * @property {object}   [defaults]   这个通道的默认配置（分节配置的兜底）
 * @property {Function} [start]      (ctx) => ({ stop(): void } | void)  开关打开时调用
 * @property {Function} [deps]       async () => ({ ok, items, error }) 依赖体检
 * @property {Object<string, Function>} [routes]  `'GET /status': handler(req,res)` 之类的额外路由
 * @property {boolean}  [needsLogin] 是否需要登录态（设置页拿它决定显不显示登录块）
 */

/** 校验并登记一个通道。重复 id 会抛错 —— 两个插件抢同一个 id 时宁可炸也别静默覆盖 ✗ */
export function register(def) {
  if (!def || typeof def !== 'object') throw new ChannelError('通道定义必须是对象')
  const id = String(def.id ?? '')
  if (!ID_RE.test(id)) throw new ChannelError(`通道 id 不合法：${JSON.stringify(id)}（只允许小写字母、数字、短横）`)
  if (registry.has(id)) throw new ChannelError(`通道 id 重复：${id}（已经有一个通道占着了）`)
  if (typeof def.label !== 'string' || !def.label) throw new ChannelError(`通道 ${id} 缺少 label`)
  if (def.routes !== undefined && (typeof def.routes !== 'object' || def.routes === null)) {
    throw new ChannelError(`通道 ${id} 的 routes 必须是对象`)
  }
  for (const key of Object.keys(def.routes ?? {})) {
    const m = /^(GET|POST|PUT|DELETE)\s+(\S+)$/.exec(key)
    if (!m) throw new ChannelError(`通道 ${id} 的路由 key 要写成 "GET /x" 或 "POST /x"：${key}`)
    if (!m[2].startsWith('/')) throw new ChannelError(`通道 ${id} 的路由路径必须以 / 开头：${key}`)
  }
  const entry = {
    id,
    // ⚠️ 2026-11-04 的坑：这个字段原来在 entry 里漏了 →
    //   core 拿不到通道指定的配置文件，B 站的配置就掉到 whale-channels/channels/bili.json 去了
    //   （而十几个工具还读老的 ✗）。凡是「登记时传了、core 却用不上」的字段都是这种静默失效，
    //   configFile 因此**要么校验失败抛错、要么一定带上**，不留「没传就悄悄用默认」的空档 ✓
    configFile: normalizeConfigFile(id, def.configFile),
    label: def.label,
    emoji: typeof def.emoji === 'string' ? def.emoji : '',
    order: Number.isFinite(def.order) ? def.order : 100,
    description: typeof def.description === 'string' ? def.description : '',
    home: typeof def.home === 'string' ? def.home : '',
    defaultEnabled: def.defaultEnabled !== false,
    defaults: def.defaults && typeof def.defaults === 'object' ? def.defaults : {},
    start: typeof def.start === 'function' ? def.start : null,
    deps: typeof def.deps === 'function' ? def.deps : null,
    routes: def.routes ?? {},
    needsLogin: def.needsLogin === true,
    registeredAt: new Date().toISOString(),
  }
  registry.set(id, entry)
  return () => registry.delete(id)
}

/** 拿一个通道（不存在返回 undefined） */
export function get(id) {
  return registry.get(String(id))
}

/** 所有通道，按 order、id 排序（列表稳定，设置页不乱跳 ✓） */
export function list() {
  return [...registry.values()].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
}

/** 只留对外能说的字段 —— start/deps 这些函数不进 JSON */
export function describe(entry) {
  if (!entry) return null
  return {
    id: entry.id,
    label: entry.label,
    emoji: entry.emoji,
    order: entry.order,
    description: entry.description,
    home: entry.home,
    configFile: entry.configFile,
    defaultEnabled: entry.defaultEnabled,
    defaults: entry.defaults,
    needsLogin: entry.needsLogin,
    routeKeys: Object.keys(entry.routes),
    hasStart: Boolean(entry.start),
    hasDeps: Boolean(entry.deps),
  }
}

/** 测试用：清空注册表 */
export function _reset() {
  registry.clear()
}

/**
 * 取「跟本模块同一个模块实例」的注册表 —— 通道插件都必须用这个，
 * 绝对不能自己去 import 一个注册表对象然后传过来。
 *
 * ⚠️ 2026-11-04 的坑：传进来的若来自**另一份模块实例**，它的 start() 会去操作
 *   另一个闭包里的东西，跨实例调用时会静默失效（测试里表现为「通道登记上了但不跑」）。
 *   所以提供一个「拷贝自己过去」的函数：`attachRegistry(otherExports)`。
 *   otherExports.register 只有自己模块的其余函数认得 —— 用 Symbol.for 把本实例的
 *   register 挂上去，对方读到了就是读到「它自己那个 register」✓
 */
export const REGISTER_KEY = Symbol.for('dsh-whale-core.register.v1')

/**
 * 让**另一份模块实例**读到本实例的 register。
 * 用法（在通道插件里）：
 *   import * as core from 'dsh-whale-core/registry'
 *   const { register } = (await import(...)) — 不需要，直接 core.register 即可
 * 这个函数只有测试和「手动挂两份」时用得上。
 */
export function attachRegistry(otherExports) {
  if (!otherExports || typeof otherExports !== 'object') return false
  try {
    Object.defineProperty(otherExports, REGISTER_KEY, {
      value: register, configurable: true, enumerable: false, writable: false,
    })
    return true
  } catch { return false }
}

/**
 * 通道插件用的入口：优先拿「当前这份实例」的 register；
 * 若宿主把另一份实例塞进了 REGISTER_KEY，那就用它的（保证和 core 同一个闭包）✓
 */
export function getRegistry() {
  const own = globalThis[REGISTRY_KEY]
  const foreign = own && own.__foreignRegister
  return {
    register: foreign ?? register,
    get,
    list,
    describe,
  }
}
