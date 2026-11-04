/**
 * dsh-whale-core · 字段「人话」词典（2026-11-04）
 *
 * 主人：「那些必须留下控制的操控键都留，只不过要让人在控制台操作的时候一眼就懂」
 *
 * 所以：**一个都不砍**，但每个都要有
 *   · 看得懂的中文名（不是 `sticker.perDay`）
 *   · 一句话说清「改了会发生什么」
 *   · 范围 / 单位（0-1 还是 0-100，秒还是分钟）
 *   · 危险标记（改了可能让她不说话/不回你，标出来）
 *
 * ⚠️ 词典里**没有**的字段不许消失 —— 走兜底：显示原名 + 一句「这个还没有说明」，
 *   至少让人知道它存在 ✓（悄悄藏起来 = 主人永远不知道有这个开关 ✗）
 */

/** 每个通道的字段词典：path（点分）-> { label, hint, range?, unit?, danger? } */
export const FIELD_DICT = {
  // ── B 站 ──────────────────────────────────────────────────────────
  bili: {
    'persona.maxChars': { label: '人设最多读多少字', hint: '超过就不读了。0 = 不截断', range: { min: 0, max: 50000, step: 1000 } },
    'self.mid': { label: '她在 B 站的 mid', hint: '体检时自动填，一般不用改' },
    'self.name': { label: '她在 B 站的昵称', hint: '体检时自动填' },
    'owner.mid': { label: '主人（你）的 mid', hint: '她 @ 的就是这个号', danger: true },
    'owner.name': { label: '你的昵称', hint: '她私信你时用的显示名' },
    'proactiveChance': { label: '醒来自动找你的概率', hint: '0.2 = 两成。只在她醒来那一刻掷一次', range: { min: 0, max: 1, step: 0.05 } },
    'proactiveDailyMax': { label: '一天最多主动找你几次', hint: '0 = 。一天都不主动找你', range: { min: 0, max: 10, step: 1 } },
    'dynamicChance': { label: '发动态的概率', hint: '0.3 = 三成，每次醒来掷一次', range: { min: 0, max: 1, step: 0.05 } },
    'dynamicDailyMax': { label: '一天最多发几条动态', hint: '0 = 不发', range: { min: 0, max: 10, step: 1 } },
    'sessionRotateDays': { label: '几天换一次对话', hint: '1 = 过零点就换（换上下文，靠日记接上）。0 = 不换', range: { min: 0, max: 30, step: 1 } },
    'personaOncePerSession': { label: '每个对话只注入一次人设', hint: '开 = 省 token；关 = 每条消息都带完整人设' },
    'night.effort': { label: '醒来干多少活', hint: 'lite = 轻量（省额度）；full = 全套（看视频、推荐）' },
    'night.maxVideos': { label: '一次最多挑几个视频', hint: '轻量模式不用管这个', range: { min: 1, max: 10, step: 1 } },
    'night.share.perDay': { label: '一天最多分享几条视频', hint: '0 = 不分享', range: { min: 0, max: 5, step: 1 } },
    'share.enabled': { label: '能不能分享视频', hint: '关了她就不分享（只刷不推）' },
    'share.via': { label: '分享走哪条路', hint: 'comment = 评论区 @ 你；dm = 私信你' },
    'quota.shareDaily': { label: '分享额度（每天）', hint: '跟上面的分享条数不是一回事：这个是账本上限', range: { min: 0, max: 5, step: 1 } },
    'quota.commentDaily': { label: '一天最多评论几条', hint: '防止刷太频繁', range: { min: 0, max: 20, step: 1 } },
    'listen.dm': { label: '听私信', hint: '开 = 你发私信她能看见' },
    'listen.dmIntervalSec': { label: '多久查一次私信（秒）', hint: '5 秒最灵敏，30 秒最省额度', range: { min: 5, max: 60, step: 1 }, unit: '秒' },
    'listen.shareReplyAsk': { label: '评论下有人说话就来问你', hint: '有人在她 @ 你的评论下回复时，私信问你要不要回' },
    'preferences.like': { label: '她爱看什么', hint: '逗号分隔。这些词会让她刷到的东西偏向这个口味' },
    'preferences.dislike': { label: '她不看什么', hint: '逗号分隔，命中就跳过' },
    'diary.push': { label: '把日记内容推给你', hint: '推的是「给他的信」里最想说的那段' },
    'diary.pushAt': { label: '几点推日记', hint: '格式 HH:MM' },
    'notify.type': { label: '通知方式', hint: 'none 不推 / desktop 桌面 / webhook 网络钩子 / command 自定义命令', danger: true },
    'notify.url': { label: '通知的网址', hint: 'type=webhook 时才用' },
    'risk.writeHourly': { label: '一小时最多写几次', hint: '写 = 发评论/私信/动态。撞满就发不出去了', range: { min: 10, max: 2000, step: 10 }, danger: true },
    'risk.writeDaily': { label: '一天最多写几次', hint: '同上，按天算', range: { min: 50, max: 5000, step: 50 }, danger: true },
    'risk.readDaily': { label: '一天最多读几次', hint: '读 = 刷视频/查消息。撞满会连私信都收不到', range: { min: 1000, max: 50000, step: 1000 }, danger: true },
    'toolsPath': { label: '工具链位置', hint: '一般不用改', danger: true },
    'home': { label: '她的工作目录', hint: '日记、回复文件都在这', danger: true },
  },

  // ── QQ ────────────────────────────────────────────────────────────
  qq: {
    'onebot.baseUrl': { label: 'OneBot 地址', hint: 'NapCat / LLOneBot 的 HTTP 接口，默认 127.0.0.1:3000' },
    'onebot.token': { label: 'OneBot 密码', hint: '敏感；填 ****** 表示不改', danger: true },
    'webui.url': { label: 'NapCat 网页管理地址', hint: '扫码登录走这个，默认 127.0.0.1:6099' },
    'webui.token': { label: 'NapCat 网页管理密码', hint: '敏感；默认 napcat_webui', danger: true },
    'owner.uin': { label: '你的 QQ 号', hint: '只有这个号发的会被当成主人；别人的进待审', danger: true },
    'listen.intervalSec': { label: '多久查一次 QQ 消息（秒）', hint: '越小越灵敏，也越费', range: { min: 2, max: 60, step: 1 }, unit: '秒' },
    'listen.backoffMaxSec': { label: '连不上时最多退到多久（秒）', hint: 'NapCat 挂了的时候别一直猛敲', range: { min: 10, max: 900, step: 10 }, unit: '秒' },
    'reply.file': { label: '她写回复的文件名', hint: '写在 work 目录里，插件读它来发', danger: true },
    'reply.maxLines': { label: '一次最多发几条', hint: '一行 = 一条消息', range: { min: 1, max: 20, step: 1 } },
    'reply.maxChars': { label: '单条最多几个字', hint: '太长会被切成几条', range: { min: 50, max: 2000, step: 50 } },
    'reply.gapMs': { label: '多条之间停顿（毫秒）', hint: '太快像机器人', range: { min: 300, max: 5000, step: 100 }, unit: '毫秒' },
    'poke.enabled': { label: '戳一戳', hint: '你不理她，她戳你一下' },
    'poke.afterMinutes': { label: '多久没理就戳（分钟）', hint: '只在戳一戳开着时有用', range: { min: 5, max: 1440, step: 5 }, unit: '分钟' },
    'voice.enabled': { label: '能发语音', hint: '关了她就只发文字和表情包' },
    'voice.engine': { label: '用谁的声音', hint: 'tts = 系统朗读；file = 用你导入的那段音频' },
    'voice.voice': { label: '音色', hint: '系统里装了的朗读声音，中文的在最前面' },
    'voice.rate': { label: '说话快慢', hint: '-10 很慢 · 0 正常 · 10 很快', range: { min: -10, max: 10, step: 1 } },
    'voice.volume': { label: '音量', hint: '0 到 100', range: { min: 0, max: 100, step: 5 } },
    'voice.maxChars': { label: '一条语音最多念几个字', hint: '太长了就不念了', range: { min: 20, max: 500, step: 10 } },
    'voice.customFile': { label: '导入的音频文件', hint: '在「我的声音」里导入后会自动填上' },
    'sticker.enabled': { label: '能用表情包', hint: '关了她就只发文字' },
    'sticker.perDay': { label: '一天最多存几个表情包', hint: '碰上喜欢的才存，没碰上就不存', range: { min: 0, max: 10, step: 1 } },
    'sticker.maxBytes': { label: '表情包最大多少字节', hint: '太大不存', range: { min: 1048576, max: 33554432, step: 1048576 } },
    'sticker.sendChance': { label: '说话时顺手配个表情包的概率', hint: '0 = 从不 · 1 = 每次', range: { min: 0, max: 1, step: 0.05 } },
    'format.mode': { label: '发什么方式', hint: 'auto = 按下面的权重自己挑；pinned = 固定成一种' },
    'format.pinned': { label: '固定发哪种', hint: 'mode=pinned 时才用：text / voice / sticker' },
    'format.overrideTtlSec': { label: '你临时指定能管多久（秒）', hint: '你说「发语音」之后多久内有效', range: { min: 30, max: 3600, step: 30 }, unit: '秒' },
    'format.weights.text': { label: '文字被挑中的权重', hint: '越大越爱用文字', range: { min: 0, max: 20, step: 1 } },
    'format.weights.voice': { label: '语音被挑中的权重', hint: '0 = 她自己不发语音（你要她还是会发）', range: { min: 0, max: 20, step: 1 } },
    'format.weights.sticker': { label: '表情包被挑中的权重', hint: '0 = 她自己不发表情包', range: { min: 0, max: 20, step: 1 } },
    'wake.sessionId': { label: '叫醒她用哪个对话', hint: '默认跟 B 站共用同一个（记忆才连得上）', danger: true },
  },
}

/** 分组标题：path 的第一个点分段 -> 人话标题 */
export const GROUP_TITLES = {
  bili: {
    persona: '她的人设', self: '她在 B 站的身份', owner: '你（主人）',
    preferences: '口味', night: '作息与醒来', share: '分享视频', quota: '额度账本',
    listen: '收消息', diary: '日记推送', notify: '通知方式', risk: '风险限额（撞满就发不出去）',
    toolsPath: '工具链', home: '数据目录', sessionRotateDays: '对话轮换', personaOncePerSession: '人设注入',
    proactiveChance: '主动找你', proactiveDailyMax: '主动找你', dynamicChance: '发动态', dynamicDailyMax: '发动态',
  },
  qq: {
    onebot: '连 NapCat（收发消息）', webui: '连 NapCat 网页（扫码登录）', owner: '你（主人）',
    listen: '收消息', reply: '她怎么回话', poke: '戳一戳', voice: '语音',
    sticker: '表情包', format: '发什么方式（文字/语音/表情包）', wake: '叫醒她用哪个对话',
  },
}

/** 分组里的人话顺序（先常改的，后少动的） */
export const GROUP_ORDER = {
  bili: ['owner', 'preferences', 'night', 'share', 'listen', 'diary', 'notify',
    'proactiveChance', 'proactiveDailyMax', 'dynamicChance', 'dynamicDailyMax',
    'sessionRotateDays', 'personaOncePerSession', 'persona', 'self',
    'quota', 'risk', 'toolsPath', 'home'],
  qq: ['onebot', 'webui', 'owner', 'listen', 'reply', 'format', 'voice', 'sticker', 'poke', 'wake'],
}

/**
 * 查一个字段的说明。查不到就返回兜底（**别让字段消失** ✗）
 */
export function describeField(channelId, path) {
  const dict = FIELD_DICT[channelId] ?? {}
  const hit = dict[path]
  if (hit) return hit
  return {
    label: path.split('.').pop(),
    hint: '这个还没有写说明（能改，但改之前先问一下）',
    unmapped: true,
  }
}

/** 分组标题 */
export function describeGroup(channelId, key) {
  return (GROUP_TITLES[channelId] ?? {})[key] ?? key
}

/** 按配置对象分出「先显示哪些组、什么顺序」 */
export function groupOrder(channelId, keys) {
  const order = GROUP_ORDER[channelId] ?? []
  const known = keys.filter((k) => order.includes(k)).sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const rest = keys.filter((k) => !order.includes(k)).sort()
  return [...known, ...rest]
}
