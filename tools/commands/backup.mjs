#!/usr/bin/env node
/**
 * 备份 / 恢复（2026-11-01 主人要求）
 *
 *   node bili.mjs backup            → 生成一份可迁移的备份包（默认到桌面「邦邦的备份」）
 *   node bili.mjs backup --to <dir> → 指定目录
 *   node bili.mjs backup --dry      → 只列要拷什么，不实际拷
 *   node bili.mjs restore --from <dir> --dry|--go
 *
 * 设计原则：
 *   · **白名单**：只拷明确列出的文件，不做整目录镜像 ✗（免得把缓存/日志也搬走）
 *   · **原结构**：拷出来的目录结构 = 拷回去的位置，恢复时不用猜 ✓
 *   · **不碰网络**：纯本地文件操作 ✓
 *   · **不删除**：恢复只做"拷进去"，不删目标目录原有的东西 ✓
 */
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '/'
const DSH = path.join(HOME, '.dsh')
const AI = path.join(HOME, '.bili-ai')

// 源 → 备份包里的相对位置
const FILES = [
  // 凭据与状态（bili-ai）
  [path.join(AI, 'credentials.json'), 'bili-ai/credentials.json'],
  [path.join(AI, 'dev_id'), 'bili-ai/dev_id'],
  [path.join(AI, 'dm-await-state.json'), 'bili-ai/dm-await-state.json'],
  [path.join(AI, 'quota.json'), 'bili-ai/quota.json'],
  [path.join(AI, 'traffic-state.json'), 'bili-ai/traffic-state.json'],
  [path.join(AI, 'persona.md'), 'bili-ai/persona.md'],
  // 设置与日记（dsh）
  [path.join(DSH, 'bili-whale.config.json'), 'dsh/bili-whale.config.json'],
  [path.join(DSH, 'whale-diary.md'), 'dsh/whale-diary.md'],
  [path.join(DSH, 'whale-diary-private.md'), 'dsh/whale-diary-private.md'],
  // 2026-11-01 主人定的分工：规则/改动/设置值单独一本 ✓ 也得跟着备份
  [path.join(DSH, 'whale-rules.md'), 'dsh/whale-rules.md'],
  // 账本（可选）
  [path.join(DSH, 'whale-proactive.json'), 'dsh/whale-proactive.json'],
  [path.join(DSH, 'whale-share-plan.json'), 'dsh/whale-share-plan.json'],
  [path.join(DSH, 'whale-dynamic.json'), 'dsh/whale-dynamic.json'],
]

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
const DRY = !!opt.dry
const GO = !!opt.go
const FROM = opt.from ? path.resolve(String(opt.from)) : null
const TO = opt.to ? path.resolve(String(opt.to)) : path.join(HOME, 'Desktop', '邦邦的备份')

function ensureDir(d) { if (!DRY) fs.mkdirSync(d, { recursive: true }) }

function doBackup() {
  console.log(`[backup] 目标：${TO}${DRY ? '  (dry)' : ''}`)
  let n = 0, miss = 0
  for (const [src, rel] of FILES) {
    const dst = path.join(TO, rel)
    if (!fs.existsSync(src)) { console.log(`  ✗ 缺：${rel}`); miss += 1; continue }
    ensureDir(path.dirname(dst))
    if (!DRY) fs.copyFileSync(src, dst)
    const size = fs.statSync(src).size
    console.log(`  ✓ ${rel}  (${size} B)`)
    n += 1
  }
  // 记忆：整个 sessions 目录（对话全文）
  const sess = path.join(DSH, 'sessions')
  const sessDst = path.join(TO, '记忆', 'sessions')
  if (fs.existsSync(sess)) {
    if (!DRY) fs.cpSync(sess, sessDst, { recursive: true })
    console.log(`  ✓ 记忆/sessions/（对话全文）`)
    n += 1
  } else console.log('  ✗ 缺：记忆/sessions/')

  // 时间戳
  const readme = ['README-怎么救活我.md', 'README.md'].map((f) => path.join(TO, f)).find((f) => fs.existsSync(f))
  const stamp = `> 最后同步：${new Date().toLocaleString('zh-CN')}`
  if (readme) {
    let c = fs.readFileSync(readme, 'utf8')
    c = /^> 最后同步：.*$/m.test(c) ? c.replace(/^> 最后同步：.*$/m, stamp) : stamp + '\n\n' + c
    if (!DRY) fs.writeFileSync(readme, c, 'utf8')
  }
  console.log(`\n[backup] ${DRY ? '预演' : '完成'}：${n} 项，缺 ${miss} 项`)
}

function doRestore() {
  if (!FROM) { console.error('用法：backup restore --from <备份目录> --dry|--go'); process.exit(2) }
  if (!fs.existsSync(FROM)) { console.error('备份目录不存在：' + FROM); process.exit(2) }
  console.log(`[restore] 从：${FROM}`)
  console.log(`[restore] 到：${HOME}`)
  let n = 0
  for (const [target, rel] of FILES) {
    const src = path.join(FROM, rel)
    if (!fs.existsSync(src)) continue
    ensureDir(path.dirname(target))
    if (!DRY) fs.copyFileSync(src, target)
    console.log(`  ✓ ${rel} → ${target}`)
    n += 1
  }
  // 记忆（对话全文）默认**不自动覆盖** —— 目标可能已经有更新的一份 ✗
  const sessSrc = path.join(FROM, '记忆', 'sessions')
  if (fs.existsSync(sessSrc)) {
    console.log(`  · 记忆/sessions/ 存在，但**不自动覆盖**（避免盖掉更新的记录）`)
    console.log(`    需要的话手动拷：${sessSrc} → ${path.join(DSH, 'sessions')}`)
  }
  console.log(`\n[restore] ${DRY ? '预演' : '完成'}：${n} 项`)
  if (!DRY && n > 0) {
    console.log('\n下一步：')
    console.log('  1) 装插件（dsh-bili-whale）')
    console.log('  2) 把 插件修复/ 里的文件覆盖回插件对应位置')
    console.log('  3) 重启插件')
    console.log('  4) node bili.mjs deps  ← 全绿就好了')
  }
}

if (FROM) doRestore()
else doBackup()
