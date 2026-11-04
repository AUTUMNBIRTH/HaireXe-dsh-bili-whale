/**
 * dsh-whale-core · 「两条鱼各会什么」的对照表（2026-11-04）
 *
 * 主人：「一点说清楚，让人简单易懂」。
 * 一堆字段要翻半天才看懂，一张表三秒看完 ✓
 *
 * 这个文件是**纯函数**（不碰 React），所以能测；控制台只负责画它。
 */

/** 功能清单：每行一个能力。only = 这个能力天生只有哪个通道有（null = 谁都可以） */
export const FEATURES = [
  { key: 'dm', name: '跟你私聊', desc: '她主动找你、你发消息她回你', only: null },
  { key: 'share', name: '分享视频', desc: '看到好的视频 @ 你', only: 'bili' },
  { key: 'dynamic', name: '发动态', desc: '在那边发一条公开动态', only: null },
  { key: 'stickerButler', name: '表情包要存着用', desc: '一天最多存一个，碰上喜欢的才存', only: 'qq' },
  { key: 'voice', name: '发语音', desc: '用声音跟你说话', only: 'qq' },
  { key: 'approve', name: '别人说话先问你', desc: '陌生人发来的话先给你过目，你点头才回', only: 'qq' },
]

/**
 * 算出一行一行的表格。
 * @param {object} p
 * @param {string[]} p.channels   现在装着哪些通道（['bili','qq']）
 * @param {object} p.caps         { bili: {...}, qq: {...} } 来自 /channels 的 caps
 * @param {Array}  [p.features]   自定义功能清单（测试用）
 * @returns {{ name, desc, cells: { [id]: boolean } }[]}
 */
export function featureMatrix({ channels = [], caps = {}, features = FEATURES } = {}) {
  return features.map((f) => ({
    key: f.key,
    name: f.name,
    desc: f.desc,
    cells: Object.fromEntries(channels.map((id) => [id, canDo(id, f, caps[id] ?? {})])),
  }))
}

function canDo(id, feature, cap) {
  // ① 这个能力天生只有某个通道有 —— 别的通道当选了也给不了
  if (feature.only && feature.only !== id) return false
  // ② 通道自己关着 → 什么都不做
  if (cap.on === false) return false
  switch (feature.key) {
    case 'dm': return cap.dm === true
    case 'share': return cap.share === true
    case 'dynamic': return cap.dynamic === true
    // 下面三个是 QQ 独有的实现，只要它开着就有
    case 'sticker':
    case 'voice':
    case 'stickerButler':
    case 'approve':
      return cap.on === true
    default:
      return false
  }
}
