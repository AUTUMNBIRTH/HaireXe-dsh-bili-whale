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

// ── 1. 自带共用框架 ─────────────────────────────────────────────
// ⚠️ 2026-11-04 晚：主人说「dsh-whale-core 这个库不要，那两个库里分别放一个就行」。
//   所以 core 现在**就在本仓库的 core/ 目录里**，跟着插件一起装，不用再单独装一遍 ✓
//   （以前这里会检查外面有没有 core，没有就让你先去装 —— 那个仓库已经不要了）
const bundledCore = path.join(HERE, 'core')
if (!fs.existsSync(path.join(bundledCore, 'lib', 'index.js'))) {
  say('  [X] 本仓库缺 core/ 目录（共用框架应该在 repo 里自带）')
  say('      可能是解压/克隆不完整，重新 clone 一次这个仓库再来。')
  process.exit(1)
}
say('  [1/3] 自带共用框架 core/ ✓')

// ── 2. 决定装到哪儿 ──────────────────────────────────────────────
// 通道插件放 ~/.dsh/plugins/<包名>（core/ 作为子目录一起过去）
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

// ── 3. 装运行时依赖并**验证**（2026-11-04 加固）────────────────
//
// ⚠️ 原来这里是「npm install 失败就打个警告继续」—— 结果装完插件 import 失败，
//   表现成「设置页少了那一节 / 接口 404」，最难查 ✗
//   现在：装不上就 exit(1)，绝不给你一个半成品。
const pkgDeps = Object.keys(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).dependencies ?? {})
const missingDeps = pkgDeps.filter((d) => !fs.existsSync(path.join(target, 'node_modules', d, 'package.json')))
if (missingDeps.length) {
  say('  [2.5] 装依赖：' + missingDeps.join(', ') + ' ...')
  const runners = [
    { cmd: 'npm', args: ['install', '--omit=dev', '--no-audit', '--no-fund'] },
    { cmd: 'pnpm', args: ['install', '--prod'] },
    { cmd: 'corepack', args: ['npm', 'install', '--omit=dev'] },
  ]
  let ok = false
  let tried = []
  for (const r of runners) {
    try {
      execFileSync(r.cmd, r.args, { cwd: target, stdio: 'inherit', shell: true })
      ok = true
      break
    } catch (e) { tried.push(r.cmd) }
  }
  if (!ok) {
    console.error('')
    console.error('  [X] 没有可用的包管理器（试过：' + tried.join(' / ') + '）')
    console.error('      这个插件必须有 ' + missingDeps.join(', ') + ' 才能加载，装不上就会表现为')
    console.error('      「设置页少了这一节」或者「接口 404」。')
    console.error('')
    console.error('      手动修（装完再重跑本脚本也行）：')
    console.error('        cd "' + target + '"')
    console.error('        npm install')
    console.error('')
    process.exit(1)
  }
}

// ⚠️ 硬校验：不只是"命令跑完了"，而是**真的能解析到**
const stillMissing = pkgDeps.filter((d) => !fs.existsSync(path.join(target, 'node_modules', d, 'package.json')))
if (stillMissing.length) {
  console.error('')
  console.error('  [X] 依赖装了但找不到：' + stillMissing.join(', '))
  console.error('      手动修：cd "' + target + '" && npm install')
  console.error('')
  process.exit(1)
}
say('  [2.5] 依赖就位并已验证 ✓')

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
