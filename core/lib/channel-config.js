/**
 * dsh-whale-core · 通道配置
 *
 * 关键要求（主人 2026-11-03）：**两个通道各自独立开关，想用哪个用哪个**。
 * 所以配置不能塞进一份大 json —— 一个通道坏掉或者被手改坏，不该连累另一个 ✗
 *
 * 布局（~/.dsh/whale-channels/）：
 *   index.json          ← 只存「哪些通道开着」+ 版本号（小、坏了也只影响开关默认值）
 *   channels/<id>.json  ← 每个通道自己一份完整配置（B 站那一份还是老格式，工具链继续读它）
 *
 * ⚠️ 为什么 B 站那份不搬家：`tools/lib/config.mjs` 直接读 `~/.dsh/bili-whale.config.json`，
 *    搬家就得把这十几个工具一起改，风险远大于收益。所以这里用 `configFile` 让通道自己指定文件，
 *    没指定才落到 channels/<id>.json ✓
 */
import fs from 'node:fs'
import path from 'node:path'

const INDEX_VERSION = 1

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

function writeJsonSafe(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(temp, file)   // 先写临时文件再改名：写到一半断电不会留半截 json ✓
}

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch
  if (!base || typeof base !== 'object') return patch === undefined ? base : patch
  if (!patch || typeof patch !== 'object') return patch === undefined ? base : patch
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v)
  return out
}

export function createChannelConfig({
  dshHome,
  channels = [],           // [{ id, configFile?, defaults?, defaultEnabled? }]
  log = () => {},
} = {}) {
  if (!dshHome) throw new Error('createChannelConfig 需要 dshHome')
  const root = path.join(dshHome, 'whale-channels')
  const indexFile = path.join(root, 'index.json')

  const byId = new Map(channels.map((c) => [c.id, c]))

  /** 通道自己的配置文件：通道指定了 configFile 就用它（B 站：老路径），否则 channels/<id>.json */
  function fileFor(id) {
    const c = byId.get(id)
    if (c?.configFile) return c.configFile
    return path.join(root, 'channels', `${id}.json`)
  }

  function readIndex() {
    const idx = readJsonSafe(indexFile)
    if (!idx || typeof idx !== 'object') return { version: INDEX_VERSION, channels: {} }
    return {
      version: INDEX_VERSION,
      channels: idx.channels && typeof idx.channels === 'object' ? idx.channels : {},
    }
  }

  /** 这个通道开没开：索引里写了就用索引的，没写就按通道自己声明的默认值 */
  function isEnabled(id) {
    const idx = readIndex()
    const rec = idx.channels[id]
    if (rec && typeof rec.enabled === 'boolean') return rec.enabled
    const c = byId.get(id)
    return c?.defaultEnabled !== false
  }

  function setEnabled(id, enabled) {
    const idx = readIndex()
    idx.channels[id] = { ...(idx.channels[id] ?? {}), enabled: Boolean(enabled), at: new Date().toISOString() }
    writeJsonSafe(indexFile, idx)
    return isEnabled(id)
  }

  /** 一份通道配置：文件内容盖在 defaults 上。文件不存在/坏了 → 只有 defaults，不炸 ✓ */
  function readChannel(id) {
    const c = byId.get(id)
    const file = fileFor(id)
    const onDisk = readJsonSafe(file)
    const merged = deepMerge(c?.defaults ?? {}, onDisk ?? {})
    if (onDisk === null && fs.existsSync(file)) log(`[whale-core] 通道 ${id} 的配置读不出来（文件坏了？）：${file}`)
    return merged
  }

  /** 有没有真在上面写过东西（决定要不要隐藏敏感字段） */
  function hasFile(id) {
    try { return fs.statSync(fileFor(id)).isFile() } catch { return false }
  }

  function writeChannel(id, incoming) {
    const file = fileFor(id)
    const next = deepMerge(readChannel(id), incoming && typeof incoming === 'object' ? incoming : {})
    writeJsonSafe(file, next)
    return next
  }

  /** 所有通道的开关快照：[{ id, enabled }] */
  function snapshot() {
    return channels.map((c) => ({ id: c.id, enabled: isEnabled(c.id) }))
  }

  return {
    root,
    indexFile,
    fileFor,
    isEnabled,
    setEnabled,
    readChannel,
    writeChannel,
    hasFile,
    snapshot,
    readIndex,
    _internal: { deepMerge, readJsonSafe, writeJsonSafe },
  }
}
