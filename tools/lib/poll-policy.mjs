// 正常空闲保持基础间隔；仅连续失败退避，最长 MAX_BACKOFF_SEC（默认 180 秒 = 3 分钟）。
// 2026-10-30 改：下限 15s → 5s。主人要求私信「像正常聊天一样」，15 秒最低档太慢。
// 2026-11-02 改：失败退避上限 900s（15 分钟）→ 180s（3 分钟）✗ 太久了
//   主人问「失败后要等下一轮（最多推到 15 分钟）这个可以调短吗」
//   原来连续失败 8 轮后要等 15 分钟才重试一次 —— 网络一抖就是十几分钟收不到消息 ✓
//   现在最多等 3 分钟；仍然保留指数退避（防刷平台），只是封顶更低 ✓
//   ⚠️ 读预算（traffic.mjs 的 readHourly / readDaily）仍在那儿把关 ✓
const MAX_BACKOFF_SEC = 180

export function pollDelay(baseSeconds, failureRounds = 0) {
  const value = Number(baseSeconds)
  const base = Number.isFinite(value) && value > 0 ? Math.max(5, value) : 60
  const rounds = Number.isFinite(failureRounds) ? Math.min(8, Math.max(0, failureRounds)) : 0
  return Math.min(Math.max(base, MAX_BACKOFF_SEC), base * 2 ** rounds) * 1000
}
