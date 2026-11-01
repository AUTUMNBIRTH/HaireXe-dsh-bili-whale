import fs from 'node:fs'
import path from 'node:path'
import { DSH_HOME } from './paths.mjs'

// 2026-11-01（主人要求「像人一样：有午休、晚上会睡觉；推荐和醒来解耦」）：
//   新增 share 段 —— 推荐视频单独按自己的时段跑，不再挂在「醒来」上 ✗
//     share.enabled      是否开启独立推荐
//     share.windows      推荐时段（可以一天多个窗口）
//     share.perDay       每天最多推荐几条（默认 2）
//     share.skipChance   一个窗口放过的概率（默认 0 = 到点就干活 ✓）
//   全部有默认值，旧配置文件不写这一段也照常跑（enabled 默认 true，一条默认时段）
const DEFAULT_SHARE_WINDOWS = [{ start: '10:00', end: '12:00' }, { start: '20:00', end: '22:00' }]

export function readNightConfig(home = DSH_HOME) {
  let user = {}, legacy = {}
  try { user = JSON.parse(fs.readFileSync(process.env.BILI_WHALE_CONFIG || path.join(home, 'bili-whale.config.json'), 'utf8')).night ?? {} } catch {}
  try { legacy = JSON.parse(fs.readFileSync(path.join(home, 'whale-night.config.json'), 'utf8')) } catch {}
  const merged = { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0.3, minGapMin: 10, maxVideos: 5, ...user, ...legacy }
  // share 段：优先读 night.share，其次读顶层 share.windows（兼容未来写法）
  const shareRaw = merged.share && typeof merged.share === 'object' ? merged.share : {}
  merged.share = {
    enabled: shareRaw.enabled !== false,
    windows: Array.isArray(shareRaw.windows) && shareRaw.windows.length ? shareRaw.windows : DEFAULT_SHARE_WINDOWS,
    perDay: Number.isFinite(Number(shareRaw.perDay)) ? Math.max(0, Math.floor(Number(shareRaw.perDay))) : 2,
    skipChance: Number.isFinite(Number(shareRaw.skipChance)) ? Number(shareRaw.skipChance) : 0,
    minGapMin: Number.isFinite(Number(shareRaw.minGapMin)) ? Number(shareRaw.minGapMin) : 60,
  }
  return merged
}
