#!/usr/bin/env node
/**
 * install.mjs -- 把「养鱼 · B站」装进 DSH
 *
 * 用法：  node install.mjs
 *
 * 这个包可以**单独下载安装**。
 *   它依赖 whale-core（两个鱼共用的框架），脚本会先检查；缺了会告诉你装什么。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = 'dsh-bili-whale'
const DSH = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILE = process.env.DSH_PROFILE || 'desktop'
const PLUGIN_DIR = process.env.DSH_PLUGIN_DIR || path.join(DSH, 'plugins')
const PROFILE_DIR = path.join(DSH, 'profiles', PROFILE)

const say = (s = '') => console.log(s)
const die = (s) => { console.error('\n  [X] ' + s + '\n'); process.exit(1) }

say('')
say('  养鱼 · B站   安装')
say('  ' + '='.repeat('养鱼 · B站'.length + 12))
say('')

if (!fs.existsSync(PROFILE_DIR)) {
  die(`找不到 DSH profile：${PROFILE_DIR}\n      先启动一次 DeepSeek Harness，它会自己建好`)
}

// ── 1. 检查共用框架 whale-core ───────────────────────────────────
const hasCore = fs.existsSync(path.join(PROFILE_DIR, 'node_modules', 'dsh-whale-core'))
  || fs.existsSync(path.join(DSH, 'whale-core'))
if (!hasCore) {
  say('  [!] 没找到 dsh-whale-core（两个鱼共用的框架）')
  say('')
  say('      它是总控制台和通道管理的基础，必须一起装。先执行：')
  say('')
  say('        git clone https://github.com/<你的账号>/dsh-whale-core')
  say('        cd dsh-whale-core')
  say('        node install.mjs')
  say('')
  say('      装完再回来跑本脚本。')
  say('')
  process.exit(1)
}
say('  [1/3] 找到 dsh-whale-core  ✓')

// ── 2. 决定装到哪儿 ──────────────────────────────────────────────
// 通道插件放 ~/.dsh/plugins/<包名>；core 放 ~/.dsh/whale-core（历史位置，保持不变）
const target = path.join(PLUGIN_DIR, PKG)
fs.mkdirSync(path.dirname(target), { recursive: true })
const samePath = path.resolve(target).toLowerCase() === path.resolve(HERE).toLowerCase()
if (!samePath) {
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(HERE, target, {
    recursive: true,
    filter: (s) => {
      const n = path.basename(s)
      return n !== 'node_modules' && n !== '.git'
    },
  })
  say('  [2/3] 已放到 ' + target)
} else {
  say('  [2/3] 本来就在目标位置，跳过复制')
}

// ── 3. 装运行时依赖（B站 需要 qrcode）─────────────────────────
const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).dependencies ?? {})
const needInstall = deps.some((d) => !fs.existsSync(path.join(target, 'node_modules', d, 'package.json')))
if (needInstall) {
  say('  [2.5] 装依赖：' + deps.join(', ') + ' ...')
  try {
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: target, stdio: 'inherit' })
    say('        依赖装好了 ✓')
  } catch {
    say('        [!] npm install 失败。手动执行：cd "' + target + '" && npm install')
  }
} else {
  say('  [2.5] 依赖已就位 ✓')
}

// ── 4. 登记到 profile + 建链接 ───────────────────────────────────
const pkgFile = path.join(PROFILE_DIR, 'package.json')
let manifest
try { manifest = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch { die(`读不了 ${pkgFile}`) }
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []

manifest.dependencies[PKG] = 'link:' + target.replace(/\\/g, '/')
if (!manifest.dsh.profile.bundles.includes(PKG)) manifest.dsh.profile.bundles.push(PKG)
fs.writeFileSync(pkgFile, JSON.stringify(manifest, null, 2) + '\n')
say('  [3/3] 已登记到 profile bundles  ✓')

const linkPath = path.join(PROFILE_DIR, 'node_modules', PKG)
fs.mkdirSync(path.dirname(linkPath), { recursive: true })
try {
  fs.rmSync(linkPath, { recursive: true, force: true })
  if (process.platform === 'win32') execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: 'pipe' })
  else fs.symlinkSync(target, linkPath, 'junction')
  say('        链接：' + linkPath)
} catch (e) {
  say('        [!] 建链接失败：' + e.message)
}

say('')
say('  ' + '='.repeat('养鱼 · B站'.length + 12))
say('  装好了')
say('  ' + '='.repeat('养鱼 · B站'.length + 12))
say('')
say('  1. 完整退出 DSH（托盘也要退）再启动')
say('  2. DSH → 设置 →「B站」→ 扫码登录')
say('  3. 登录后，总控制台里就能选它')
say('')
