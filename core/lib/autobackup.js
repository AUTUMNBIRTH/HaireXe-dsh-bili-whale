/**
 * dsh-whale-core · 自动备份（2026-11-04 晚）
 *
 * 主人要求：「别人下载这两个库之后运行、新建一个人格后，桌面会出现一个备份」
 *
 * 之前备份**只能手动点按钮 / 敲命令**。新用户装完、写了人格，
 * 桌面上什么都没有 —— 万一那台机器出问题，刚写的人格就没了 ✗
 *
 * 这个模块做的事：
 *   · 第一次检测到"有人格了"（~/.bili-ai/persona.md 有内容）
 *     且桌面上还没有备份 → **自动创建一份**
 *   · 之后人格再改，也只是**更新**那份备份（不新建目录）
 *   · 节流：同一份内容不重复备份（比较 persona 的 mtime + 大小）
 *
 * 设计上刻意保守：
 *   · 只在**内容真的变了**的时候写
 *   · 目录固定「邦邦的备份」，和手动备份同一个地方（一条鱼一份备份）✓
 *   · 失败不抛错（备份失败不该影响插件本身）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const BACKUP_DIR_NAME = '邦邦的备份'

/**
 * 备份目录叫什么。
 *
 * ⚠️ 2026-11-04 晚（主人：「不需要『邦邦的备份』，直接是他创建那个人格名字的备份就行」）：
 *   原来固定叫「邦邦的备份」——那是主人这条鱼的名字，别人装了会跟着叫邦邦 ✗
 *   现在：**用这个人格自己的名字**。
 *     · 人格名字 = 设置里 persona.name（B站 / 共享习惯里那个）
 *     · 拿不到名字 → 退回「她的备份」（而不是硬编码某条鱼的名字）
 *   主人那条鱼名字就叫"邦邦"，所以他的目录仍然叫「邦邦的备份」✓
 */
export function backupDirName({ home = os.homedir(), name = '' } = {}) {
  const n = String(name ?? '').trim()
  // 名字里不能有路径分隔符之类的字符（Windows 文件名规则）
  const safe = n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim()
  if (safe) return `${safe}的备份`
  return '她的备份'
}

/** 备份到哪儿（桌面） */
export function backupDir(home = os.homedir(), name = '') {
  return path.join(home, 'Desktop', backupDirName({ home, name }))
}

/**
 * 白名单：源（相对 HOME）→ 备份包里的相对路径
 * ⚠️ 和 B站/QQ 各自的手动备份保持一致 —— 一处改了要同步改那边
 */
export const AUTO_BACKUP_FILES = [
  ['.bili-ai/persona.md', 'bili-ai/persona.md'],
  ['.dsh/whale-diary.md', 'dsh/whale-diary.md'],
  ['.dsh/whale-diary-private.md', 'dsh/whale-diary-private.md'],
  ['.dsh/whale-rules.md', 'dsh/whale-rules.md'],
  ['.dsh/whale-habits.json', 'dsh/whale-habits.json'],
  ['.dsh/whale-body.json', 'dsh/whale-body.json'],
  ['.dsh/bili-whale.config.json', 'dsh/bili-whale.config.json'],
  ['.bili-ai/credentials.json', 'bili-ai/credentials.json'],
  ['.dsh/whale-channels/channels/qq.json', 'dsh/whale-channels/channels/qq.json'],
  ['.dsh/whale-channels/index.json', 'dsh/whale-channels/index.json'],
  ['.dsh/whale-channels/shared.json', 'dsh/whale-channels/shared.json'],
]

/** 备份目录里的"上次备份标记" —— 用来判断要不要再备一次 */
const STAMP = '.last-auto-backup.json'

function readJsonSafe(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
}

/** 人格的指纹：mtime + 大小。变了才备份 */
function personaStamp(home) {
  const p = path.join(home, '.bili-ai', 'persona.md')
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return null
    return { mtime: st.mtimeMs, size: st.size }
  } catch { return null }
}

/**
 * 该不该自动备份？
 * @param {object} p
 * @param {string} [p.home]
 * @param {string} [p.name]  人格名字（决定目录名）
 * @returns {{ needed: boolean, reason: string, exist: boolean, dir: string }}
 */
export function autoBackupState({ home = os.homedir(), name = '' } = {}) {
  const dir = backupDir(home, name)
  const stamp = personaStamp(home)
  if (!stamp) return { needed: false, reason: '还没有人格（persona.md 不存在）', exist: false, dir }
  const exist = fs.existsSync(dir)
  const last = readJsonSafe(path.join(dir, STAMP))
  if (!exist) return { needed: true, reason: `桌面上还没有「${path.basename(dir)}」`, exist: false, dir }
  if (!last) return { needed: true, reason: '有备份目录但没有标记（可能是手动备份留下的）', exist: true, dir }
  if (last.personaMtime !== stamp.mtime || last.personaSize !== stamp.size) {
    return { needed: true, reason: '人格改过了', exist: true, dir }
  }
  return { needed: false, reason: '人格没变，不用重复备份', exist: true, dir }
}

/**
 * 真的做一次自动备份。
 *
 * ⚠️ 只**新增/更新**白名单里的文件，不删除备份目录里任何已有的东西 ——
 *   主人那个目录里还有 插件修复/、约定速查.md 等，
 *   绝不能被这条自动逻辑弄丢 ✗
 *
 * @returns {{ ok: boolean, dir: string, copied: number, reason: string }}
 */
export function runAutoBackup({ home = os.homedir(), name = '', log = () => {} } = {}) {
  const state = autoBackupState({ home, name })
  if (!state.needed) return { ok: true, dir: state.dir, copied: 0, reason: state.reason }

  const dir = state.dir
  let copied = 0
  try {
    fs.mkdirSync(dir, { recursive: true })
    for (const [srcRel, dstRel] of AUTO_BACKUP_FILES) {
      const src = path.join(home, srcRel)
      if (!fs.existsSync(src)) continue
      const dst = path.join(dir, dstRel)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      // 目录（whale-work）整份拷；文件直接拷
      const st = fs.statSync(src)
      if (st.isDirectory()) fs.cpSync(src, dst, { recursive: true })
      else fs.copyFileSync(src, dst)
      copied += 1
    }
    // 记标记，下次同样内容就不再重复
    const stamp = personaStamp(home)
    fs.writeFileSync(path.join(dir, STAMP), JSON.stringify({
      at: new Date().toISOString(),
      personaMtime: stamp?.mtime ?? 0,
      personaSize: stamp?.size ?? 0,
      copied,
      reason: state.reason,
    }, null, 2) + '\n', 'utf8')
    log(`[whale] 已自动备份 ${copied} 项到 ${dir}（${state.reason}）`)
    return { ok: true, dir, copied, reason: state.reason }
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 200)
    log(`[whale] 自动备份失败（不影响使用）：${msg}`)
    return { ok: false, dir, copied, reason: msg }
  }
}
