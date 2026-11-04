/**
 * dsh-whale-core · 跨通道的风险预算（限流 / 去重 / 冷却）
 *
 * 为什么放在 core：两个通道同时开着的时候，「今天一共说了多少句」必须是一个数。
 * 各算各的 → 两条鱼加起来能跟主人说 400 句，那不是在陪他，是在刷屏 ✗
 *
 * 这里只做**计数和判断**，不碰网络，也不知道对方是 B 站还是 QQ ✓
 * 真正的发请求仍然由各自的通道去做（B 站那边是 tools/lib/traffic.mjs）。
 */

const HOUR = 3600_000
const DAY = 24 * HOUR

export const RISK_DEFAULTS = {
  writeHourly: 600,     // 2026-11-03 主人拍板调高的值
  writeDaily: 2000,
  readHourly: 1200,
  readDaily: 20000,
  dmGapSec: 2,          // 两条私信之间的最小间隔
  minGapMs: 1500,       // 任意两次请求之间的最小间隔
}

function bucketKey(ts) { return Math.floor(ts / HOUR) }
function dayKey(ts) { return new Date(ts).toLocaleDateString('sv-SE') }

/**
 * 建一个计数器。state 传一份可持久化的对象进来（{} 也行），
 * 每次 reserve() 通过才会改 state —— **被拦下的操作不计数** ✓（不然越拦越死）
 */
export function createRiskCounter({ state = {}, limits = {}, now = () => Date.now() } = {}) {
  const lim = { ...RISK_DEFAULTS, ...limits }
  if (!state.write) state.write = { hour: null, hourCount: 0, day: null, dayCount: 0 }
  if (!state.read) state.read = { hour: null, hourCount: 0, day: null, dayCount: 0 }
  if (!state.lastWriteAt) state.lastWriteAt = 0

  function roll(b, ts) {
    const h = bucketKey(ts)
    const d = dayKey(ts)
    if (b.hour !== h) { b.hour = h; b.hourCount = 0 }
    if (b.day !== d) { b.day = d; b.dayCount = 0 }
  }

  /** 还能不能再写一次？不能的话给出原因（给日志/设置页看） */
  function canWrite({ channel = '', body = '' } = {}) {
    const ts = now()
    roll(state.write, ts)
    if (state.write.hourCount >= lim.writeHourly) {
      return { ok: false, code: 'hourly', error: '已达到本地写操作预算（这一小时发得太快了），等整点再发' }
    }
    if (state.write.dayCount >= lim.writeDaily) {
      return { ok: false, code: 'daily', error: '已达到本地写操作预算（今天发得太多了），明天再发' }
    }
    const gap = lim.dmGapSec * 1000
    if (ts - state.lastWriteAt < gap) {
      const wait = Math.ceil((gap - (ts - state.lastWriteAt)) / 1000)
      return { ok: false, code: 'cooldown', error: `写操作冷却中，再等 ${wait} 秒` }
    }
    // 跨通道去重：同一句话在两个通道里各发一遍也是重复（24 小时内）
    const fp = fingerprint(channel, body)
    state.seen ??= {}
    const prev = state.seen[fp]
    if (prev && ts - prev < 24 * HOUR && state.pendingFp === fp) {
      return { ok: false, code: 'duplicate', error: '相同内容的上一次发送结果还没确认，先别重发（防双发）' }
    }
    return { ok: true }
  }

  /** 预扣一次写额度；返回 ok:false 时**什么都没变** */
  function reserveWrite(opts = {}) {
    const verdict = canWrite(opts)
    if (!verdict.ok) return verdict
    const ts = now()
    state.write.hourCount += 1
    state.write.dayCount += 1
    state.lastWriteAt = ts
    const fp = fingerprint(opts.channel, opts.body)
    state.seen ??= {}
    state.seen[fp] = ts
    // 只留最近 500 条指纹，别让文件无限长
    const keys = Object.keys(state.seen)
    if (keys.length > 500) {
      keys.sort((a, b) => state.seen[a] - state.seen[b]).slice(0, keys.length - 500).forEach((k) => delete state.seen[k])
    }
    return { ok: true }
  }

  function reserveRead() {
    const ts = now()
    roll(state.read, ts)
    if (state.read.hourCount >= lim.readHourly) {
      return { ok: false, code: 'hourly', error: '已达到本地读取预算（这一小时查得太频繁），等一会儿' }
    }
    if (state.read.dayCount >= lim.readDaily) {
      return { ok: false, code: 'daily', error: '已达到本地读取预算（今天查得太多了），等预算窗口恢复' }
    }
    state.read.hourCount += 1
    state.read.dayCount += 1
    return { ok: true }
  }

  function snapshot() {
    const ts = now()
    roll(state.write, ts)
    roll(state.read, ts)
    return {
      writeHour: state.write.hourCount, writeHourMax: lim.writeHourly,
      writeDay: state.write.dayCount, writeDayMax: lim.writeDaily,
      readHour: state.read.hourCount, readHourMax: lim.readHourly,
      readDay: state.read.dayCount, readDayMax: lim.readDaily,
      limits: lim,
    }
  }

  return { canWrite, reserveWrite, reserveRead, snapshot, limits: lim, state }
}

function fingerprint(channel, body) {
  // 不做真哈希：这里只要稳定（同输入同输出），不要求抗碰撞
  const s = `${channel}\u0000${String(body ?? '').replace(/\s+/g, ' ').trim()}`
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i += 1) {
    h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (Math.imul(h2 ^ s.charCodeAt(i), 0x85ebca6b)) >>> 0
  }
  return `${h1.toString(36)}${h2.toString(36)}`
}

/**
 * 跨通道共享额度的「上限」：两个通道都开时，主人一天最多被主动找几次。
 * 单个通道自己的上限不变（通道内还是按它自己的配额），这里是**总闸**。
 */
export function sharedDailyCap({ channels, caps = {} } = {}) {
  const on = (channels ?? []).filter((c) => c.enabled).map((c) => c.id)
  let sum = 0
  for (const id of on) {
    const v = Number(caps[id])
    if (Number.isFinite(v) && v > 0) sum += v
  }
  return sum
}
