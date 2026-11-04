/**
 * dsh-whale-core · 宿主侧入口
 *
 * 职责（只有这些）：
 *   1. 收集通道：所有已安装的通道插件在 apply 时往 registry 里登记 ✓
 *   2. 挂共用路由 /dsh-whale/api/*
 *        GET  /channels              已注册通道 + 开关状态
 *        POST /channels/<id>/enabled 开关一个通道（唯一会动 state 的入口）
 *        GET  /channels/<id>/config  读这个通道的配置
 *        POST /channels/<id>/config  写这个通道的配置（只动它自己那份文件）
 *        GET  /channels/<id>/deps    这个通道的依赖体检
 *        GET  /health                框架自己的状态
 *        + 通道自己声明的 routes（被包在 /channels/<id>/ 下面）
 *   3. 按开关拉起/停掉通道的 start()
 *
 * ⚠️ 信任栅栏照抄 B 站那边（见 dsh-bili-whale/lib/index.js 的注释）：
 *    回环地址不代表可信 —— 浏览器里任何网页都能向 127.0.0.1 发请求。
 */
import fs from 'node:fs'
import path from 'node:path'
import { list, get, describe } from './registry.js'
import { createChannelConfig } from './channel-config.js'
import { createRiskCounter } from './risk.mjs'
import { normalizeShared, capabilitiesFor, sharedWakeWindows, setupStateFor } from './shared.js'
import * as libHabits from './habits.js'
import * as libBody from './body.js'

const LIMIT = 1024 * 1024

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
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

function isLoopbackReq(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

/**
 * 把配置里的敏感字段换成掩码。通道自己声明哪些字段敏感（`secretPaths`），
 * 默认按名字猜：cookie / token / pass / secret / key / sessdata / bili_jct 之类。
 * 值本身不回显 —— 只告诉设置页「这里有没有填过」✓
 */
const SECRET_NAME_RE = /(cookie|token|pass(word|wd)?|secret|sessdata|bili_jct|buvid|api[_-]?key|access[_-]?key)/i
export function redact(entry, value, depth = 0) {
  if (depth > 8) return '…'
  if (Array.isArray(value)) return value.map((v) => redact(entry, v, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_NAME_RE.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length > 0) {
        out[k] = '******'
      } else {
        out[k] = redact(entry, v, depth + 1)
      }
    }
    return out
  }
  return value
}

export default {
  name: 'dsh-whale-core',
  // ⚠️ inject 只能写成一个数组字面量（见 dsh-bili-whale/lib/index.js 里 2026-10-18 那个坑：
  //    写两个 inject 键，后者覆盖前者 → 服务没注入 → 静默不干活 ✗）
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
    const log = (m) => { try { console.log(m) } catch {} }

    // ⚠️ 2026-11-04 晚：core 现在**内嵌在 B站 和 QQ 两个仓库里各一份**（主人：「那个库不要，
    //   那两个库里分别放一个就行」）。
    //
    //   问题：如果两个插件都装了，同一台机器上就有两份 core 都被加载 →
    //   同一批路由挂两次 → 404/409 或者重复启动通道 ✗
    //
    //   解决：**单例锁**。第一个 apply 的挂上并占据 Symbol；后来的直接让位 ✓
    //   （用 globalThis 的 Symbol 而不是模块变量 —— 两份是不同模块实例，变量不共享）
    const CORE_LOCK = Symbol.for('dsh-whale-core.mounted.v1')
    if (globalThis[CORE_LOCK]) {
      log('[whale-core] 已经由另一个入口挂载了，这份让位（不影响总控制台）')
      return
    }
    globalThis[CORE_LOCK] = { at: Date.now() }
    try {
      applyCore(ctx, DSH_HOME, log)
    } catch (e) {
      // 挂失败了要把锁放开，否则另一个入口也起不来了
      try { delete globalThis[CORE_LOCK] } catch {}
      throw e
    }
  },
}

function applyCore(ctx, DSH_HOME, log) {

    // ⚠️ 2026-11-04 主人要求：「只要配置或改动了一种养鱼方式的设置，另一种养鱼方式的
    //   相同设置就会同步更新（比如人格，作息），保证连贯性」
    //
    //   关键点是**设置页走的是 core 的 /config 接口**，不是插件自己的 writeConfig ——
    //   所以同步必须发生在这里，否则页面上改了，另一个入口读到的还是旧值 ✗
    //   （实测过：只在插件里加同步，接口层绕过去，两边还是 3 vs 4）

    /** 读配置时叠上共享习惯 —— 设置页看到的就是"她真正的作息" */
    function applySharedHabits(cfg) {
      try {
        const habits = libHabits.readHabits({ dshHome: DSH_HOME })
        return libHabits.applyHabits({ cfg, habits })
      } catch (e) {
        log(`[whale-core] 叠共享习惯失败（用原配置）：${e?.message ?? e}`)
        return cfg
      }
    }

    /** 写配置时把"习惯"那几项存进共享文件 —— 另一个入口立刻看到 */
    function saveSharedHabits(incoming, who) {
      try {
        const patch = libHabits.pickHabits(incoming)
        if (!Object.keys(patch).length) return
        libHabits.ensureHabits({ dshHome: DSH_HOME, biliCfg: incoming, qqCfg: incoming })
        libHabits.saveHabits({ dshHome: DSH_HOME, patch, who })
        log(`[whale-core] 共享设置已同步（${who} 改了 ${Object.keys(patch).join(', ')}）`)
      } catch (e) {
        log(`[whale-core] 同步共享习惯失败（配置照常保存）：${e?.message ?? e}`)
      }
    }

    function isTrustedReq(req) {
      if (isLoopbackReq(req)) return true
      try {
        const conn = connectionService
        if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
      } catch {}
      return false
    }

    function rejected(req, res) {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return true }
      try {
        const conn = connectionService
        if (!conn || typeof conn.requestRejection !== 'function') {
          json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' }); return true
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' }); return true
      }
    }

    const disposers = []
    // ⚠️ 宿主注入的是 `ctx.webServer` / `ctx.connection` —— 它们**不一定**在 ctx.get() 里。
    //   2026-11-04 踩过：只写 ctx.get('webServer') → 端到端一跑就是 undefined.register ✗
    //   两个都试，兼容不同宿主版本 ✓
    const webServer = ctx.webServer ?? ctx.get?.('webServer')
    const connectionService = ctx.connection ?? ctx.get?.('connection')
    if (!webServer || typeof webServer.register !== 'function') {
      throw new Error('whale-core 拿不到 webServer 服务（宿主没注入？）')
    }

    function route(kind, pathname, handler) {
      disposers.push(webServer.register({
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

    // ── 配置 + 开关状态 ──────────────────────────────────────────────
    // 通道是在各自插件的 apply 里登记的，而 DSH 不保证 core 先 apply ✗
    // → 配置对象**每次现建**（按当前注册表），别在 apply 那一刻把通道列表定死
    const RISK_STATE = path.join(DSH_HOME, 'whale-channels', 'risk-state.json')
    function loadRiskState() { try { return JSON.parse(fs.readFileSync(RISK_STATE, 'utf8')) } catch { return {} } }
    function saveRiskState(s) {
      try {
        fs.mkdirSync(path.dirname(RISK_STATE), { recursive: true })
        fs.writeFileSync(RISK_STATE, JSON.stringify(s, null, 2) + '\n')
      } catch {}
    }
    const risk = createRiskCounter({ state: loadRiskState(), now: () => Date.now() })

    function cfgStore() {
      const chans = list().map((c) => ({
        id: c.id,
        defaults: c.defaults,
        defaultEnabled: c.defaultEnabled,
        configFile: c.configFile,
      }))
      return createChannelConfig({ dshHome: DSH_HOME, channels: chans, log })
    }

    // ── 通道生命周期：开关打开就 start，关掉就 stop ──────────────────
    const live = new Map()   // id -> { handle, startedAt }
    function stopChannel(id) {
      const cur = live.get(id)
      if (!cur) return
      live.delete(id)
      try { cur.handle?.stop?.() } catch (e) { log(`[whale-core] 停 ${id} 出错：${e?.message ?? e}`) }
    }
    function startChannel(entry) {
      if (live.has(entry.id) || !entry.start) return
      try {
        const handle = entry.start(ctx)
        live.set(entry.id, { handle, startedAt: new Date().toISOString() })
      } catch (e) {
        log(`[whale-core] 起 ${entry.id} 失败：${e?.message ?? e}`)
      }
    }
    function syncLifecycle() {
      const store = cfgStore()
      for (const entry of list()) {
        const on = store.isEnabled(entry.id)
        if (on) startChannel(entry)
        else stopChannel(entry.id)
      }
    }

    // ── 共用路由 ────────────────────────────────────────────────────
    // 两个通道之间的「谁说了算」：主通道 / 私聊归谁 / 动态归谁 / 记忆共用
    //   （2026-11-04 主人定的，规则在 lib/shared.js 里，这里只负责读写和展示）
    const SHARED_FILE = path.join(DSH_HOME, 'whale-channels', 'shared.json')
    function readShared() {
      try { return JSON.parse(fs.readFileSync(SHARED_FILE, 'utf8')) } catch { return {} }
    }
    function writeShared(patch) {
      const next = { ...readShared(), ...(patch ?? {}) }
      if (patch?.memory) next.memory = { ...(readShared().memory ?? {}), ...patch.memory }
      fs.mkdirSync(path.dirname(SHARED_FILE), { recursive: true })
      const tmp = `${SHARED_FILE}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
      fs.renameSync(tmp, SHARED_FILE)
      return next
    }
    /** 当前两个通道能干什么 —— 控制台直接显示这个，不用自己去推 */
    function capabilitiesNow() {
      const store = cfgStore()
      const enabled = Object.fromEntries(list().map((c) => [c.id, store.isEnabled(c.id)]))
      const shared = normalizeShared(readShared())
      // 2026-11-04 主人要求：没配置好的通道**不能出现在选择里**（只装了哔站就选不了 QQ）
      //   先算每个通道「装好了没」，再拿它去算能力 —— 顺序不能反 ✗
      const setupState = {}
      const configured = {}
      for (const c of list()) {
        let cfg = {}
        try { cfg = store.readChannel(c.id) ?? {} } catch { cfg = {} }
        // ⚠️ 2026-11-04：B 站的凭据在**用户主目录**的 .bili-ai/ 里，不在 DSH_HOME 下 ✗
        //   写成 path.join(DSH_HOME, '.bili-ai', ...) 会永远判成「没登录」，
        //   结果 B 站明明登录了却选不了 —— 这种路径错必须当场验证过
        const biliCred = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.bili-ai', 'credentials.json')
        const loggedIn = c.id === 'bili'
          ? Boolean(fs.existsSync(biliCred))
          : Boolean(String(cfg?.self?.uin ?? '').trim())
        setupState[c.id] = setupStateFor(c.id, { installed: true, loggedIn, cfg })
        configured[c.id] = setupState[c.id].ok
      }
      const caps = {}
      for (const c of list()) caps[c.id] = capabilitiesFor(c.id, { shared, enabled, configured })
      // 2026-11-04：醒来时间点两个通道共用一套 —— 把「真正会用到的窗口」算出来，
      //   控制台显示它，通道插件也能从 GET /shared 拿到它 ✓
      const biliNight = (() => {
        try { return store.readChannel('bili')?.night?.windows ?? [] } catch { return [] }
      })()
      const wakeWindows = sharedWakeWindows({ shared, biliNightWindows: biliNight })
      // ⚠️ 2026-11-04：主人的核心要求是「切换养鱼方式后还在同一个上下文，还记得东西」。
      //   这里把「她现在是哪个对话、多大了、两边是不是同一个人」算出来给控制台看 ✓
      const body = (() => {
        try { return libBody.bodyStatus({ dshHome: DSH_HOME }) } catch { return null }
      })()
      const habits = (() => {
        try { return libHabits.readHabits({ dshHome: DSH_HOME }) } catch { return null }
      })()
      return { shared, enabled, caps, wakeWindows, setupState, configured, body, habits }
    }

    route('exact', '/dsh-whale/api/channels', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false }); return }
      syncLifecycle()
      const store = cfgStore()
      // ⚠️ 2026-11-04：body / habits 也要透出去 —— 控制台那张「她还是同一个人」的卡要用 ✓
      const { shared, caps, setupState, body, habits } = capabilitiesNow()
      json(res, 200, {
        ok: true,
        channels: list().map((c) => ({
          ...describe(c),
          enabled: store.isEnabled(c.id),
          running: live.has(c.id),
          caps: caps[c.id] ?? null,     // ← 这个通道现在能干什么
          setup: setupState[c.id] ?? null,   // ← 装好了没（没配好就不能被选）
        })),
        shared,                          // ← 谁主、私聊归谁、动态归谁
        body,                            // ← 她现在在哪个对话（两个入口共用这一个）
        habits,                          // ← 共享的作息/口味/人设
        dshHome: DSH_HOME,
      })
    })

    route('exact', '/dsh-whale/api/shared', async (req, res) => {
      if (req.method === 'GET') {
        const { shared, enabled, caps, wakeWindows, setupState } = capabilitiesNow()
        json(res, 200, { ok: true, shared, enabled, caps, wakeWindows, setupState, path: SHARED_FILE })
        return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const incoming = body.shared ?? body ?? {}
        // 先校验再落盘：非法值一个字节都不写 ✓
        normalizeShared({ ...readShared(), ...incoming })
        // 2026-11-04 主人要求：没配置好的通道不能被选。
        //   前端会把选项灰掉，但如果有人直接打接口 / 用旧页面，也不能让它写进去 ✗
        //   这里是**服务端**最后一道闸 ✓
        const { setupState } = capabilitiesNow()
        for (const field of ['dm', 'dynamic']) {
          const pick = incoming?.[field]
          if (pick === undefined) continue
          const st = setupState[pick]
          if (st && st.ok === false) {
            json(res, 409, {
              ok: false,
              error: `选不了「${pick}」：${st.reason}`,
              hint: st.hint,
            })
            return
          }
        }
        writeShared(incoming)
        const { shared, enabled, caps } = capabilitiesNow()
        json(res, 200, { ok: true, shared, enabled, caps, setupState })
      } catch (e) {
        json(res, 400, { ok: false, error: String(e?.message ?? e).slice(0, 300) })
      }
    })

    route('exact', '/dsh-whale/api/health', async (req, res) => {
      json(res, 200, { ok: true, channels: list().map((c) => c.id), running: [...live.keys()], risk: risk.snapshot() })
    })

    // ── /dsh-whale/api/<id>/<what> ─────────────────────────────────────
    //
    // ⚠️ 2026-11-04（第二次）：这才是「养鱼 · QQ → 读取配置失败：HTTP 404」的真正原因。
    //   原来这里写的是 `route('prefix', '/dsh-whale/api/channels/', …)` —— **尾部带斜杠** ✗
    //   而宿主 webServer 的 prefix 匹配规则是：
    //       pathname === prefix || pathname.startsWith(prefix + '/')
    //   它会**自己再补一个 `/`**。于是实际比较的是
    //       "/dsh-whale/api/channels//qq/config".startsWith("/dsh-whale/api/channels//")
    //   → 永远是 false。**任何带 id 的路径都匹配不上**，落到 SPA fallback，
    //   回一个**没有响应体**的 404（所以设置页只能显示「HTTP 404」）。
    //
    //   同一时期 `/channels`、`/health`、`/shared` 用的是 exact 路由，一直正常 ——
    //   所以「通道登记成功」「/health 里有 qq」都是真的，唯独带 id 的路径全挂 ✗
    //
    //   修法：prefix 一律**不带尾部斜杠**（宿主约定的形状）。
    //   父段解析时自己补 `/` 前缀判断，避免 /channelsfoo 这类误吃 ✓
    const API_PREFIX = '/dsh-whale/api'
    route('prefix', API_PREFIX, async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const rest = url.pathname.slice(API_PREFIX.length).split('/').filter(Boolean)
      // 只认 /channels/<id>/<what> 这一族；其它子路径（例如 /health 已被 exact 接走）交回 404
      if (rest[0] !== 'channels') { json(res, 404, { ok: false, error: `没有这个接口：/${rest.join('/')}` }); return }
      const [id, what, ...more] = rest.slice(1)
      // /dsh-whale/api/channels/ 或 /dsh-whale/api/channels —— 列表，不是 404
      if (!id) {
        syncLifecycle()
        const store0 = cfgStore()
        const { shared, caps } = capabilitiesNow()
        json(res, 200, {
          ok: true,
          channels: list().map((c) => ({
            ...describe(c),
            enabled: store0.isEnabled(c.id),
            running: live.has(c.id),
            caps: caps[c.id] ?? null,
          })),
          shared,
          dshHome: DSH_HOME,
        })
        return
      }
      const entry = get(id)
      if (!entry) {
        const ids = list().map((c) => c.id)
        log(`[whale-core] 404：通道 ${JSON.stringify(id)} 没登记（已登记：${ids.length ? ids.join(', ') : '无'}）`)
        json(res, 404, {
          ok: false,
          error: `没有这个通道：${id}` + (ids.length ? `（已登记：${ids.join(' / ')}）` : '（注册表是空的）'),
          hint: ids.length
            ? `看 DSH 启动日志里有没有 "[${id}] 通道已登记"，没有就是 ${id} 插件 apply 抛错了`
            : '注册表是空的：通道插件（dsh-qq-whale / dsh-bili-whale）没 apply 成功，或 core 与通道不是同一张表',
          registered: ids,
        })
        return
      }
      const store = cfgStore()

      if (what === 'enabled') {
        if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
        const body = JSON.parse((await readBody(req)) || '{}')
        if (typeof body.enabled !== 'boolean') { json(res, 400, { ok: false, error: 'enabled 必须是 true/false' }); return }
        const enabled = store.setEnabled(id, body.enabled)
        if (enabled) startChannel(entry); else stopChannel(id)
        log(`[whale-core] 通道 ${id} → ${enabled ? '开' : '关'}`)
        json(res, 200, { ok: true, id, enabled, running: live.has(id) })
        return
      }

      if (what === 'config') {
        if (req.method === 'GET') {
          const cfg = store.readChannel(id)
          // ⚠️ 2026-11-04 主人要求：「改了一种养鱼方式的设置，另一种的相同设置就同步更新」
          //   设置页读的是这里，所以**必须在这里叠上共享习惯** ——
          //   否则 B 站页面显示的还是它自己文件里的旧值（和 QQ 那边不一样）✗
          const withHabits = applySharedHabits(cfg)
          // 2026-11-04：读配置**默认脱敏**。设置页只用 GET 不传 ?raw=1，
          //   所以敏感字段（cookie/token/密码）永远不会出现在浏览器里 ✓
          //   ?raw=1 是给本地排障留的口子，同样要过信任栅栏 ✓
          const raw = url.searchParams.get('raw') === '1'
          json(res, 200, {
            ok: true, id, enabled: store.isEnabled(id),
            config: raw ? withHabits : redact(entry, withHabits),
            configPath: store.fileFor(id),
          })
          return
        }
        if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
        // ⚠️ 2026-11-04 改：**关着的通道也要能改配置** ✓
        //   原来是 409。结果主人第一次打开 QQ 页时通道是「关」的，
        //   连 QQ 号都填不进去 —— 必须先开再填，顺序全反了 ✗
        //   「怕它还在动」这个担心不成立：关着就是关着，改配置不会让它跑起来 ✓
        const body = JSON.parse((await readBody(req)) || '{}')
        const incoming = (body && typeof body.config === 'object' && body.config) || body || {}
        // ⚠️ 2026-11-04：写之前先把"习惯"那几项存进共享文件 —— 另一个入口立刻看到 ✓
        saveSharedHabits(incoming, id)
        const next = store.writeChannel(id, incoming)
        json(res, 200, {
          ok: true, id,
          enabled: store.isEnabled(id),
          config: redact(entry, applySharedHabits(next)),
          configPath: store.fileFor(id),
          note: store.isEnabled(id) ? null : '配置存好了；这个通道现在是关的，打开之后才会跑',
        })
        return
      }

      if (what === 'deps') {
        if (!entry.deps) { json(res, 200, { ok: true, items: [], note: '这个通道没有提供依赖体检' }); return }
        try {
          const result = await entry.deps(ctx)
          json(res, 200, { ok: result?.ok !== false, id, ...result })
        } catch (e) {
          json(res, 200, { ok: false, id, error: String(e?.message ?? e) })
        }
        return
      }

      // 通道自定义路由：'GET /status' 之类的 key，落到 /channels/<id>/status
      const method = req.method === 'HEAD' ? 'GET' : req.method
      const want = [what, ...more].filter(Boolean).join('/')
      const key = `${method} /${want}`
      const handler = entry.routes[key]
      if (handler) {
        // ⚠️ 2026-11-04 改：**读类**请求关着也放行 ✓
        //   原来是 409 一刀切，结果 QQ 页在「关」的状态下连账号、语音状态都看不了 ✗
        //   写类请求（POST）还是要开关着才行 —— 那才是「关着的通道不该动」的本意 ✓
        //
        // ⚠️ 2026-11-04（第二次）：主人截图「扫码登录 → 出错了 → 通道 qq 现在是关的，先打开再操作」。
        //   扫码登录、取消登录、从 NapCat 读账号，这三样都是 POST，被 409 挡死了 ——
        //   可它们**根本不会让通道跑起来**：只是问 NapCat 要个二维码、或者记一下当前登录的号 ✗
        //   而且正常顺序本来就是「先登录、再打开」，要求先开通道是把顺序搞反了。
        //   所以：**登录/账号这一族 POST 例外放行**（前缀 auth/ 与 accounts/）。
        //   其余 POST 仍然要通道开着 ✓
        const isRead = method === 'GET'
        // ⚠️ 2026-11-04（第三次）：备份/恢复也被 409 挡死了。
        //   备份是**读磁盘**、恢复是**写文件** —— 都跟通道开没开完全无关，
        //   关着的通道照样该能备份（甚至更该，因为要停着才能安全恢复）✗
        const isSetup = /^(auth|accounts|backup)\//.test(want)
        if (!store.isEnabled(id) && !isRead && !isSetup) {
          json(res, 409, { ok: false, error: `通道 ${id} 现在是关的：先在上面把它打开，再操作「${want}」` }); return
        }
        await handler(req, res, { readBody, json })
        return
      }
      json(res, 404, { ok: false, error: `通道 ${id} 没有这个接口：${key}` })
    })

    // 启动：把已经开着的通道拉起来（延迟一拍，等别的插件登记完）
    setTimeout(() => { try { syncLifecycle() } catch (e) { log(`[whale-core] 启动同步失败：${e?.message ?? e}`) } }, 1500)
    const timer = setInterval(() => { try { saveRiskState(risk.state) } catch {} }, 60_000)
    if (typeof timer.unref === 'function') timer.unref()

    ctx.effect(() => () => {
      clearInterval(timer)
      saveRiskState(risk.state)
      for (const id of [...live.keys()]) stopChannel(id)
      for (const d of disposers) { try { d() } catch {} }
      // 卸载时放开单例锁，让另一个入口能接上
      try { delete globalThis[Symbol.for('dsh-whale-core.mounted.v1')] } catch {}
    })

    log('[whale-core] 通道框架已挂载：/dsh-whale/api/')
}

export { LIMIT }
