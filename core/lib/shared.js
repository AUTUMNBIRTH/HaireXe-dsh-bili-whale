/**
 * dsh-whale-core · 一条鱼、两个入口，谁负责什么（2026-11-04 主人定义）
 *
 * ⚠️ 2026-11-04 主人纠错（原话）：
 *   「我想做的是一条鱼控制两个插件，所以记忆本备份只有桌面一份，
 *     只不过是选择 qq 还是哔站使用不同而已」
 *
 * 所以先立住模型，再谈逻辑：
 *
 *       一条鱼（同一个人格、同一本日记、同一段记忆、同一套人设）
 *       ├─ 入口 A：B 站（能私聊、能发动态、能分享视频）
 *       └─ 入口 B：QQ  （能私聊、能发动态；没有「分享视频」这种东西）
 *
 *   「记忆只有一份」不是配置项，是**事实**：
 *     日记 → ~/.dsh/whale-diary.md、whale-diary-private.md
 *     人设 → ~/.bili-ai/persona.md
 *     QQ 插件里没有任何写日记的代码，它读的就是同一份 ✓
 *
 * 在这个前提下，还剩四件**真正要选**的事：
 *   ① 记忆共用 —— 保留字段只为了兼容老配置，正常必须是真的（见 normalizeShared）
 *   ② 私聊走哪个入口 —— **只能选一个**（两个都开会被吵死 ✗）
 *   ③ 发动态走哪个入口 —— 也可以选一个
 *   ④ 分享视频 —— 只有 B 站能做的能力，一个总开关
 *
 * 这个文件只管**算结论**，不读文件不发网络；core 的路由和通道自己来用 ✓
 */

export const SHARED_DEFAULTS = {
  // 记忆：永远是「共用」—— 本来就只有一份。留这个字段只为兼容旧配置和旧测试 ✓
  memory: {
    shared: true,
    diaryFile: '',        // 留空 = 用 ~/.dsh/whale-diary.md
  },
  // 作息：一套。一条鱼不该有两个生物钟 ✓
  wake: {
    shared: true,         // 共用一套醒来时间点
    windows: [],          // 留空 = 用 B 站那边原来的作息（night.windows）
  },
  // ⚠️ primary 是**历史遗留字段**，只在展示为主的场景用到；
  //   一条鱼两个入口里没有「主次」，能力判断一律不看它 ✗
  primary: 'bili',
  dm: 'bili',             // 私聊走哪个入口：bili | qq —— **只能一个**
  dynamic: 'bili',        // 发动态走哪个入口：bili | qq —— **只能一个**
  share: true,            // 分享视频总开关（B 站独有的能力）
}

const VALID = ['bili', 'qq']

export class SharedError extends Error {}

function checkChannel(v, field) {
  if (!VALID.includes(v)) throw new SharedError(`${field} 只能是 bili 或 qq（拿到的是 ${JSON.stringify(v)}）`)
  return v
}

/** 规整一份配置（缺的补默认，非法值直接抛 —— 宁可报错也别悄悄用默认 ✗） */
export function normalizeShared(input) {
  const s = { ...SHARED_DEFAULTS, ...(input ?? {}) }
  s.memory = { ...SHARED_DEFAULTS.memory, ...(input?.memory ?? {}) }
  s.wake = { ...SHARED_DEFAULTS.wake, ...(input?.wake ?? {}) }
  checkChannel(s.primary, '主通道 primary')
  checkChannel(s.dm, '私聊 dm')
  checkChannel(s.dynamic, '发动态 dynamic')
  // 醒来窗口如果填了，得是数组（每项 { from:'08:00', to:'12:00' }）
  if (s.wake.windows != null && !Array.isArray(s.wake.windows)) {
    throw new SharedError('wake.windows 必须是数组')
  }
  return s
}

/**
 * 共用作息：两个通道**看同一套醒来时间点**（主人 11-04：「那些醒来的时间点在这些条件之下共用」）。
 * windows 留空就用 B 站那边配好的 `night.windows` —— 不另起一套 ✗
 */
export function sharedWakeWindows({ shared, biliNightWindows = [] } = {}) {
  const s = normalizeShared(shared)
  if (!s.wake.shared) return biliNightWindows
  const own = Array.isArray(s.wake.windows) ? s.wake.windows : []
  return own.length ? own : biliNightWindows
}

/**
 * 现在这个通道**能干什么**。
 *
 * 2026-11-04 主人重定了规则（原话）：
 *   「私聊和发动态只能选择一个平台，分享视频时间只有哔站功能开着的时候可以用，
 *    然后哔站功能开着的时候如果选择的是QQ私聊和动态，那哔站只有分享视频功能」
 *
 * 拆成能落地的话：
 *   ① **分享视频只有 B 站有** —— QQ 没有这个功能，不看谁当选 ✗
 *   ② **B 站开着 + 私聊和动态都给了 QQ** → B 站只剩「收消息 + 分享视频」✓
 *   ③ 私聊 / 动态**各自最多一个平台**（主人可能只把其中一个给 QQ）✓
 *   ④ 一个通道关着 → 它什么都不干
 *   ⑤ 不是「谁主谁次」，而是「这个通道还剩哪些能力」—— 不再用 primary 判断 ✗
 *
 * @param {string} id          通道 id（bili / qq）
 * @param {object} p
 * @param {object} p.shared    normalizeShared 之后的配置
 * @param {object} p.enabled   { bili: bool, qq: bool } 两个通道各自的开关
 * @returns {{ on, dm, share, dynamic, full, why }}
 */
export function capabilitiesFor(id, { shared, enabled = {}, configured = {} } = {}) {
  const s = normalizeShared(shared)
  // 2026-11-04 主人要求：「只配置了哔站的话总控制台里就选不了 QQ」
  //   没装的通道（configured[id] !== true）**不能**被算成能干活的 ——
  //   否则控制台会把私聊/动态派给一个根本不存在的入口 ✗
  const present = configured[id] !== false
  const self = enabled[id] !== false && present

  if (!self) {
    // ⚠️ 返回的形状必须和下面**完全一致** —— 少了 shareOnly 字段，控制台读出来是 undefined，
    //   表现为「关掉了但那个标记还在/看不见」，是最烦的那种错 ✗
    const why = !present ? '这个通道没装' : '这个通道自己关着'
    return { on: false, present, dm: false, share: false, dynamic: false, full: false, shareOnly: false, caps: [], why }
  }

  const isDm = s.dm === id
  const isDynamic = s.dynamic === id
  // ① 分享视频是 B 站独有的能力；QQ 开通了也不行（没有这个东西）
  const canShare = id === 'bili' && s.share !== false

  // 能力清单写成人话，控制台直接用
  const list = []
  if (isDm) list.push('私聊')
  if (canShare) list.push('分享视频')
  if (isDynamic) list.push('发动态')

  // 只剩下「分享视频」（+ 收消息，收消息是不用开也有的）
  const shareOnly = canShare && !isDm && !isDynamic
  return {
    on: true,
    present,
    dm: isDm,
    share: canShare,
    dynamic: isDynamic,
    full: isDm && canShare && isDynamic,
    shareOnly,
    caps: list,
    why: list.length
      ? `能做：${list.join('、')}${shareOnly ? '（其余功能在另一个平台上）' : ''}`
      : '只能收消息（私聊和动态都在另一个平台上）',
  }
}

/**
 * 这个通道「装好了没」—— 决定总控制台能不能选它。
 *
 * 2026-11-04 主人的要求：
 *   「只配置了哔站的话总控制台里就选不了 QQ，只配置了 qq 的话就选不了哔站，
 *    会提醒未配置该功能；如果都配置了且登录了就是现在都可选择的情况」
 *
 * 判断标准（宁可保守，也不能把没配好的说成能选）：
 *   · B 站：装了插件就基本可用，但要**登录过**（有 cookie）才算配好
 *   · QQ：装了插件 + 填了主人 QQ 号 + NapCat 那边**登录过**（self.uin 有值）
 *
 * @param {string} id 通道 id
 * @param {object} p
 * @param {boolean} p.installed  插件在不在（core 注册表里有没有）
 * @param {boolean} p.loggedIn   这个通道登录过没有
 * @param {object}  [p.cfg]      通道自己的配置
 * @returns {{ ok: boolean, reason: string, hint: string }}
 */
export function setupStateFor(id, { installed = false, loggedIn = false, cfg = {} } = {}) {
  if (!installed) {
    return {
      ok: false,
      reason: '没装',
      hint: id === 'qq' ? '装「养鱼 · QQ」插件后就能选它' : '装「养鱼 · B站」插件后就能选它',
    }
  }
  if (id === 'qq') {
    const ownerUin = String(cfg?.owner?.uin ?? '').trim()
    const selfUin = String(cfg?.self?.uin ?? '').trim()
    if (!selfUin) {
      return { ok: false, reason: '还没登录 QQ', hint: '在「养鱼 · QQ」里扫码登录一下' }
    }
    if (!ownerUin) {
      return { ok: false, reason: '还没填你的 QQ 号', hint: '在「养鱼 · QQ」里填上「主人的 QQ 号」' }
    }
    return { ok: true, reason: '已配置', hint: '' }
  }
  if (!loggedIn) {
    return { ok: false, reason: '还没登录', hint: '在「养鱼 · B站」里扫码登录一下' }
  }
  return { ok: true, reason: '已配置', hint: '' }
}

/** 两边一样时谁赢：主通道赢（免得配置互相打架 ✗） */
export function resolveConflict(shared) {
  const s = normalizeShared(shared)
  return {
    ...s,
    // 私聊/动态指向的那个通道必须开着；它关着就自动回落到主通道
    dm: s.dm,
    dynamic: s.dynamic,
  }
}
