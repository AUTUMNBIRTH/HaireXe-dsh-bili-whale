/**
 * dsh-whale-core · 她的习惯（2026-11-04）
 *
 * 主人最后的要求（原话）：
 *   「只要配置或改动了一种养鱼方式的设置，另一种养鱼方式的相同设置就会同步更新
 *     （比如人格，作息），保证连贯性」
 *
 * ⚠️ 改之前的问题（实测数据，见 diag/audit-shared-settings.mjs）：
 *   · 作息：B 站 3 个时段 / 每天 3 次 / 间隔 60 分；QQ 1 个时段 / 4 次 / 45 分 —— 全不一样
 *   · 主动：B 站 1.0 / 每天 2 次；QQ 0.8 / 每天 3 次
 *   · 口味：B 站填了一串"喜欢/不喜欢"；QQ 是空的
 *   · 人设名字/称呼/自称：QQ 根本没有这几个字段
 *
 *   结果就是「同一条鱼，两边性格不一样」✗
 *
 * 现在的做法：**这些字段只有一份**，存在 `~/.dsh/whale-habits.json`。
 *   两个插件在读取时都从这里取值；在写入时都往这里写。
 *   哪边改都行，另一边立刻看到 ✓
 *
 * 为什么不用 core 的 shared.json：
 *   那份文件是「谁做什么」的分配（私聊归谁、动态归谁），语义不同，
 *   而且它属于总控制台。习惯是"她是谁"，不该混在一起 ✗
 */
import fs from 'node:fs'
import path from 'node:path'

/** 这些字段两边语义相同，所以**必须只有一份** */
export const HABIT_KEYS = [
  'night',          // 作息（几点醒）
  'proactive',      // 主动找你
  'preferences',    // 口味
  'persona',        // 人设的名字/称呼/自称（正文本身是 persona.md，本来就一份）
  'sessionRotateDays',
  'personaOncePerSession',
]

/**
 * 默认值 —— 和两边插件各自的默认保持一致，避免"刚装好两边显示的数字不一样"。
 * ⚠️ 这份默认只在新机器上用；已有机器会从 B 站那边（历史主来源）迁移过来 ✓
 */
export const HABIT_DEFAULTS = {
  night: {
    windows: [
      { start: '9:00', end: '11:00', wakes: 1 },
      { start: '14:00', end: '16:00', wakes: 1 },
      { start: '20:00', end: '22:00', wakes: 1 },
    ],
    skipChance: 0,
    minGapMin: 60,
    maxWakesPerDay: 3,
  },
  proactive: {
    enabled: true,
    chance: 1,
    dailyMax: 2,
    quietMin: 30,
  },
  preferences: {
    like: [],
    dislike: [],
  },
  persona: {
    name: '',
    ownerTitle: '主人',
    selfClaim: '',
  },
  sessionRotateDays: 1,
  personaOncePerSession: true,
}

export function habitsFile(dshHome) {
  return path.join(dshHome || '.', 'whale-habits.json')
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJsonSafe(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

/** 深合并（对象合并，数组替换 —— 作息时段的顺序要保留，不能拼起来） */
function mergeDeep(base, patch) {
  if (!isObj(patch)) return patch === undefined ? base : patch
  const out = isObj(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) && isObj(out[k]) ? mergeDeep(out[k], v) : v
  }
  return out
}

/**
 * 只挑出「习惯」那几项，其它字段（比如 QQ 的 napcat 配置、B 站的 cookie）不碰。
 * 这是同步的核心：**只同步语义相同的，绝不整份覆盖** ✗
 */
export function pickHabits(cfg = {}) {
  const out = {}
  for (const k of HABIT_KEYS) if (cfg[k] !== undefined) out[k] = cfg[k]
  return out
}

/** 把两边各自的字段名统一成一份：
 *   B 站用 proactiveChance / proactiveDailyMax，QQ 用 proactive.chance / .dailyMax
 *   这种"名字不同但意思一样"的地方在这里抹平 ✓ */
export function normalizeHabits(raw = {}) {
  const h = mergeDeep(structuredClone(HABIT_DEFAULTS), pickHabits(raw))
  // B 站的散字段 → 统一的 proactive
  if (raw.proactiveChance !== undefined) h.proactive.chance = Number(raw.proactiveChance)
  if (raw.proactiveDailyMax !== undefined) h.proactive.dailyMax = Number(raw.proactiveDailyMax)
  // 口味历史上可能是字符串
  for (const k of ['like', 'dislike']) {
    const v = h.preferences?.[k]
    if (typeof v === 'string') {
      h.preferences[k] = v.trim() ? v.split(/[,，、\s]+/).filter(Boolean) : []
    }
  }
  return h
}

/**
 * 读「她的习惯」。文件不存在就用默认（**不自动写** —— 读操作不该有副作用）。
 */
export function readHabits({ dshHome } = {}) {
  const raw = readJsonSafe(habitsFile(dshHome))
  return normalizeHabits(raw ?? {})
}

/**
 * 写回。patch 只覆盖给的字段，其余保持。
 * @returns 合并之后的完整习惯
 */
export function saveHabits({ dshHome, patch = {}, who = '' } = {}) {
  const cur = readJsonSafe(habitsFile(dshHome)) ?? {}
  const merged = mergeDeep(cur, pickHabits(patch))
  // B 站的老散字段也一起记，方便 B 站不改代码也能读到
  if (patch.proactiveChance !== undefined) merged.proactiveChance = Number(patch.proactiveChance)
  if (patch.proactiveDailyMax !== undefined) merged.proactiveDailyMax = Number(patch.proactiveDailyMax)
  const next = {
    ...merged,
    _updatedAt: Date.now(),
    _updatedBy: who || merged._updatedBy || '',
  }
  writeJsonSafe(habitsFile(dshHome), next)
  return normalizeHabits(next)
}

/**
 * 第一次启用共享时，从既有配置**迁移**过来。
 *
 * 谁的优先？
 *   · 已经在 whale-habits.json 里的：不动（已经共享了）
 *   · 否则：**哪边动过用哪边** —— 判据是「和默认值不同」。
 *     两边都动过且有冲突时，用 B 站那份（它是历史主来源，作息一直是它配的）✓
 *
 * @param {object} p
 * @param {object} p.biliCfg
 * @param {object} p.qqCfg
 * @param {number} [p.now]
 * @returns {{ migrated: boolean, source: string, habits: object }}
 */
export function ensureHabits({ dshHome, biliCfg = {}, qqCfg = {}, now = Date.now() } = {}) {
  const existing = readJsonSafe(habitsFile(dshHome))

  // ⚠️ 2026-11-04 晚（主人：「爱好没和哔站同步」）：
  //   原来这里 `if (existing) return` —— 文件存在就直接不管了。
  //   结果：首次迁移时 B站 的 preferences 是空的（那时还没填），
  //         后来 B站 填了爱好，共享文件却一直空着，QQ 永远读不到 ✗
  //
  //   现在：文件存在也要**补漏** —— 哪个字段在共享文件里是空的，
  //         就从通道配置里捞回来。已经有的不覆盖（避免把 QQ 改的值冲掉）。
  if (existing) {
    const patched = backfillHabits({ existing, biliCfg, qqCfg })
    if (patched.changed) {
      writeJsonSafe(habitsFile(dshHome), { ...existing, ...patched.patch, _backfilledAt: now })
      return { migrated: false, source: 'backfill', habits: normalizeHabits({ ...existing, ...patched.patch }) }
    }
    return { migrated: false, source: 'existing', habits: normalizeHabits(existing) }
  }

  const biliH = pickHabits(biliCfg)
  const qqH = pickHabits(qqCfg)
  const defaults = normalizeHabits({})

  const differs = (h) => {
    const norm = normalizeHabits(h)
    return JSON.stringify(norm) !== JSON.stringify(defaults)
  }
  const biliMoved = differs(biliH)
  const qqMoved = differs(qqH)

  // 优先级：B 站动过 → B 站；否则 QQ 动过 → QQ；都没动 → 默认
  const source = biliMoved ? 'bili' : qqMoved ? 'qq' : 'defaults'
  const seed = source === 'bili' ? biliH : source === 'qq' ? qqH : {}

  const merged = mergeDeep(structuredClone(HABIT_DEFAULTS), seed)
  writeJsonSafe(habitsFile(dshHome), {
    ...merged,
    _migratedAt: now,
    _migratedFrom: source,
  })
  return { migrated: true, source, habits: normalizeHabits(merged) }
}

/**
 * 补漏：共享文件里空着的字段，从通道配置里捞回来（已有的不覆盖）。
 *
 * 为什么需要：首次迁移之后用户还会继续填设置，但共享文件不会自己更新。
 * 不做这个，就会出现「B站 有爱好、QQ 永远读不到」这种情况 ✗
 *
 * @returns {{ changed: boolean, patch: object }}
 */
export function backfillHabits({ existing = {}, biliCfg = {}, qqCfg = {} } = {}) {
  const cur = normalizeHabits(existing)
  const patch = {}
  const has = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && String(v).trim() !== '')

  // ① 口味：共享层空着，就按 B站 → QQ 的顺序捞
  const prefs = {}
  for (const key of ['like', 'dislike', 'keywords']) {
    if (has(cur.preferences?.[key])) continue
    const fromBili = biliCfg?.preferences?.[key]
    const fromQq = qqCfg?.preferences?.[key]
    const picked = has(fromBili) ? fromBili : (has(fromQq) ? fromQq : null)
    if (picked !== null) {
      // 字符串拆成数组（B 站历史配置里可能是字符串）
      prefs[key] = Array.isArray(picked) ? picked : String(picked).split(/[,，、\s]+/).filter(Boolean)
    }
  }
  if (Object.keys(prefs).length) patch.preferences = { ...cur.preferences, ...prefs }

  // ② 人设的名字/称呼/自称：共享层空着就捞
  const persona = {}
  for (const key of ['name', 'ownerTitle', 'selfClaim']) {
    if (has(cur.persona?.[key])) continue
    const fromBili = biliCfg?.persona?.[key]
    const fromQq = qqCfg?.persona?.[key]
    const picked = has(fromBili) ? fromBili : (has(fromQq) ? fromQq : null)
    if (picked !== null) persona[key] = picked
  }
  if (Object.keys(persona).length) patch.persona = { ...cur.persona, ...persona }

  return { changed: Object.keys(patch).length > 0, patch }
}

/**
 * 把一个通道的配置**合并上**共享习惯 —— 插件读取配置时调这个。
 *
 * 关键：习惯**覆盖**通道自己那份（否则改了不生效）。但通道独有的字段（cookie、uin、语音…）保留。
 */
export function applyHabits({ cfg = {}, habits }) {
  const out = { ...cfg }
  const h = habits ?? normalizeHabits({})
  // ⚠️ 2026-11-07 晚修（对比主人真实配置时发现的）：
  //   原来这里是**无条件覆盖**：
  //       out.night = h.night
  //       out.proactive = h.proactive
  //   问题：共享层只要有值，用户在 QQ 控制台上改的作息/主动概率
  //   **每次读都被顶回去** —— 改不动，也看不出为什么 ✗
  //
  //   实测：主人 QQ 配置里作息是 9:00-11:00，共享层是 8:00-12:00
  //        → 他在界面上改了也白改。
  //
  //   现在和口味一样：共享层**有内容**才覆盖，空的保留各自的 ✓
  //   「改一边另一边跟着变」照样成立 —— 只要共享层真的写了值
  const hn = h.night ?? {}
  const ownNight = cfg.night ?? {}
  out.night = (Array.isArray(hn.windows) && hn.windows.length)
    ? { ...ownNight, ...hn }
    : { ...ownNight }

  const hpro = h.proactive ?? {}
  const ownPro = cfg.proactive ?? {}
  out.proactive = (hpro && Object.keys(hpro).length)
    ? { ...ownPro, ...hpro }
    : { ...ownPro }

  // ⚠️ 2026-11-04 晚修（主人：「爱好没和哔站同步」）：
  //   原来这里是 `out.preferences = h.preferences` —— **无条件覆盖**。
  //   而 whale-habits.json 里的 preferences 是空的（首次迁移时没搬过来），
  //   结果 B站 自己填好的爱好被共享层的空值冲掉了 ✗
  //   实测：文件里是 ["同步测试","鱼"]，applyHabits 之后变成 []。
  //
  //   现在：共享层有货 → 用共享的（这样"改一边另一边跟着变"成立）；
  //         共享层是空的 → 保留这个通道自己那份（不丢数据）。
  const hp = h.preferences ?? {}
  const ownP = cfg.preferences ?? {}
  const has = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(String(v ?? '').trim()))
  out.preferences = {
    like: has(hp.like) ? hp.like : (ownP.like ?? []),
    dislike: has(hp.dislike) ? hp.dislike : (ownP.dislike ?? []),
    keywords: has(hp.keywords) ? hp.keywords : (ownP.keywords ?? []),
  }

  // 人设：习惯里**非空**的才覆盖，空的留通道自己的
  //   ⚠️ 不能直接用 h.persona 覆盖 —— 共享文件里 name 是空的，
  //     会把 B 站已经填好的"邦邦"冲成空字符串 ✗
  if (h.persona && Object.keys(h.persona).length) {
    const merged = { ...(cfg.persona ?? {}) }
    for (const [k, v] of Object.entries(h.persona)) {
      const empty = v === '' || v === null || v === undefined
      if (!empty || merged[k] === undefined) merged[k] = v
    }
    out.persona = merged
  }
  out.sessionRotateDays = h.sessionRotateDays
  out.personaOncePerSession = h.personaOncePerSession
  // B 站那两个散字段也同步过去（它自己的代码读这两个）
  out.proactiveChance = h.proactive?.chance
  out.proactiveDailyMax = h.proactive?.dailyMax
  return out
}

/**
 * 给控制台看的对比：两边现在一不一致
 * @returns {{ consistent: boolean, habits: object, conflicts: Array }}
 */
export function habitDiff({ habits, biliCfg = {}, qqCfg = {} }) {
  const h = habits ?? normalizeHabits({})
  const conflicts = []

  const biliPro = { chance: biliCfg.proactiveChance, dailyMax: biliCfg.proactiveDailyMax }
  if (biliPro.chance !== undefined && Number(biliPro.chance) !== Number(h.proactive?.chance)) {
    conflicts.push({ field: 'proactive.chance', bili: biliPro.chance, shared: h.proactive?.chance })
  }
  const qqWin = qqCfg.night?.windows?.length
  if (qqWin !== undefined && qqWin !== h.night?.windows?.length) {
    conflicts.push({ field: 'night.windows', qq: `${qqWin} 个时段`, shared: `${h.night?.windows?.length} 个时段` })
  }
  return { consistent: conflicts.length === 0, habits: h, conflicts }
}
