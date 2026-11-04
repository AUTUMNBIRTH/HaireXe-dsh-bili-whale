import { AuthError, createCredentialStore, parseManualCookie } from './credentials.js'
import { QrAuth, verifyAccount } from './auth.js'
import { guardedFetch as fetch, RISK_DEFAULTS } from '../tools/lib/traffic.mjs'
/**
 * dsh-bili-whale —— 宿主侧插件（设置壳）
 *
 * 职责只有三件：
 *   1. 设置页：DSH 客户端 section「设置 → 养鱼」（lib/client.js）
 *   2. 配置读写：GET/POST /dsh-bili/api/settings → 读写 ~/.dsh/bili-whale.config.json
 *      （与 bilibili-tools 里的 lib/config.mjs 共用同一份文件 —— 不搞两套配置）
 *   3. 依赖体检：GET /dsh-bili/api/deps → 跑 `node <tools>/bili.mjs deps --json`
 *      （这就是"装完之后让 agent/用户自己确认依赖能不能用"）
 *
 * 凭据（cookie）**单独写**到 ~/.bili-ai/credentials.json，且**永远不回显**。
 *
 * 所有路由都过一遍 connection.requestRejection 的信任栅栏：DSH 的 Web 端口是回环地址，
 * 但浏览器里任何一个网页都能向回环发请求 —— 不加栅栏等于把配置与账号凭据开放给任意页面。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { startScheduler } from './scheduler.js'
import { resolveWorkDir } from './work-dir.js'
import { resolveNodeRuntime, nodeEnv } from './node-runtime.js'
import { HOME, DSH_HOME, configPath, credentialsPath } from '../tools/lib/paths.mjs'

/**
 * 2026-11-04：主通道 / 私聊归谁 / 动态归谁 —— 规则跟 core 共用一份，不在这儿重写 ✗
 * ⚠️ 走**动态 import**：core 没装的时候不能因为这个 import 把整个 B 站插件拽塌 ✗
 *
 * ⚠️ 2026-11-04 晚：主人说「dsh-whale-core 这个库不要，那两个库里分别放一个就行」。
 *   所以 core 现在**自带在本仓库的 core/ 目录里**（跟着插件一起装）。
 *   查找顺序因此改成「先找自己带的，再找独立安装的」——
 *   这样单装任何一边都能活 ✓
 */
const CORE_SEARCH = () => {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return [
    // ① 本仓库自带的（install.mjs 会把整个仓库拷到 plugins/dsh-bili-whale，所以这里也在）
    path.join(HERE, '..', 'core', 'lib'),
    // ② dep/link 安装（老方式）
    path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-whale-core', 'lib'),
    // ③ 历史上单独装的
    path.join(dshHome, 'whale-core', 'lib'),
    path.join(dshHome, 'plugins', 'whale-core', 'lib'),
  ]
}

let SHARED_RULES = null
async function loadSharedRules() {
  if (SHARED_RULES) return SHARED_RULES
  for (const dir of CORE_SEARCH()) {
    const file = path.join(dir, 'shared.js')
    if (!fs.existsSync(file)) continue
    try { SHARED_RULES = await import(pathToFileURL(file).href); return SHARED_RULES } catch { /* 下一个 */ }
  }
  try {
    SHARED_RULES = await import('dsh-whale-core/shared')
    return SHARED_RULES
  } catch { return null }
}

/**
 * 把自带的 core 挂到 DSH 里（2026-11-04 晚）
 *
 * 为什么需要这个：DSH 只加载 profile 里登记的 bundle，内嵌在插件子目录里的 core
 * 不会自动被加载 —— 结果总控制台的 /dsh-whale/api/* 全部 404 ✗（实测过）
 *
 * 做法：ctx.plugin(插件对象) —— cordis 的标准挂法，会走完整的注入/生命周期 ✓
 * 拿不到 ctx.plugin 就退一步手动调 apply（这样至少路由挂得上）。
 *
 * 失败不影响插件自己：B站 本来就该能独立工作 ✓
 */
async function mountBundledCore(ctx) {
  const file = path.join(HERE, '..', 'core', 'lib', 'index.js')
  if (!fs.existsSync(file)) return false
  let mod = null
  try { mod = await import(pathToFileURL(file).href) } catch (e) {
    console.log(`[bili-whale] 自带 core 加载失败（不影响 B 站自己）：${e?.message ?? e}`)
    return false
  }
  const plugin = mod?.default
  if (!plugin || typeof plugin.apply !== 'function') return false
  try {
    if (typeof ctx.plugin === 'function') {
      ctx.plugin(plugin)
      return true
    }
    // 兜底：没有 ctx.plugin 就手动 apply（注入的服务用 get 拿）
    plugin.apply(ctx)
    return true
  } catch (e) {
    console.log(`[bili-whale] 挂载自带 core 失败（不影响 B 站自己）：${e?.message ?? e}`)
    return false
  }
}

/** 生物钟状态：{ ok, reason, at } —— 设置页/体检用它回答「时钟是不是活的」 */
let SCHED_STATUS = { ok: false, reason: "未初始化", at: null }



/**
 * execFile 的安全包装：NODE_EXE 解析失败时不让 execFile(null, …) 抛 TypeError，
 * 而是把原因通过回调交给调用方（设置页就能显示真因，而不是一个空 stdout）。
 */
function execNode(args, options, cb) {
  if (!NODE_EXE) {
    const msg = globalThis.__biliWhaleNodeError || '未找到可用的 node 运行时'
    cb?.(new Error(msg), '', msg)
    return null
  }
  return execFile(NODE_EXE, args, { ...options, env: { ...nodeEnv(DSH_HOME), ...options?.env } }, cb)
}


// 2026-10-19：真 node 路径（Electron 的 process.execPath 是 Harness.exe ✗ 跑不了 node 脚本）
const NODE_EXE = (() => {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    return resolveNodeRuntime(dshHome)
  } catch (e) {
    // 不静默回退：process.execPath 在桌面端是 Electron 主程序，跑不了脚本。
    // 这里只记录，具体失败由各调用点按自身语义报出（设置页体检会显示原因）。
    globalThis.__biliWhaleNodeError = String(e?.message ?? e)
    return null
  }
})()

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CFG_FILE = configPath
const CRED_FILE = credentialsPath
// 2026-10-21 修 Issue #6：她的会话工作目录必须是**专用小目录**，不能用用户主目录 ✗
//   原因：DSH 的 Windows 沙箱会把会话 cwd 当"工作区"，主目录当工作区会让权限/完整性标签
//   影响到主目录下的其它程序（实测有人 DSH / VS Code 起不来）✗
//   放在 ~/.dsh/whale-work 里，范围最小，也不会碰任何别的东西 ✓
const WORK_DIR = path.join(DSH_HOME, 'whale-work')


/** 默认配置（与 lib/config.mjs 的中性默认对齐；这里多一个 toolsPath） */
const DEFAULTS = {
  sessionRotateDays: 0,
  personaOncePerSession: false,
  risk: RISK_DEFAULTS,
  owner: { mid: '', name: '' },
  night: {
    windows: [{ start: '20:00', end: '24:00', wakes: 1 }],
    skipChance: 0.3,
    minGapMin: 10, maxVideos: 5,
  },
  preferences: {
    like: ['DSH/AI 工具与插件', '鬼畜与怀旧向剪辑', '猫咪', 'Live2D/模型', 'B站生态八卦'],
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
    keywords: [],
  },
  quota: { shareDaily: 3 },
  diary: { push: true, enabled: true },   // 2026-10-20：写日记不可关；只留"要不要推送"一个开关
  // ④ 2026-10-18：补上 persona / self（和 tools/lib/config.mjs 对齐 ✓ 否则设置页首次打开是空的 ✗）
  persona: { name: '', ownerTitle: '主人', selfClaim: '我' },
  self: { mid: '', name: '' },
  notify: { type: 'none', url: '', template: 'text', cmd: '' },
  listen: { comment: true, commentIntervalSec: 60, scope: 'both', oncePerPerson: false, allDay: false, dm: false, live: false, liveRoom: '', liveScope: 'owner' },
  share: { aiCommentGuard: false, aiThreshold: 30, enabled: true, via: 'comment', minScore: 13, silentAfterDays: 3, },
  toolsPath: '',
}

const clone = (o) => JSON.parse(JSON.stringify(o))
const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v
  }
  return out
}

/** 工具链里 bili.mjs 的位置：① 设置里的 toolsPath ② 插件自带的 tools/ ③ 开发目录 */
function resolveBiliMjs() {
  const cfg = readConfig()
  // 2026-10-18：去掉"作者机器"回退 ✗（换机器就是静默失效）→ 只有两个候选：设置里的 toolsPath / 插件自带 tools/ ✓
  return cfg.toolsPath || path.join(HERE, '..', 'tools', 'bili.mjs')
}

// ⚠️ 2026-11-04 主人要求：「只要配置或改动了一种养鱼方式的设置，另一种养鱼方式的
//   相同设置就会同步更新（比如人格，作息），保证连贯性」
//
//   所以读配置时**叠一层共享习惯**（~/.dsh/whale-habits.json）。
//   那几项（作息/主动/口味/人设/轮换）只有一份，两边看同一个值 ✓
//
//   core 不在的时候要能独立跑 → 用 try 兜住，拿不到就用自己配置里的值
let habitsMod = null
async function getHabits() {
  if (habitsMod !== null) return habitsMod
  // ⚠️ 2026-11-04：core 现在自带在 core/ 里，先找自己那份 ✓
  for (const dir of CORE_SEARCH()) {
    const file = path.join(dir, 'habits.js')
    if (!fs.existsSync(file)) continue
    try { habitsMod = await import(pathToFileURL(file).href); return habitsMod } catch { /* 下一个 */ }
  }
  try { habitsMod = await import('dsh-whale-core/habits') } catch { habitsMod = false }
  return habitsMod
}
/** 同步版：初次启动时预加载过就能用 */
function habitsNow() {
  return habitsMod || false
}

function readConfigRaw() {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch { /* 没配就用默认 */ }
  return { ...merge(DEFAULTS, user), __hasUserFile: Object.keys(user).length > 0 }
}

function readConfig() {
  const base = readConfigRaw()
  const hm = habitsNow()
  if (!hm) return base
  try {
    // 第一次用的时候，先把两边既有配置迁进来（之后就是唯一来源）
    hm.ensureHabits({ dshHome: DSH, biliCfg: base })
    const habits = hm.readHabits({ dshHome: DSH })
    return { ...hm.applyHabits({ cfg: base, habits }), __hasUserFile: base.__hasUserFile, __habits: habits }
  } catch (e) {
    return base    // 共享层出问题不能把插件拖死
  }
}

function writeConfig(next) {
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true })
  fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2) + '\n')
  // 写的时候把"习惯"那几项也同步进共享文件 —— 这样 QQ 那边立刻看到 ✓
  const hm = habitsNow()
  if (hm) {
    try {
      const patch = hm.pickHabits(next)
      if (Object.keys(patch).length) hm.saveHabits({ dshHome: DSH, patch, who: 'bili' })
    } catch { /* 同步失败不影响本地保存 */ }
  }
}

/** 只回"能不能用"，不回显任何凭据内容 */
function credState() {
  try {
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
    return { present: true, hasSess: !!c.sessdata, hasJct: !!c.bili_jct, hasBuvid: !!c.buvid3 }
  } catch { return { present: false, hasSess: false, hasJct: false, hasBuvid: false } }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export default {
  name: 'dsh-bili-whale',
  // ⚠️ 2026-10-18 踩的坑：这里以前**写了两个 inject 键** ✗ —— 对象字面量后者覆盖前者 →
  //   `sessionController` 没被注入 → 生物钟每 60 秒静默 `return`（不报错、也不干活 ✗）
  //   一个数组写全 ✓
  inject: ['sessionController', 'webServer', 'connection'],
  apply(ctx) {

// ⚠️ 2026-11-04 晚：主人说「dsh-whale-core 这个库不要，那两个库里分别放一个就行」。
//   所以 core 内嵌在本仓库的 core/ 目录里。
//
//   ⚠️ 但"放在目录里"≠"会被加载" —— DSH 只加载 profile 里登记的 bundle，
//     藏在插件子目录的 core 没人管，结果总控制台接口 404 ✗（实测过）
//   所以插件自己把它挂起来：apply 时 require 自带的 core 插件，用 ctx.plugin() 注入 ✓
//
//   两份 core（B站 和 QQ 各带一份）同时存在时，core 里有单例锁，只有第一个真正挂载 ✓
void mountBundledCore(ctx)

// ⚠️ 2026-11-04：预加载共享习惯层（readConfig 是同步的，没法在里面 await）。
//   这里 deliberately 不 await —— 加载完会把 habitsMod 填上，
//   在这之前 readConfig 读到的就是本地配置（不会崩，只是暂时没同步）✓
void getHabits()

/** 回环快速通道：Host 是 127.0.0.1/localhost/[::1] 时直接算可信。
 *  非回环不能在这里一刀切 —— DSH 允许 `--host <局域网地址>` 部署，
 *  合法浏览器访问时 Host 必然非回环。完整信任判定见 isTrustedReq。 */
function isLoopbackReq(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

/** 信任判定沿用 DSH 的 Host/Origin 栅栏：回环、监听绑定地址、trustedHosts 都放行；
 *  连接服务不可用时退回"仅回环"（fail-closed）。放行 Host 不等于放行请求 ——
 *  后面的 requestRejection 仍会校验登录态（未认证返回 401）。 */
function isTrustedReq(req) {
  if (isLoopbackReq(req)) return true
  try {
    const conn = ctx.get('connection') || ctx.connection
    if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
  } catch {}
  return false
}

    // P1-1（Kimi 评审 #8）：这条路以前是 fail-open —— connection 缺失/抛错就**放行** ✗
    // 安全组件的默认值必须是"关"：栅栏不可用 → 拒绝（写操作尤其），只对静态页面留一条活路。
    function rejected(req, res, { strict = true } = {}) {
      if (isTrustedReq(req) === false) {
        json(res, 403, { ok: false, error: '不受信任的访问来源' })
        return true
      }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          if (!rejected.warned) {
            rejected.warned = true
            console.warn('[bili-whale] 信任栅栏不可用：connection 服务缺失 → 按 fail-closed 处理')
          }
          if (strict) { json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' }); return true }
          return false
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch (e) {
        if (strict) { json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' }); return true }
        return false
      }
    }

    const disposers = []
    function route(kind, pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind,
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch {}
          }
        },
      }))
    }

    // 旧的独立设置页已下线（2026-10-18）：DSH 的信任栅栏不认插件路径，这个页面在浏览器里永远 403 ✗
    // 设置页唯一的入口是「设置 → 养鱼」（lib/client.js）。旧的 lib/settings.html 已删除（2026-10-22）✓
    // 需要本地直开时：把该文件拷到桌面双击（它的 API 调用会被栅栏拒，只作静态预览 ✓）

    // 写设置：浅合并，但**只接受已知的顶层字段** ✓（2026-10-18 加白名单，兑现这句注释 ✗ 原来是什么都收）
    // P0-2（Kimi 评审 #2）：读和写**合成一个 handler**（原来同一路径注册两次，
    //   宿主若是"首个匹配即终止"，后注册的 POST 永远收不到请求 ✗）
    route('exact', '/dsh-bili/api/settings', async (req, res) => {
      if (req.method === 'GET') { json(res, 200, { ok: true, config: readConfig(), credentials: credState(), configPath: CFG_FILE }); return }
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = JSON.parse(await readBody(req) || '{}')
      const cur = readConfig()
      delete cur.__hasUserFile
      // ⚠️ 2026-10-18 修的 bug：客户端发的是**配置本身**，这里却只认 `body.config` ✗
      //   → merge(cur, {}) = 什么都没改 → "保存成功"但值没变（主人实测就是这个 ✗）
      //   现在两种都收：{ config: {...} } 或直接 {...}
      const incoming = (body && typeof body.config === 'object' && body.config) || body || {}
      // 顶层白名单：只合并认识的键（防止被塞任意字段 ✓）
      // 2026-10-21 修（审查 #4）：原来白名单漏了 diary ✗ → 设置页「推送日记摘要」存不进去
      const KNOWN = new Set(['persona', 'preferences', 'notify', 'aliases', 'owner', 'self', 'quota', 'share', 'listen', 'diary', 'night', 'toolsPath', 'home', 'risk', 'sessionRotateDays', 'personaOncePerSession', 'proactiveChance', 'proactiveDailyMax', 'dynamicChance', 'dynamicDailyMax'])
      const filtered = {}
      for (const [k, v] of Object.entries(incoming)) if (KNOWN.has(k)) filtered[k] = v
      const next = merge(cur, filtered)
      const rotateDays = Number(next.sessionRotateDays)
      if (!Number.isFinite(rotateDays) || rotateDays < 0 || rotateDays > 365 || typeof next.personaOncePerSession !== 'boolean') {
        json(res, 400, { ok: false, error: '会话轮换天数须为 0–365；人设去重须为布尔值' }); return
      }
      next.sessionRotateDays = rotateDays
      // 2026-10-30 加：主动发消息的两个数（概率 0–1，每日上限 0–10 ✓）
      const pcRaw = next.proactiveChance
      const pc = pcRaw === undefined ? 0.2 : Number(pcRaw)
      if (!Number.isFinite(pc) || pc < 0 || pc > 1) { json(res, 400, { ok: false, error: '主动发消息概率须为 0–1' }); return }
      next.proactiveChance = pc
      const pm = Number(next.proactiveDailyMax ?? 1)
      if (!Number.isFinite(pm) || pm < 0 || pm > 10) { json(res, 400, { ok: false, error: '每天最多主动发几条须为 0–10' }); return }
      next.proactiveDailyMax = Math.floor(pm)
      // 2026-10-30 加：发动态的两个数（概率 0–1，每日上限 0–10 ✓）
      const dcRaw = next.dynamicChance
      const dc = dcRaw === undefined ? 0.3 : Number(dcRaw)
      if (!Number.isFinite(dc) || dc < 0 || dc > 1) { json(res, 400, { ok: false, error: '发动态概率须为 0–1' }); return }
      next.dynamicChance = dc
      const dm = Number(next.dynamicDailyMax ?? 1)
      if (!Number.isFinite(dm) || dm < 0 || dm > 10) { json(res, 400, { ok: false, error: '每天最多发几条动态须为 0–10' }); return }
      next.dynamicDailyMax = Math.floor(dm)
      // 基本的范围校验（别让设置页把东西写成负数/离谱值）
      const n = next.night
      if (!Array.isArray(n.windows) || !n.windows.length) { json(res, 400, { ok: false, error: '至少要有一个作息窗口' }); return }
      n.maxWakesPerDay = Math.min(12, Math.max(0, Number(n.maxWakesPerDay ?? 0) || 0))   // 12 = 与 whale-night 的上限一致 ✓
      n.skipChance = Math.min(0.95, Math.max(0, Number(n.skipChance) || 0))
      n.minGapMin = Number.isFinite(Number(n.minGapMin)) ? Math.max(1, Number(n.minGapMin)) : 10
      n.maxVideos = Math.min(20, Math.max(1, Number(n.maxVideos) || 5))
      // P0-3（Kimi 评审 #3）：Number(0) || 3 === 3 → 用户取消勾选"分享"会被强行改回 3 ✗
      const sd = Number(next.quota.shareDaily)
      next.quota.shareDaily = Number.isFinite(sd) ? Math.min(20, Math.max(0, sd)) : 3
      writeConfig(next)
      // 改完立刻生效 ✓（主人 2026-10-18 要求）：清掉旧计划，让生物钟按新配置重算
      const schedulingChanged = ['windows', 'skipChance', 'maxVideos', 'minGapMin'].some(key => JSON.stringify(cur.night?.[key]) !== JSON.stringify(next.night?.[key]))
      try { sched?.invalidate(schedulingChanged) } catch {}
      json(res, 200, { ok: true, config: next, warn: next.quota.shareDaily > 3 ? '分享条数 >3：看起来会像刷量，平台可能限流/封号' : null })
    })

    // Both login paths verify first and share one serialized, atomic credential writer.
    const credentialStore = createCredentialStore({
      file: CRED_FILE,
      pending: path.join(HOME, '.bili-ai', 'pending-replies.json'),
      verify: verifyAccount,
    })
    const saveLogin = async (credentials, options) => {
      const account = await credentialStore.save(credentials, options)
      try {
        const current = readConfig()
        delete current.__hasUserFile
        writeConfig({ ...current, self: account })
      } catch {
        // Credentials are already committed. Report success plus the secondary metadata warning.
        return { ...account, warn: '登录态已保存，但账号显示信息未更新；请重新读取或检查配置权限。' }
      }
      return account
    }
    const qrAuth = new QrAuth({ save: saveLogin })
    ctx.effect(() => () => qrAuth.dispose())
    const authRoute = (name, action) => route('exact', '/dsh-bili/api/auth/qr/' + name, async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const body = JSON.parse(await readBody(req) || '{}')
        const result = await action(body)
        json(res, 200, { ok: true, ...result })
      } catch (error) {
        json(res, error instanceof AuthError ? 400 : 503, {
          ok: false, error: error instanceof AuthError ? error.message : '登录操作失败，请稍后重试。',
        })
      }
    })
    authRoute('start', () => qrAuth.start())
    authRoute('poll', body => qrAuth.poll(String(body.id ?? '')))
    authRoute('cancel', body => qrAuth.cancel(String(body.id ?? '')))

    // Keep the original manual endpoint and paste formats as a fallback.
    route('exact', '/dsh-bili/api/cookie', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const body = JSON.parse(await readBody(req) || '{}')
        const credentials = parseManualCookie(body)
        qrAuth.cancel()
        const account = await saveLogin(credentials)
        json(res, 200, { ok: true, self: { mid: account.mid, name: account.name },
          detail: '已登录：' + account.name + '（mid ' + account.mid + '）', warn: account.warn ?? null })
      } catch (error) {
        json(res, 400, { ok: false, error: error instanceof AuthError ? error.message : '登录未保存，请检查输入后重试。' })
      }
    })

    // ── 她专属的人设（2026-10-21 主人要的）：只影响她，不影响别的会话 ✓ ──────────
    //   存在 ~/.bili-ai/persona.md → 换机器时连 .bili-ai 一起拷就带着走 ✓
    const PERSONA_FILE = path.join(HOME, '.bili-ai', 'persona.md')
    route('exact', '/dsh-bili/api/persona', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method === 'GET') {
        let text = ''
        try { text = fs.readFileSync(PERSONA_FILE, 'utf8') } catch {}
        let updatedAt = null
        try { updatedAt = fs.statSync(PERSONA_FILE).mtime.toISOString() } catch {}
        json(res, 200, { ok: true, text, bytes: Buffer.byteLength(text, 'utf8'), updatedAt })
        return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const text = String(b.text ?? '')
      if (text.length > 20000) { json(res, 400, { ok: false, error: '太长（上限 20000 字），人设不用写论文 ✗' }); return }
      try {
        fs.mkdirSync(path.dirname(PERSONA_FILE), { recursive: true })
        fs.writeFileSync(PERSONA_FILE, text, 'utf8')
        try { fs.chmodSync(PERSONA_FILE, 0o600) } catch {}
      } catch (e) { json(res, 500, { ok: false, error: '写入失败：' + String(e?.message ?? e).slice(0, 120) }); return }
      const bytes = Buffer.byteLength(text, 'utf8')
      json(res, 200, {
        ok: true,
        bytes,
        detail: text.trim()
          ? '✓ 已注入（' + bytes + ' 字节）—— 从下一次唤醒开始生效 ✓'
          : '✓ 已清空 —— 她回到只有「设置里的人设」那几行 ✓',
      })
    })

    // 依赖体检：跑 bili.mjs deps --json
    route('exact', '/dsh-bili/api/deps', async (req, res) => {
      const cfg = readConfig()
      // 工具位置（2026-10-18 收敛为两个候选 ✗ 去掉"作者机器"路径）：
      //   ① 设置里的 toolsPath  ② <插件根>/tools/bili.mjs（发布版自带 ✓）
      const tools = cfg.toolsPath || path.join(HERE, "..", "tools", "bili.mjs")
      if (!fs.existsSync(tools)) {
        json(res, 200, { ok: false, error: `找不到 bili.mjs：${tools}（在设置里填「工具目录」）`, items: [], scheduler: SCHED_STATUS })
        return
      }
      execNode([tools, 'deps', '--json'], { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
        try {
          const parsed = JSON.parse(String(stdout || '{}'))
          // 2026-10-19：顺手把"她自己是谁"从 cookie 体检里抠出来写回配置 ✓
          //   以前 self.mid / self.name 只有默认值、没人写 → 设置页永远空 ✗
          let selfNow = null
          try {
            const ck = (parsed.items ?? []).find((it) => it.name === 'B站 cookie')
            const m = String(ck?.detail ?? '').match(/已登录：(.+?)（mid (\d+)）/)
            if (m) {
              selfNow = { name: m[1], mid: m[2] }
              const cur = readConfig()
              if (String(cur.self?.mid ?? '') !== selfNow.mid || String(cur.self?.name ?? '') !== selfNow.name) writeConfig({ ...cur, self: selfNow })
            }
          } catch {}
          // 2026-10-20：把"跑没跑过启动测试"一起返回 —— 设置页用它决定要不要显示首次安装横幅
          let selftestPassed = false
          try {
            selftestPassed = fs.existsSync(path.join(HOME, ".bili-ai", "selftest-passed.json"))
          } catch {}
          json(res, 200, { ok: !!parsed.ok, items: parsed.items ?? [], node: parsed.node, self: selfNow, selftestPassed, scheduler: SCHED_STATUS })
        } catch {
          json(res, 200, { ok: false, error: String(stderr || err?.message || 'deps 跑失败').slice(0, 300), items: [] })
        }
      })
    })

    // ── 待审回复（2026-10-18 主人选 B 档：**发前审核**）──────────────────────────
    //   她的回复先进 pending-replies.json → 主人在「设置 → 养鱼 → 待审核」里点发才发 ✓
    const PENDING = path.join(HOME, '.bili-ai', 'pending-replies.json')
    route('exact', '/dsh-bili/api/pending', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      let items = []
      try { items = JSON.parse(fs.readFileSync(PENDING, 'utf8')).items ?? [] } catch {}
      json(res, 200, { ok: true, items })
    })
    route('exact', '/dsh-bili/api/pending/reject', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const id = String(b.id ?? '')
      if (!id) { json(res, 400, { ok: false, error: '需要 id' }); return }
      execNode([resolveBiliMjs(), 'reply-draft', 'drop', id], { timeout: 20000, windowsHide: true }, (err, stdout) => {
        // 否掉也是一种反馈 → 记事件流（她下次能学到"这种不要" ✓）
        // ⚠️ 只有真的删掉了才记 ✗ —— 以前连点几次会重复记三条（2026-10-18 修 ✓）
        if (!err) {
          try {
            fs.appendFileSync(path.join(DSH_HOME, 'whale-log.jsonl'),
              JSON.stringify({ at: new Date().toISOString(), kind: 'reply-rejected', target: null, note: `主人否掉了草稿 ${id}${b.reason ? '：' + String(b.reason).slice(0, 80) : ''}` }) + '\n')
          } catch {}
        }
        json(res, 200, { ok: !err, out: String(stdout ?? '').slice(0, 300) })
      })
    })
    route('exact', '/dsh-bili/api/pending/approve', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const id = String(b.id ?? '')
      if (!id) { json(res, 400, { ok: false, error: '需要 id' }); return }
      const bili = resolveBiliMjs()
      // 2026-10-21 修（审查 P1-2）：下面回调里用了 cfg.listen，但本作用域【没有 cfg】✗
      //   → ReferenceError，而草稿已被 take 掉 → 静默丢失 ✗
      let cfgNow = {}
      try { cfgNow = readConfig() } catch {}
      // ① 从队列取出（取不到 = 已经发过/删过 ✓）
      execNode([bili, 'reply-draft', 'take', id], { timeout: 20000, windowsHide: true }, (err, stdout) => {
        let item = null
        try { item = JSON.parse(String(stdout ?? '')) } catch {}
        if (!item) { json(res, 400, { ok: false, error: '队列里没有这条（可能已经发过）' }); return }
        // ② 真发（--auto → 自动报备 ✓；--once-per-person → 判重 ✓）
        const args = ['comment', '--oid', item.oid, '--root', item.root, '--parent', item.parent,
          '--message', item.message, '--auto', ...(cfgNow.listen?.oncePerPerson !== false ? ['--once-per-person'] : []), '--go']
        if (item.bvid) args.push('--bvid', item.bvid)
        execNode([bili, ...args], { timeout: 360000, windowsHide: true }, (e2, out2, err2) => {
          const text = String(out2 ?? '')
          const ok = !e2 && /code=0/.test(text)
          const rpid = (text.match(/rpid=(\d+)/) ?? [])[1] ?? null
          try {
            fs.appendFileSync(path.join(DSH_HOME, 'whale-log.jsonl'),
              JSON.stringify({ at: new Date().toISOString(), kind: ok ? 'reply-sent' : 'reply-failed', target: item.who || item.parent, note: `${ok ? '主人批准并发出' : '发送失败'} · ${String(item.message).slice(0, 60)}` }) + '\n')
          } catch {}
          // 2026-10-21：发送失败 → 草稿放回队列，别悄悄丢掉 ✗
          if (!ok) {
            try {
              const back = ['reply-draft', 'add', '--oid', item.oid, '--message', item.message]
              if (item.bvid) back.push('--bvid', item.bvid)
              if (item.root) back.push('--root', item.root)
              if (item.parent) back.push('--parent', item.parent)
              if (item.who) back.push('--who', item.who)
              if (item.src) back.push('--src', item.src)
              execNode([bili, ...back], { timeout: 20000, windowsHide: true }, () => {})
              console.error('[pending/approve] 发送失败，草稿已放回队列：' + id)
            } catch (e) { console.error('[pending/approve] 放回草稿也失败：' + e.message) }
          }
          json(res, 200, { ok, rpid, out: text.slice(-600), err: String(err2 ?? '').slice(0, 400) })
        })
      })
    })

    // 「发条测试」：真的跑一次 notify.mjs --test，把结果原样返回（配错了当场能看见 ✓）
    // 2026-10-18 主人要求：必须有这个按钮，不然配错了不知道 ✗
    route('exact', '/dsh-bili/api/notify-test', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const cfg = readConfig()
      const tools = cfg.toolsPath || path.join(HERE, "..", "tools", "bili.mjs")
      const notifyMjs = path.join(path.dirname(tools), 'commands', 'notify.mjs')
      if (!fs.existsSync(notifyMjs)) { json(res, 200, { ok: false, error: `找不到 notify.mjs：${notifyMjs}` }); return }
      execNode([notifyMjs, '--test'], { timeout: 330_000, windowsHide: true }, (err, stdout, stderr) => {
        json(res, 200, {
          ok: !err,
          out: String(stdout ?? '').slice(0, 800),
          err: String(stderr ?? '').slice(0, 800),
          type: cfg.notify?.type ?? 'none',
        })
      })
    })

    // ── 记忆导入 / 导出（2026-11-01 主人要求「控制台里加一个记忆导入功能」）──────
    //   POST /dsh-bili/api/backup/export  → 拷一份备份（等价 bili.mjs backup）
    //   POST /dsh-bili/api/backup/import  { from: "<备份目录>", sessions?: true }
    //        → 从备份目录恢复；默认不覆盖 sessions（对话全文），要覆盖得显式传 sessions:true
    //   GET  /dsh-bili/api/backup/inspect?dir=<路径>
    //        → 看一眼这个目录里有什么、能恢复几项（不动任何文件 ✓）
    //   ⚠️ 一律白名单 + 只拷不删；任何路径都要 resolve 后确认在允许范围内 ✓
    const BACKUP_WHITELIST = [
      ['.bili-ai/credentials.json', 'bili-ai/credentials.json'],
      ['.bili-ai/dev_id', 'bili-ai/dev_id'],
      ['.bili-ai/dm-await-state.json', 'bili-ai/dm-await-state.json'],
      ['.bili-ai/quota.json', 'bili-ai/quota.json'],
      ['.bili-ai/traffic-state.json', 'bili-ai/traffic-state.json'],
      ['.bili-ai/persona.md', 'bili-ai/persona.md'],
      ['.dsh/bili-whale.config.json', 'dsh/bili-whale.config.json'],
      ['.dsh/whale-diary.md', 'dsh/whale-diary.md'],
      ['.dsh/whale-diary-private.md', 'dsh/whale-diary-private.md'],
      ['.dsh/whale-rules.md', 'dsh/whale-rules.md'],
      ['.dsh/whale-proactive.json', 'dsh/whale-proactive.json'],
      ['.dsh/whale-share-plan.json', 'dsh/whale-share-plan.json'],
      ['.dsh/whale-dynamic.json', 'dsh/whale-dynamic.json'],
    ]
    const backupDirDefault = path.join(HOME, 'Desktop', '邦邦的备份')

    route('exact', '/dsh-bili/api/backup/inspect', async (req, res) => {
      const u = new URL(req.url, 'http://localhost')
      const dir = String(u.searchParams.get('dir') ?? backupDirDefault)
      const abs = path.resolve(dir)
      if (!fs.existsSync(abs)) { json(res, 200, { ok: false, error: '目录不存在：' + abs, items: [] }); return }
      const items = BACKUP_WHITELIST.map(([, rel]) => {
        const p = path.join(abs, rel)
        let ok = false, size = 0, mtime = null
        try { const st = fs.statSync(p); ok = st.isFile(); size = st.size; mtime = st.mtime.toISOString() } catch {}
        return { rel, ok, size, mtime }
      })
      const sessDir = path.join(abs, '记忆', 'sessions')
      const hasSessions = fs.existsSync(sessDir)
      json(res, 200, {
        ok: true, dir: abs, items, hasSessions,
        canRestore: items.filter((i) => i.ok).length,
        total: items.length,
      })
    })

    route('exact', '/dsh-bili/api/backup/export', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const dir = path.resolve(String(b.to ?? backupDirDefault))
      let n = 0, miss = 0
      try {
        for (const [srcRel, dstRel] of BACKUP_WHITELIST) {
          const src = path.join(HOME, srcRel)
          const dst = path.join(dir, dstRel)
          if (!fs.existsSync(src)) { miss += 1; continue }
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          fs.copyFileSync(src, dst)
          n += 1
        }
        // 对话全文
        const sess = path.join(DSH_HOME, 'sessions')
        if (fs.existsSync(sess)) {
          try { fs.cpSync(sess, path.join(dir, '记忆', 'sessions'), { recursive: true }) ; n += 1 } catch {}
        }
      } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e).slice(0, 200) }); return }
      json(res, 200, { ok: true, dir, copied: n, missing: miss, at: new Date().toISOString() })
    })

    route('exact', '/dsh-bili/api/backup/import', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const b = JSON.parse(await readBody(req) || '{}')
      const from = String(b.from ?? '').trim()
      if (!from) { json(res, 400, { ok: false, error: '要传 from（备份目录路径）' }); return }
      const abs = path.resolve(from)
      if (!fs.existsSync(abs)) { json(res, 400, { ok: false, error: '目录不存在：' + abs }); return }
      const dryRun = b.dry !== false   // 默认只预演 ✓ 要真恢复得显式 dry:false
      let n = 0
      const done = []
      for (const [tgtRel, srcRel] of BACKUP_WHITELIST) {
        const src = path.join(abs, srcRel)
        if (!fs.existsSync(src)) continue
        const tgt = path.join(HOME, tgtRel)
        if (!dryRun) {
          fs.mkdirSync(path.dirname(tgt), { recursive: true })
          fs.copyFileSync(src, tgt)
        }
        done.push(tgtRel)
        n += 1
      }
      let sessions = 'not-requested'
      const sessSrc = path.join(abs, '记忆', 'sessions')
      if (b.sessions === true && fs.existsSync(sessSrc)) {
        sessions = 'copied'
        if (!dryRun) { try { fs.cpSync(sessSrc, path.join(DSH_HOME, 'sessions'), { recursive: true }) } catch (e) { sessions = 'failed: ' + String(e?.message ?? e).slice(0, 100) } }
      } else if (fs.existsSync(sessSrc)) sessions = 'skipped（要恢复对话记录请传 sessions:true）'
      json(res, 200, {
        ok: true, from: abs, dry: dryRun, restored: n, files: done, sessions,
        note: dryRun ? '预演完成，没有改动任何文件 ✓ 要真恢复请传 {"dry": false}' : '已恢复 —— 重启插件后生效 ✓',
      })
    })

    // 状态（只读）：今天分享了几条 / 今天的作息计划 / 判重账本里记了几个人
    route('exact', '/dsh-bili/api/status', async (req, res) => {
      const localHome = HOME
      const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
      const quota = readJson(path.join(localHome, '.bili-ai', 'quota.json')) ?? { log: [] }
      const today = new Date().toLocaleDateString('sv-SE')
      const todays = (quota.log ?? []).filter((x) => new Date(x.at).toLocaleDateString('sv-SE') === today)
      const night = readJson(path.join(DSH_HOME, 'whale-night.json'))
      const replied = readJson(path.join(localHome, '.bili-ai', 'replied.json'))
      json(res, 200, {
        ok: true, today,
        shares: todays.filter((x) => x.share).length,
        sharesMax: readConfig().quota?.shareDaily ?? 3,
        commentsToday: todays.length,
        repliedPeople: Object.keys(replied?.byUid ?? {}).length,
        plan: night ? { date: night.date, action: night.action, atText: night.atText ?? null, wakes: Number(night.wakes ?? 0), windows: night.usedWindows ?? [] } : null,
      })
    })

    // ── 自主生物钟（2026-10-18）：插件自己 tick，到点自己叫醒她（不靠对话框 ✓）────────
    let sched = null
    // 2026-10-21 修（Issue #8-3）：时钟起不来时以前只 console.warn ✗
    //   用户在设置页看不出「它永远不会醒」→ 现在把状态记下来，/deps 带出去 ✓
    try {
      sched = startScheduler(ctx, {
        dshHome: DSH_HOME,
        biliMjs: resolveBiliMjs(),
        cwd: resolveWorkDir(readConfig().home, WORK_DIR),
        sessionId: 'bili-whale',
        log: (m) => { try { console.log(m) } catch {} },
      })
      SCHED_STATUS = { ok: true, reason: '已启动（每 60 秒 tick）', at: new Date().toISOString() }
    } catch (e) {
      SCHED_STATUS = { ok: false, reason: String(e?.message ?? e).slice(0, 300), at: new Date().toISOString() }
      try { console.warn('[bili-whale] 生物钟启动失败：' + e.message) } catch {}
    }

    ctx.effect(() => () => {
      try { sched?.stop() } catch {}
      for (const d of disposers) { try { d() } catch {} }
    })

    try {
      console.log(`[bili-whale] 设置页已挂载：/dsh-bili/ · 配置 ${CFG_FILE}`)
    } catch {}

    // ── 2026-11-04：把自己登记成 whale-core 里的一个「通道」 ─────────────────
    //   目的只有一个：让 B 站和 QQ 能装进同一个 DSH、各自独立开关。
    //   ⚠️ 这一步**只登记**，不改任何现有行为：
    //      - 路由还是这些 /dsh-bili/api/*
    //      - 配置还是同一份 bili-whale.config.json
    //      - scheduler 还是在这儿启动（core 的 start 不重复拉它 ✗）
    //   core 没装的时候 import 会失败 —— 那就当没这回事，B 站自己照样跑 ✓
    registerChannelWithCore()
  },
}

/**
 * 找 dsh-whale-core 的注册表。
 *
 * ⚠️ 2026-11-04：link 安装时 pnpm 不给这个包建自己的 node_modules →
 *    裸 `import('dsh-whale-core/registry')` 会 ERR_MODULE_NOT_FOUND ✗
 *    所以先试裸 import，再从 DSH_HOME 下的常规位置找。都没装就当没有（不报错）✓
 */
function loadCoreRegistry() {
  return import('dsh-whale-core/registry').then((m) => m.getRegistry()).catch(() => {
    // ⚠️ 2026-11-04 晚：core 现在自带在 core/ 里，先找自己那份（CORE_SEARCH 统一维护）
    const candidates = CORE_SEARCH().map((d) => path.join(d, 'registry.js'))
    return candidates.reduce((p, file) => p.then((found) => found ?? (
      fs.existsSync(file)
        ? import(pathToFileURL(file).href).then((m) => m.getRegistry?.() ?? null).catch(() => null)
        : null
    )), Promise.resolve(null))
  })
}

/**
 * **同步**拿 core 的注册表 —— apply() 里用它，避免「登记晚于 core 挂路由」那个窗口。
 *
 * 为什么必须同步：DSH 的 Loader 用 Promise.all 并行 create 所有条目，
 * 一旦这里 await，就可能出现「core 的 prefix 路由已挂、请求已到、bili 还没登记」的瞬间 → 404 ✗
 * registry.js 把表挂在 globalThis 上（Symbol.for），所以 require 进来就是同一张表 ✓
 */
function loadCoreRegistrySync() {
  const KEY = Symbol.for('dsh-whale-core.registry.v1')
  const table = globalThis[KEY]
  if (table?.__register) {
    return {
      register: (...a) => table.__register(...a),
      get: (id) => table.get(String(id)),
      list: () => [...table.values()],
    }
  }
  // ⚠️ 2026-11-04 晚：core 现在自带在 core/ 里，先找自己那份（CORE_SEARCH 统一维护）
  const candidates = CORE_SEARCH().map((d) => path.join(d, 'registry.js'))
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    try {
      const mod = require(file)
      if (typeof mod.getRegistry === 'function') return mod.getRegistry()
    } catch { /* 换下一个 */ }
  }
  return null
}

/** 把 B 站登记进 core 的通道表；core 不在就安静跳过 */
function registerChannelWithCore() {
  // ⚠️ 2026-11-04：原来这里是 `loadCoreRegistry().then(...)` —— 异步的。
  //   DSH 的 Loader 并行 create 所有插件条目，于是存在「core 已经把 prefix 路由挂上、
  //   浏览器已经开始打请求，而 bili 还没登记」的窗口 → 那一刻 /channels/bili/config 是 404 ✗
  //   （和 QQ 那边是同一个毛病，见 dsh-qq-whale/lib/index.js 里 loadCoreRegistrySync 的注释）
  //   改成**同步**登记：core 的注册表挂在 globalThis 上，require 进来就是同一张表 ✓
  const registry = loadCoreRegistrySync()
  if (!registry) return   // 没装 core：这不是错误，是最常见的安装方式 ✓
  try {
    ChannelUnregister = registry.register({
      id: 'bili',
      label: 'B 站',
      emoji: '💭',
      order: 10,
      description: '刷 B 站、看懂视频、写两本日记、把值得的 @ 你。',
      home: WORK_DIR,
      defaultEnabled: true,
      // 配置就是老那份，不搬家：十几个工具脚本直接读它 ✓
      configFile: CFG_FILE,
      needsLogin: true,
      // 生物钟由本文件启动（见上面 startScheduler 那段），所以这里不提供 start，
      // 免得「开关一次就起两个调度器」✗
      start: null,
      deps: async () => {
        const items = []
        items.push({ name: 'cookie', ok: fs.existsSync(path.join(HOME, '.bili-ai', 'credentials.json')), detail: 'B 站登录态' })
        items.push({ name: '工具链', ok: fs.existsSync(resolveBiliMjs()), detail: resolveBiliMjs() })
        items.push({ name: '生物钟', ok: SCHED_STATUS.ok === true, detail: SCHED_STATUS.reason })
        return { ok: items.every((i) => i.ok), items }
      },
      routes: {
        'GET /status': async (req, res, { json }) => {
          try {
            const cap = await readOwnCapabilities()
            json(res, 200, { ok: true, scheduler: SCHED_STATUS, caps: cap })
          } catch {}
        },
      },
    })
    try { console.log('[bili-whale] 已登记到 dsh-whale-core（通道 id=bili）') } catch {}
  } catch (e) {
    try { console.warn('[bili-whale] 登记到 core 失败（B 站自己照常跑）：' + (e?.message ?? e)) } catch {}
  }
}

/**
 * 2026-11-04（主人：「用QQ的时候哔站只有分享视频功能和收到消息能用」）：
 * 读 core 的共享配置，算出现在 B 站**能干什么**。
 *
 * ⚠️ 这里刻意**不缓存**：主人随时可能在控制台改，缓存了就出现「我明明关了它还在动」✗
 * ⚠️ 读不到 core 的配置时**当成全功能**（也就是老行为）—— 不能因为读不到就自己把自己关了 ✓
 */
export async function readOwnCapabilities() {
  const file = path.join(DSH_HOME, 'whale-channels', 'shared.json')
  let shared = {}
  try { shared = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 没配过就是默认 */ }
  const idx = (() => { try { return JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'whale-channels', 'index.json'), 'utf8')) } catch { return null } })()
  const enabled = {
    bili: idx?.channels?.bili?.enabled !== false,
    qq: idx?.channels?.qq?.enabled !== false,
  }
  // 用的是 core 同一套规则（shared.js），不在这儿重写一遍 ✗
  try {
    const rules = await loadSharedRules()
    if (!rules) throw new Error('没有 shared.js')
    return rules.capabilitiesFor('bili', { shared: rules.normalizeShared(shared), enabled })
  } catch {
    return { on: true, dm: true, share: true, dynamic: true, full: true, why: '共享配置读不出来，按全功能跑' }
  }
}

let ChannelUnregister = null


// 同步 require 用（loadCoreRegistrySync：apply 里不能在登记前 await）
const require = createRequire(import.meta.url)

