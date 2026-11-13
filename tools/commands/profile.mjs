// 她的号她做主 —— 改签名（2026-11-03 加）
//
//   node bili.mjs profile show                     看她现在的签名
//   node bili.mjs profile sign --text "…" [--dry|--go]
//
// 背景：工具链原本只有"往外发东西"的能力（评论 / 私信 / 动态 / 收藏），
//   改签名没有对应接口 → 人格里写了「我的号是我的」，她却改不了签名 ✗
//
// 只做签名：昵称改一次要花硬币、还有冷却期；头像要上传图片。
// 这两样都不该让 agent 自己动，想改还是找他一起 ✓
import { guardedFetch as fetch } from '../lib/traffic.mjs'
import { apiGet } from '../lib/bili-api.mjs'
import { loadCred, missingForWrite, writeFailText } from '../lib/cred.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SIGN_MAX = 70 // B站签名上限（超了接口会拒，这里先拦一道）

const HINT = {
  '-101': '账号未登录：SESSDATA 失效，重新复制一次 cookie',
  '-111': 'CSRF 校验失败：bili_jct 和当前 SESSDATA 不是同一账号，或已过期 → 两个都重新复制一次',
  '-400': '参数不对（签名太长 / 含平台不允许的字符）',
  '-352': '风控拦截：等几分钟再来',
  10031: '操作太快：退避一会儿',
  12015: '需要验证码：停下，去浏览器手动过一次',
  12051: '疑似刷屏：停下，别再改',
}

const argv = process.argv.slice(2)
const sub = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2)
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { opt[k] = argv[i + 1]; i += 1 } else opt[k] = true
  }
}

if (!sub || sub === 'help' || sub === '--help') {
  console.log('用法:')
  console.log('  node bili.mjs profile show                          看现在的签名')
  console.log('  node bili.mjs profile sign --text "…" [--dry|--go]  改签名')
  process.exit(sub ? 0 : 2)
}

let cred
try { cred = loadCred() } catch (e) { console.error('✗ ' + e.message); process.exit(3) }
const miss = missingForWrite(cred)
if (miss.length) { console.error('✗ 写操作缺凭据：' + miss.join('、') + '\n  去设置页重新粘贴一次 cookie ✓'); process.exit(3) }

const H = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}${cred.buvid3 ? `; buvid3=${cred.buvid3}` : ''}`,
}

if (sub === 'show') {
  const j = await apiGet('https://api.bilibili.com/x/member/web/account', H)
  if (Number(j.code) !== 0) {
    console.error(`✗ 读不到账号信息：code=${j.code} ${HINT[String(j.code)] ?? (j.message ?? '未知错误')}`)
    process.exit(4)
  }
  const d = j.data ?? {}
  console.log(`  昵称：${d.uname ?? d.name ?? '(空)'}`)
  console.log(`  签名：${d.sign ? `「${d.sign}」` : '（还没写）'}`)
  console.log(`  UID：${d.mid ?? (d.userid ?? '?')}`)
  if (typeof d.nick_free === 'boolean') console.log(`  改名：${d.nick_free ? '现在可以改一次（免费）' : '要花硬币 / 冷却中'}`)
  process.exit(0)
}

if (sub !== 'sign') { console.error(`未知子命令：${sub}（只支持 show / sign）`); process.exit(2) }

const text = String(opt.text ?? '').trim()
if (!text) { console.error('✗ 要改的签名是空的：--text "…"\n  真想清空签名，得去网页端改（这里不替你清空）'); process.exit(2) }
if (text.length > SIGN_MAX) { console.error(`✗ 签名太长：${text.length} 字，B站上限 ${SIGN_MAX}`); process.exit(2) }

console.log('  新签名：' + text)
console.log('  字数：' + text.length + '/' + SIGN_MAX)

if (!opt.go && !opt.dry) { console.error('✗ 必须给 --dry（只打印）或 --go（真改）'); process.exit(2) }
if (opt.dry) { console.log('  [dry] 未提交 ✓ 确认后把 --dry 换成 --go'); process.exit(0) }

const body = new URLSearchParams({ user_sign: text, csrf: String(cred.bili_jct) })
const r = await fetch('https://api.bilibili.com/x/member/web/sign/update', {
  method: 'POST',
  headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
  body: body.toString(),
  waitWriteMs: 180000,
})
const j = await r.json().catch(() => ({ code: -1, message: '非 JSON 响应' }))
if (Number(j.code) !== 0) {
  console.error(writeFailText(j.code, j.message) + (HINT[String(j.code)] ? `\n  → ${HINT[String(j.code)]}` : ''))
  process.exit(4)
}
console.log(`  ✓ 签名已改（HTTP ${r.status}）`)

// 回读复核（写操作后一条必做）
const back = await apiGet('https://api.bilibili.com/x/member/web/account', H, { noCache: true })
if (Number(back.code) === 0 && back.data?.sign === text) console.log('  ✓ 回读一致')
else console.log(`  ! 回读不一致：现在显示「${back.data?.sign ?? '?'}」（可能是缓存，稍后再看）`)
