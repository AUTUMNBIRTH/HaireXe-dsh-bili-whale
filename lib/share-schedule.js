/**
 * 独立推荐调度（2026-11-01 主人要求：推荐和「醒来」解耦）
 *
 * 原来：推荐视频挂在生物钟醒来那一轮里（醒来 = 干活九步流程）
 *   → 主人说得对：这样"醒"就被推荐绑死了，醒来只为了看视频 ✗
 *
 * 现在：推荐有自己的时段和额度 ✓
 *   · `night.share.windows` 里的每一段 → 到点就排一次「来推荐一条」
 *   · 一天最多 `night.share.perDay` 条（默认 2）
 *   · 和生物钟醒来**互相独立**：醒了不一定推荐，推荐的时候也不占用「醒来」次数
 *
 * 账本是独立的 `whale-share-plan.json`，只记日期 + 当天已排/已发几条。
 */

import { occurrences } from '../tools/lib/night-plan.mjs'

const dayOf = (value = Date.now()) => new Date(value).toLocaleDateString('sv-SE')

/** 今天已经推荐过几条（只读账本 ✓ 不碰网络） */
export function shareUsedToday(readJson, file, now = Date.now()) {
  try {
    const led = readJson(file) ?? {}
    const day = dayOf(now)
    if (led.date !== day) return 0
    return Number(led.count ?? 0) || 0
  } catch { return 0 }
}

/** 记一次（真的发出去了才记 ✓） */
export function markShare(writeJson, readJson, file, now = Date.now()) {
  try {
    const day = dayOf(now)
    const led = readJson(file) ?? {}
    const count = led.date === day ? (Number(led.count ?? 0) || 0) : 0
    writeJson(file, { date: day, count: count + 1, at: new Date(now).toISOString() })
    return count + 1
  } catch { return 0 }
}

/**
 * 现在该不该排一次推荐（纯函数，便于测试 ✓）
 * @returns {{due:boolean, window?:string, reason?:string}}
 */
export function shareDue(cfg, ledger, now = Date.now()) {
  const s = cfg?.share ?? {}
  if (s.enabled === false) return { due: false, reason: 'share.enabled = false' }
  const perDay = Number.isFinite(Number(s.perDay)) ? Number(s.perDay) : 2
  if (!(perDay > 0)) return { due: false, reason: 'share.perDay = 0' }
  const used = Number(ledger?.count ?? 0) || 0
  if (ledger?.date === dayOf(now) && used >= perDay) return { due: false, reason: `今天已推荐 ${used}/${perDay} 条` }
  // 用同一套窗口展开逻辑（支持跨午夜），但只取「已经开始且还没结束」的那些
  const wins = occurrences({ windows: s.windows }, now)
    .filter((w) => w.startsAt <= now && w.endsAt > now)
    .sort((a, b) => a.endsAt - b.endsAt)
  if (!wins.length) return { due: false, reason: '不在推荐时段' }
  // 同一时段今天排过就不再排（账本里记了 windowKey 列表）
  const done = Array.isArray(ledger?.windows) && ledger.date === dayOf(now) ? ledger.windows : []
  const w = wins.find((x) => !done.includes(x.key))
  if (!w) return { due: false, reason: '今天的推荐时段都处理过了' }
  return { due: true, window: w.label, windowKey: w.key }
}

/** 排过之后记下这个时段（避免同一段里反复排） */
export function markShareWindow(writeJson, readJson, file, windowKey, now = Date.now()) {
  try {
    const day = dayOf(now)
    const led = readJson(file) ?? {}
    const windows = led.date === day && Array.isArray(led.windows) ? [...led.windows] : []
    if (!windows.includes(windowKey)) windows.push(windowKey)
    writeJson(file, { ...led, date: day, windows, at: new Date(now).toISOString() })
  } catch {}
}

/** 塞进唤醒提示里的「该推荐了」那一段 */
export function sharePromptLines(ownerTitle = '主人', replyFile = '') {
  return [
    '',
    '【该推荐一条了】',
    `到点了，该给「${ownerTitle}」挑一条视频了 —— 这是单独的一次，不算你「醒来」那一趟。`,
    '  规则：',
    '   · feed 选题 → `debrief --no-frames` 看素材 → **必须再跑一次带抽帧的 debrief 看画面** ✓',
    '     （标题和标签不算证据：今天就有过「猫猫洗澡」点开是猫娘泡澡 ✗）',
    '   · 合格才推：真人、可爱、正经；不是就换一条',
    '   · 分享走评论区 @（`comment --share ...`），口气像私聊，@ 放结尾 ✓',
    '   · 发完必须回读复核；看不到就老实说，别报"已发布" ✓',
    '   · 一天没东西可推也正常，**不推不是失职** ✓',
    '   · 推完接着写日记就行，不用把整趟九步流程重跑一遍',
    '',
  ]
}
