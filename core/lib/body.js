/**
 * dsh-whale-core · 一条鱼的身体（2026-11-04）
 *
 * 主人最后的要求（原话）：
 *   「只要配置或改动了一种养鱼方式的设置，另一种养鱼方式的相同设置就会同步更新
 *     （比如人格，作息），保证连贯性，最后确保切换养鱼方式后再私聊还是在同一个上下文，
 *      还记得东西」
 *
 * 这个文件解决**后半句**：同一个上下文。
 *
 * ⚠️ 改之前的问题（真查出来的）：
 *   · B 站把当前会话 id 存在 `~/.dsh/whale-session.json`，会按自然日轮换
 *   · QQ 存的是**自己那一份** `qq-wake-state.json`，默认还很天真地写 `'bili-whale'`
 *   · 于是两边各开一个对话 —— 在 QQ 说的话，她在 B 站完全不知道 ✗
 *   · 更糟：B 站轮换之后，QQ 还拿着旧 id，等于**失忆**
 *
 * 现在：会话 id 只有一处权威（这个文件），两边都从这里读、往这里写。
 *   谁先轮换的，另一个立刻看见 ✓
 *
 * 设计上的三个决定：
 *   ① **文件级共享**，不靠内存。两个插件在不同进程/不同加载时机，内存不互通
 *   ② 读的时候**永远先看文件**，文件没有才用默认 —— 别把旧值缓存死在内存里 ✗
 *   ③ 「轮换」这个概念也共享：谁轮换都行，但**同一时刻只能有一个当前会话**
 */
import fs from 'node:fs'
import path from 'node:path'

/** 这条鱼的身体状态存在哪（两个入口用同一个文件） */
export function bodyFile(dshHome) {
  return path.join(dshHome || '.', 'whale-body.json')
}

/** 兼容老位置：B 站原来用 whale-session.json */
function legacyBiliFile(dshHome) {
  return path.join(dshHome || '.', 'whale-session.json')
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

/** 本地日期 key */
function dayKeyOf(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 读「这条鱼现在在哪个对话里」。
 *
 * 优先级（很重要，别乱改）：
 *   ① whale-body.json —— 唯一权威
 *   ② whale-session.json —— B 站的老文件，第一次迁移时读一次
 *   ③ fallback —— 调用方给的默认值
 *
 * @returns {{ id: string, startedAt: number, rotatedFrom?: string, personaHash?: string,
 *             deliveredAt: number, rotatedBy?: string, from: string }}
 */
export function readBody({ dshHome, fallback = 'bili-whale', now = Date.now() } = {}) {
  const f = bodyFile(dshHome)
  const own = readJsonSafe(f)
  if (own && typeof own.id === 'string' && own.id) {
    const out = {
      id: own.id,
      startedAt: Number(own.startedAt) || Number(now),
      deliveredAt: Number(own.deliveredAt) || 0,
      from: 'whale-body',
    }
    if (own.rotatedFrom) out.rotatedFrom = own.rotatedFrom
    if (own.personaHash) out.personaHash = own.personaHash
    if (own.rotatedBy) out.rotatedBy = own.rotatedBy
    return out
  }
  // ② 从 B 站的老文件迁移一次
  const legacy = readJsonSafe(legacyBiliFile(dshHome))
  if (legacy && typeof legacy.id === 'string' && legacy.id) {
    const out = {
      id: legacy.id,
      startedAt: Number(legacy.startedAt) || Number(now),
      deliveredAt: Number(legacy.deliveredAt) || 0,
      from: 'whale-session(legacy)',
    }
    if (legacy.rotatedFrom) out.rotatedFrom = legacy.rotatedFrom
    if (legacy.personaHash) out.personaHash = legacy.personaHash
    // 顺手迁移到新文件 —— 之后两边都读这里
    try { saveBody({ dshHome, body: out, who: 'core:migrate' }) } catch { /* 迁移失败不影响读 */ }
    return out
  }
  // ③ 全新机器
  return { id: fallback, startedAt: Number(now), deliveredAt: 0, from: 'fallback' }
}

/**
 * 写回「现在这个对话」。
 * @param {object} p
 * @param {string} p.dshHome
 * @param {object} p.body    至少含 id
 * @param {string} [p.who]   谁写的（bili / qq），排查用
 */
export function saveBody({ dshHome, body, who = '' } = {}) {
  if (!body || typeof body.id !== 'string' || !body.id) throw new Error('saveBody 需要一个带 id 的 body')
  const cur = readJsonSafe(bodyFile(dshHome)) ?? {}
  const next = {
    id: body.id,
    startedAt: Number(body.startedAt) || Date.now(),
    deliveredAt: Number(body.deliveredAt) || 0,
    updatedAt: Date.now(),
  }
  const rotatedFrom = body.rotatedFrom ?? cur.rotatedFrom
  const personaHash = body.personaHash ?? cur.personaHash
  if (rotatedFrom) next.rotatedFrom = rotatedFrom
  if (personaHash) next.personaHash = personaHash
  if (who) next.rotatedBy = who
  writeJsonSafe(bodyFile(dshHome), next)
  return next
}

/**
 * 这条鱼该不该换新对话？
 *
 * ⚠️ 2026-11-04：轮换规则也**必须共享**。
 *   原来两边各自判断各自轮换，结果一天换两次、或者一边换了另一边不知道 ✗
 *   现在只按 `startedAt`（同一个数）算，谁先跑到谁换，另一个下次读到的就是新 id ✓
 *
 * @param {object} p
 * @param {string} p.dshHome
 * @param {number} p.rotateDays  0 = 不换
 * @param {number} [p.now]
 * @param {string} [p.fallback]
 * @returns {{ rotate: boolean, reason: string, body: object }}
 */
export function shouldRotateBody({ dshHome, rotateDays = 0, now = Date.now(), fallback = 'bili-whale' } = {}) {
  const body = readBody({ dshHome, fallback, now })
  const days = Number(rotateDays)
  if (!Number.isFinite(days) || days <= 0) return { rotate: false, reason: '没开轮换', body }
  const diffDays = (new Date(dayKeyOf(now) + 'T00:00:00') - new Date(dayKeyOf(body.startedAt) + 'T00:00:00')) / 86400000
  if (diffDays < days) {
    return { rotate: false, reason: `这段对话才 ${diffDays} 天（要满 ${days} 天）`, body }
  }
  // 刚说完话就别换（避免"话说到一半换了上下文"）
  if (body.deliveredAt && now - body.deliveredAt < 8 * 60000) {
    return { rotate: false, reason: '刚投递过不到 8 分钟，等会儿再换', body }
  }
  return { rotate: true, reason: `已经 ${diffDays} 天（满 ${days} 天）`, body }
}

/**
 * 生成新的会话 id 并写回共享文件。
 * @returns {{ id: string, rotatedFrom: string }}
 */
export function rotateBody({ dshHome, who = '', now = Date.now(), fallback = 'bili-whale', newId } = {}) {
  const old = readBody({ dshHome, fallback, now })
  const id = newId || `${who || 'whale'}-${now}-${Math.random().toString(16).slice(2, 10)}`
  saveBody({
    dshHome,
    who,
    body: {
      id,
      startedAt: now,
      deliveredAt: 0,
      rotatedFrom: old.id,
      personaHash: null,     // 新对话要重新注入人设
    },
  })
  return { id, rotatedFrom: old.id }
}

/**
 * 两边记忆状态的体检 —— 控制台拿它来显示「她现在是同一个人吗」
 * @returns {{ sameId: boolean, id: string, from: string, startedAt: number, ageDays: number }}
 */
export function bodyStatus({ dshHome, now = Date.now(), fallback = 'bili-whale' } = {}) {
  const body = readBody({ dshHome, fallback, now })
  const diffDays = (new Date(dayKeyOf(now) + 'T00:00:00') - new Date(dayKeyOf(body.startedAt) + 'T00:00:00')) / 86400000
  return {
    id: body.id,
    from: body.from,
    startedAt: body.startedAt,
    ageDays: diffDays,
    rotatedFrom: body.rotatedFrom ?? null,
    deliveredAt: body.deliveredAt ?? 0,
  }
}
