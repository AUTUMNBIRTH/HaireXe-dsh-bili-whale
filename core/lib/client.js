/**
 * dsh-whale-core · 客户端半边：「养鱼」总控制台（2026-11-04 重做）
 *
 * ⚠️ 重做前是「三个页面各显示一堆字段」：通道页、B 站老页、QQ 页 —— 一样的东西散在三处，
 *   主人说「控制台也直观一点，不要让人看起来很迷糊」。所以这版按**他问的问题**来分区，
 *   不按代码结构分区：
 *
 *     ① 现在是什么状态   —— 一句话说清楚（主通道是谁、私聊走哪、动态走哪）
 *     ② 两个通道      —— 各自的开关 + 现在能干什么
 *     ③ 发消息         —— 私聊走哪个（只能一个）/ 发动态走哪个
 *     ④ 记忆           —— 共用一份（两个通道写同一本日记）
 *     ⑤ 详细设置       —— 折叠起来，平时不用看
 *
 * 数据来源：GET /dsh-whale/api/channels（带 caps/share）、GET/POST /dsh-whale/api/shared
 */
window.__ModuleLoader__.load({
  id: "dsh-whale-core",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useState } = React;

    // 2026-11-04：字段的「人话」词典和 core 的规则一起放在 lib/field-dict.js
    //   客户端 bundle 读取不到服务端模块 ✗ → 把词典**原样内联**进来
    //   ⚠️ 内联 = 两份会漂。所以 field-dict.js 里留了同样的表，改一边必须改另一边，
    //     并且由 tests/field-dict.test.mjs 盯着关键项（label/hint 不许为空）✓
    const FIELD_DICT = {
      qq: {
        "onebot.baseUrl": { label: "OneBot 地址", hint: "NapCat / LLOneBot 的 HTTP 接口，默认 127.0.0.1:3000" },
        "onebot.token": { label: "OneBot 密码", hint: "敏感；填 ****** 表示不改", danger: true },
        "webui.url": { label: "NapCat 网页管理地址", hint: "扫码登录走这个，默认 127.0.0.1:6099" },
        "webui.token": { label: "NapCat 网页管理密码", hint: "敏感；默认 napcat_webui", danger: true },
        "owner.uin": { label: "你的 QQ 号", hint: "只有这个号发的会被当成主人；别人的进待审", danger: true },
        "listen.intervalSec": { label: "多久查一次 QQ 消息（秒）", hint: "越小越灵敏，也越费", range: { min: 2, max: 60, step: 1 } },
        "listen.backoffMaxSec": { label: "连不上时最多退到多久（秒）", hint: "NapCat 挂了的时候别一直猛敲", range: { min: 10, max: 900, step: 10 } },
        "reply.file": { label: "她写回复的文件名", hint: "写在 work 目录里，插件读它来发", danger: true },
        "reply.maxLines": { label: "一次最多发几条", hint: "一行 = 一条消息", range: { min: 1, max: 20, step: 1 } },
        "reply.maxChars": { label: "单条最多几个字", hint: "太长会被切成几条", range: { min: 50, max: 2000, step: 50 } },
        "reply.gapMs": { label: "多条之间停顿（毫秒）", hint: "太快像机器人", range: { min: 300, max: 5000, step: 100 } },
        "poke.enabled": { label: "戳一戳", hint: "你不理她，她戳你一下" },
        "poke.afterMinutes": { label: "多久没理就戳（分钟）", hint: "只在戳一戳开着时有用", range: { min: 5, max: 1440, step: 5 } },
        "voice.enabled": { label: "能发语音", hint: "关了她就只发文字和表情包" },
        "voice.engine": { label: "用谁的声音", hint: "tts = 系统朗读；file = 用你导入的那段音频" },
        "voice.voice": { label: "音色", hint: "系统里装了的朗读声音，中文的在最前面" },
        "voice.rate": { label: "说话快慢", hint: "-10 很慢 · 0 正常 · 10 很快", range: { min: -10, max: 10, step: 1 } },
        "voice.volume": { label: "音量", hint: "0 到 100", range: { min: 0, max: 100, step: 5 } },
        "voice.maxChars": { label: "一条语音最多念几个字", hint: "太长了就不念了", range: { min: 20, max: 500, step: 10 } },
        "voice.customFile": { label: "导入的音频文件", hint: "在「我的声音」里导入后会自动填上" },
        "sticker.enabled": { label: "能用表情包", hint: "关了她就只发文字" },
        "sticker.perDay": { label: "一天最多存几个表情包", hint: "碰上喜欢的才存，没碰上就不存", range: { min: 0, max: 10, step: 1 } },
        "sticker.maxBytes": { label: "表情包最大多少字节", hint: "太大不存", range: { min: 1048576, max: 33554432, step: 1048576 } },
        "sticker.sendChance": { label: "说话时顺手配个表情包的概率", hint: "0 = 从不 · 1 = 每次", range: { min: 0, max: 1, step: 0.05 } },
        "format.mode": { label: "发什么方式", hint: "auto = 按下面的权重自己挑；pinned = 固定成一种" },
        "format.pinned": { label: "固定发哪种", hint: "mode=pinned 时才用：text / voice / sticker" },
        "format.overrideTtlSec": { label: "你临时指定能管多久（秒）", hint: "你说「发语音」之后多久内有效", range: { min: 30, max: 3600, step: 30 } },
        "format.weights.text": { label: "文字被挑中的权重", hint: "越大越爱用文字", range: { min: 0, max: 20, step: 1 } },
        "format.weights.voice": { label: "语音被挑中的权重", hint: "0 = 她自己不发语音（你要她还是会发）", range: { min: 0, max: 20, step: 1 } },
        "format.weights.sticker": { label: "表情包被挑中的权重", hint: "0 = 她自己不发表情包", range: { min: 0, max: 20, step: 1 } },
        "wake.sessionId": { label: "叫醒她用哪个对话", hint: "默认跟 B 站共用同一个（记忆才连得上）", danger: true },
      },
      bili: {
        "self.mid": { label: "她在 B 站的 mid", hint: "体检时自动填，一般不用改" },
        "self.name": { label: "她在 B 站的昵称", hint: "体检时自动填" },
        "owner.mid": { label: "主人（你）的 mid", hint: "她 @ 的就是这个号", danger: true },
        "owner.name": { label: "你的昵称", hint: "她私信你时用的显示名" },
        "proactiveChance": { label: "醒来自动找你的概率", hint: "0.2 = 两成。只在她醒来那一刻掷一次", range: { min: 0, max: 1, step: 0.05 } },
        "proactiveDailyMax": { label: "一天最多主动找你几次", hint: "0 = 一天都不主动找你", range: { min: 0, max: 10, step: 1 } },
        "dynamicChance": { label: "发动态的概率", hint: "0.3 = 三成，每次醒来掷一次", range: { min: 0, max: 1, step: 0.05 } },
        "dynamicDailyMax": { label: "一天最多发几条动态", hint: "0 = 不发", range: { min: 0, max: 10, step: 1 } },
        "sessionRotateDays": { label: "几天换一次对话", hint: "1 = 过零点就换（换上下文，靠日记接上）。0 = 不换", range: { min: 0, max: 30, step: 1 } },
        "personaOncePerSession": { label: "每个对话只注入一次人设", hint: "开 = 省 token；关 = 每条消息都带完整人设" },
        "night.effort": { label: "醒来干多少活", hint: "lite = 轻量（省额度）；full = 全套（看视频、推荐）" },
        "night.maxVideos": { label: "一次最多挑几个视频", hint: "轻量模式不用管这个", range: { min: 1, max: 10, step: 1 } },
        "night.share.perDay": { label: "一天最多分享几条视频", hint: "0 = 不分享", range: { min: 0, max: 5, step: 1 } },
        "share.enabled": { label: "能不能分享视频", hint: "关了她就不分享（只刷不推）" },
        "share.via": { label: "分享走哪条路", hint: "comment = 评论区 @ 你；dm = 私信你" },
        "quota.shareDaily": { label: "分享额度（每天）", hint: "跟上面的分享条数不是一回事：这个是账本上限", range: { min: 0, max: 5, step: 1 } },
        "quota.commentDaily": { label: "一天最多评论几条", hint: "防止刷太频繁", range: { min: 0, max: 20, step: 1 } },
        "listen.dm": { label: "听私信", hint: "开 = 你发私信她能看见" },
        "listen.dmIntervalSec": { label: "多久查一次私信（秒）", hint: "5 秒最灵敏，30 秒最省额度", range: { min: 5, max: 60, step: 1 } },
        "listen.shareReplyAsk": { label: "评论下有人说话就来问你", hint: "有人在她 @ 你的评论下回复时，私信问你要不要回" },
        "preferences.like": { label: "她爱看什么", hint: "逗号分隔。这些词会让她刷到的东西偏向这个口味" },
        "preferences.dislike": { label: "她不看什么", hint: "逗号分隔，命中就跳过" },
        "diary.push": { label: "把日记内容推给你", hint: "推的是「给他的信」里最想说的那段" },
        "diary.pushAt": { label: "几点推日记", hint: "格式 HH:MM" },
        "notify.type": { label: "通知方式", hint: "none 不推 / desktop 桌面 / webhook 网络钩子 / command 自定义命令", danger: true },
        "notify.url": { label: "通知的网址", hint: "type=webhook 时才用" },
        "risk.writeHourly": { label: "一小时最多写几次", hint: "写 = 发评论/私信/动态。撞满就发不出去了", range: { min: 10, max: 2000, step: 10 }, danger: true },
        "risk.writeDaily": { label: "一天最多写几次", hint: "同上，按天算", range: { min: 50, max: 5000, step: 50 }, danger: true },
        "risk.readDaily": { label: "一天最多读几次", hint: "读 = 刷视频/查消息。撞满会连私信都收不到", range: { min: 1000, max: 50000, step: 1000 }, danger: true },
        "persona.maxChars": { label: "人设最多读多少字", hint: "超过就不读了。0 = 不截断", range: { min: 0, max: 50000, step: 1000 } },
        "toolsPath": { label: "工具链位置", hint: "一般不用改", danger: true },
        "home": { label: "她的工作目录", hint: "日记、回复文件都在这", danger: true },
      },
    };
    const GROUP_TITLES = {
      bili: { persona: "她的人设", self: "她在 B 站的身份", owner: "你（主人）", preferences: "口味",
        night: "作息与醒来", share: "分享视频", quota: "额度账本", listen: "收消息", diary: "日记推送",
        notify: "通知方式", risk: "风险限额（撞满就发不出去）", toolsPath: "工具链", home: "数据目录",
        sessionRotateDays: "对话轮换", personaOncePerSession: "人设注入",
        proactiveChance: "主动找你", proactiveDailyMax: "主动找你", dynamicChance: "发动态", dynamicDailyMax: "发动态" },
      qq: { onebot: "连 NapCat（收发消息）", webui: "连 NapCat 网页（扫码登录）", owner: "你（主人）",
        listen: "收消息", reply: "她怎么回话", poke: "戳一戳", voice: "语音",
        sticker: "表情包", format: "发什么方式（文字/语音/表情包）", wake: "叫醒她用哪个对话" },
    };
    const GROUP_ORDER = {
      bili: ["owner", "preferences", "night", "share", "listen", "diary", "notify",
        "proactiveChance", "proactiveDailyMax", "dynamicChance", "dynamicDailyMax",
        "sessionRotateDays", "personaOncePerSession", "persona", "self", "quota", "risk", "toolsPath", "home"],
      qq: ["onebot", "webui", "owner", "listen", "reply", "format", "voice", "sticker", "poke", "wake"],
    };
    function describeField(channelId, path) {
      const hit = (FIELD_DICT[channelId] ?? {})[path];
      return hit ?? { label: path.split(".").pop(), hint: "这个还没有写说明（能改，但改之前先问一下）", unmapped: true };
    }
    const describeGroup = (channelId, key) => (GROUP_TITLES[channelId] ?? {})[key] ?? key;
    function groupOrder(channelId, keys) {
      const order = GROUP_ORDER[channelId] ?? [];
      const known = keys.filter((k) => order.includes(k)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const rest = keys.filter((k) => !order.includes(k)).sort();
      return [...known, ...rest];
    }

    const API = "/dsh-whale/api";
    const CSS_TAG = "dsh-whale-core/section.css";
    const CSS = [
      ".dwc{max-width:820px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:10px}",
      ".dwc-title{margin:0;font-size:17px;font-weight:600;line-height:26px}",
      ".dwc-sub{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12.5px;line-height:19px}",
      ".dwc-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;background:rgba(127,127,127,.03)}",
      ".dwc-head{display:flex;align-items:center;gap:8px;padding:11px 14px;background:rgba(127,127,127,.06)}",
      ".dwc-head .dwc-h{font-size:13.5px;font-weight:600}",
      ".dwc-head .dwc-grow{flex:1}",
      ".dwc-body{padding:6px 14px 14px}",
      ".dwc-dot{width:8px;height:8px;border-radius:50%;background:#2fbf71;flex:none}",
      ".dwc-dot.off{background:#9aa0a6}",
      ".dwc-dot.warn{background:#ffb020}",
      ".dwc-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
      ".dwc-row:last-child{border-bottom:none}",
      ".dwc-row>div:first-child{flex:1;min-width:200px}",
      ".dwc-label{font-size:13px;line-height:19px}",
      ".dwc-hint{color:var(--dsw-alias-label-tertiary);margin-top:2px;font-size:11.5px;line-height:17px}",
      ".dwc-input{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:150px;outline:none}",
      ".dwc-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}",
      ".dwc-btn:disabled{opacity:.5;cursor:default}",
      ".dwc-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".dwc-pill{display:inline-block;font-size:11px;line-height:17px;padding:1px 8px;border-radius:999px;margin:0 4px 4px 0;background:rgba(127,127,127,.13);color:var(--dsw-alias-label-secondary)}",
      ".dwc-pill.on{background:rgba(47,191,113,.18);color:#1e8a50}",
      ".dwc-pill.off{opacity:.45;text-decoration:line-through}",
      ".dwc-summary{font-size:13px;line-height:21px}",
      ".dwc-summary b{font-weight:600}",
      ".dwc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}",
      ".dwc-out{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:9px 11px;max-height:220px;overflow:auto;margin-top:8px}",
      ".dwc-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-line}",
      // 2026-11-04：点了「未配置」的入口时弹的提示条 —— 要显眼但不刺眼
      ".dwc-notice{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;background:rgba(255,176,32,.12);border:.5px solid rgba(255,176,32,.35);color:#9a6b00;font-size:12px;line-height:18px}",
      ".dwc-ok{color:#1e8a50;font-size:12px;line-height:18px;white-space:pre-line}",
      ".dwc-details{margin-top:2px}",
      ".dwc-details>summary{cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary);padding:8px 0;user-select:none}",
      ".dwc-grp{margin:10px 0 4px}",
      ".dwc-grp-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:6px 0 2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
      ".dwc-path{font-size:10.5px;color:var(--dsw-alias-label-tertiary);opacity:.7;margin-top:1px;font-family:ui-monospace,Menlo,monospace}",
      ".dwc-danger{font-size:10.5px;color:#c4551a;background:rgba(196,85,26,.12);border-radius:4px;padding:0 5px;margin-left:4px}",
      ".dwc-table{display:flex;flex-direction:column}",
      ".dwc-tr{display:grid;grid-template-columns:1fr 90px 90px;align-items:center;gap:8px;padding:7px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
      ".dwc-tr.dwc-th{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".dwc-yes{color:#1e8a50;font-weight:600}",
      ".dwc-no{color:var(--dsw-alias-label-tertiary);opacity:.5}",
      ".dwc-unmapped{font-size:10.5px;color:var(--dsw-alias-label-tertiary);border-radius:4px;padding:0 5px;margin-left:4px;border:.5px dashed var(--dsw-alias-border-l2)}",

      // ── 2026-11-04 新增：大字结论 / 能力表 / 分段选择 / 开关 ──
      // 原则：一眼能看出「状态」和「能不能点」，别让人去猜哪种按钮是开那种是选
      ".dwc-hero{padding:14px 16px;border-radius:10px;background:rgba(127,127,127,.07);border:.5px solid var(--dsw-alias-border-l2)}",
      ".dwc-hero-main{font-size:15px;line-height:24px;font-weight:600}",
      ".dwc-hero-main b{font-weight:700}",
      ".dwc-hero-off{font-weight:400;color:var(--dsw-alias-label-tertiary);margin-left:4px;font-size:13px}",
      ".dwc-hero-sub{font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary);margin-top:4px}",

      ".dwc-arow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
      ".dwc-arow:last-child{border-bottom:none}",
      ".dwc-arow-off{opacity:.72}",
      ".dwc-aname{flex:1;min-width:180px}",
      ".dwc-aval{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none}",

      // 分段选择器：选中的实心、没选的空框 —— 一看就知道「这是单选」
      ".dwc-seg{display:inline-flex;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;overflow:hidden}",
      ".dwc-segbtn{background:transparent;border:none;border-right:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:4px 12px;cursor:pointer}",
      ".dwc-segbtn:last-child{border-right:none}",
      ".dwc-segbtn:hover{background:rgba(127,127,127,.1)}",
      ".dwc-segbtn.on{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}",
      ".dwc-segbtn.dead{opacity:.45;text-decoration:line-through}",
      ".dwc-segdead{font-size:9.5px;margin-left:4px;opacity:.9;text-decoration:none;display:inline-block}",

      // 开关：圆角胶囊 + 开时上色，和「选择」形状不同
      ".dwc-switch{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:999px;font-size:11.5px;height:26px;padding:0 14px;cursor:pointer;flex:none}",
      ".dwc-switch.on{background:rgba(47,191,113,.16);border-color:rgba(47,191,113,.5);color:#1e8a50;font-weight:600}",
      ".dwc-switch:disabled{opacity:.5;cursor:default}",

      ".dwc-pillbtn{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:999px;font-size:11.5px;height:26px;padding:0 14px;cursor:pointer}",
      ".dwc-pillbtn.on{background:rgba(47,191,113,.16);border-color:rgba(47,191,113,.5);color:#1e8a50;font-weight:600}",

      ".dwc-state{font-size:12.5px;color:var(--dsw-alias-label-secondary)}",
      ".dwc-state-ok{color:#1e8a50;font-weight:600}",
      ".dwc-hero-note{color:var(--dsw-alias-label-tertiary);font-size:11.5px;margin-top:6px;padding-top:6px;border-top:.5px dashed var(--dsw-alias-border-l2)}",
      ".dwc-why{font-size:11px;line-height:16px;color:#c4551a}",
      ".dwc-tag{font-size:10px;line-height:15px;padding:0 5px;margin-left:5px;border-radius:4px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-tertiary);font-weight:400}",
      ".dwc-linkbtn{background:none;border:none;color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer;padding:0 2px}",
      ".dwc-linkbtn:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}",

      // 两条鱼那一行
      ".dwc-fish{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
      ".dwc-fish:last-of-type{border-bottom:none}",
      ".dwc-fish.off{opacity:.7}",
      ".dwc-fish-name{font-size:13px;font-weight:600}",
      ".dwc-fish-state{flex:1;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}",

      // 2026-11-04：总控制台底部只留一句「去各自页面改」，不再放设置项
      ".dwc-foot{background:rgba(127,127,127,.05)}",
      ".dwc-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}",
      ".dwc-linkchip{font-size:11.5px;line-height:18px;padding:2px 10px;border-radius:999px;background:rgba(127,127,127,.12);color:var(--dsw-alias-label-secondary)}",

      // 2026-11-04：她还是同一个人
      ".dwc-same-row{display:flex;gap:10px;padding:5px 0;align-items:baseline}",
      ".dwc-same-k{width:96px;flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}",
      ".dwc-same-v{flex:1;font-size:12px;color:var(--dsw-alias-label-primary);line-height:19px}",
    ].join("");

    function useStyleOnce() {
      useEffect(() => {
        if (document.getElementById(CSS_TAG)) return;
        const el = document.createElement("style");
        el.id = CSS_TAG;
        el.textContent = CSS;
        document.head.appendChild(el);
      }, []);
    }

    const LABEL = { bili: "B 站", qq: "QQ" };
    const nameOf = (id) => LABEL[id] ?? id;

    /**
     * 把 HTTP 状态翻成人话。
     *
     * ⚠️ 2026-11-04：这里原来只有 `throw new Error(j.error || \`HTTP ${r.status}\`)` ——
     *   设置页上就显示成「读取配置失败：HTTP 404」，谁也看不出到底缺什么 ✗
     *   404 尤其难猜：它可能是「通道没登记」，也可能是「路由形状不对」，还可能是
     *   「打到了 SPA fallback」（宿主对没匹配上的请求回一个**空的** 404）。
     *   响应体是空的 = 最后一种 ✓
     */
    function explain(status, body, path) {
      const detail = body && body.error ? `：${body.error}` : "";
      const hint = body && body.hint ? `。${body.hint}` : "";
      if (status === 404) {
        if (!body || !body.error) {
          return "HTTP 404（请求没落到养鱼接口上，被宿主的静态页兜底接走了 —— 通常是 whale-core 的路由没挂上，需要完整重启 DSH）";
        }
        return `HTTP 404${detail}${hint}`;
      }
      if (status === 401) return "HTTP 401（DSH 登录态过期了，刷新页面重新登录）";
      if (status === 403) return "HTTP 403（被信任栅栏拒绝：请用 127.0.0.1 打开这个页面）";
      if (status === 409) return `HTTP 409${detail || "（通道现在是关的，先打开再操作）"}`;
      if (status >= 500) return `HTTP ${status}${detail || "（养鱼服务端出错了，看 DSH 启动日志里 [whale-core] 那几行）"}`;
      return `HTTP ${status}${detail}`;
    }

    const api = {
      async get(path) {
        const r = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(explain(r.status, j, path));
        return j ?? {};
      },
      async post(path, body) {
        const r = await fetch(`${API}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body ?? {}),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || j?.ok === false) throw new Error(explain(r.status, j, path));
        return j ?? {};
      },
    };

    // ══════════════════════════════════════════════════════════════════
    // 2026-11-04 重做：「让人看一眼就懂」
    //
    // 之前的问题（把页面按真实数据文字化渲染出来之后，一眼就看到了）：
    //   ① 四张卡片在说同一件事 —— ①说「B 站跟你私聊、B 站发动态、分享视频只有 B 站」，
    //      ③又让你选一遍「陪你聊天的是谁 / 发动态走哪边 / 分享视频」，⑤再画一张表说一遍 ✗
    //   ② 关掉的鱼在⑤里显示成「—」，和「没轮到它」长得一样 —— 分不清是没开还是没分到 ✗
    //   ③ 「灰掉的就是没轮到它」「✓ = 现在在做」这种话，得先看懂代码的人才知道在说什么 ✗
    //   ④ 开关按钮和选择按钮长得一模一样，分不清哪个是开/关、哪个是选哪边 ✗
    //
    // 现在的结构（从「结论」到「细节」，一件事只说一遍）：
    //   ① 顶上三行大字 —— 现在到底在干什么
    //   ② 一张表 —— 每件事归谁，右边能改；灰的那行写清楚**为什么**不做
    //   ③ 两条鱼：各自开没开 + 开关
    //   ④ 记忆和作息（两条鱼共用）
    //   ⑤ 全部设置（折叠，不展开不占地方）
    // ══════════════════════════════════════════════════════════════════

    // 每条鱼会哪些「天生」的能力（跟 lib/features.js 的 canDo 同一套规则，测试盯着两边一致）
    const FEATURES = [
      { key: "dm", name: "跟你私聊", desc: "她主动找你，你发消息她回你", pick: "dm", sides: "both" },
      { key: "dynamic", name: "发动态", desc: "在那边的空间发一条公开动态", pick: "dynamic", sides: "both" },
      { key: "share", name: "分享视频", desc: "看到好视频就推给你", only: "bili", toggle: "share" },
      { key: "stickerButler", name: "存表情包", desc: "一天最多存一个，碰上喜欢的才存", only: "qq" },
      { key: "voice", name: "发语音", desc: "用声音跟你说话", only: "qq" },
      { key: "approve", name: "别人说话先问你", desc: "陌生人发来的话先给你过目，你点头才回", only: "qq" },
    ]

    function canDo(id, feature, cap) {
      if (feature.only && feature.only !== id) return false;
      if (cap.on === false) return false;
      switch (feature.key) {
        case "dm": return cap.dm === true;
        case "share": return cap.share === true;
        case "dynamic": return cap.dynamic === true;
        default: return cap.on === true;
      }
    }

    /**
     * 一句话总结：现在她在哪儿跟你说话。
     *
     * ⚠️ 2026-11-04 主人纠错：「我想做的是一条鱼控制两个插件，所以记忆本备份只有桌面一份，
     *   只不过是选择 qq 还是哔站使用不同而已」
     *   我原来写的是「两条鱼」—— 那是**错的**。
     *   整件事其实是：
     *       一条鱼（同一个人格、同一本日记、同一段记忆）
     *       + 两个说话的地方（QQ / B 站）
     *       + 在哪边说、由谁发，由下面的「谁做什么」决定
     *   所以这里一律说「她」，只有指**入口**时才说「QQ / B 站」✗→✓
     */
    function Summary({ data }) {
      const s = data.shared ?? {};
      const chans = data.channels ?? [];
      const onIds = chans.filter((c) => c.enabled).map((c) => c.id);
      const offIds = chans.filter((c) => !c.enabled).map((c) => c.id);

      if (onIds.length === 0) {
        return h("div", { className: "dwc-hero" },
          h("div", { className: "dwc-hero-main" }, "她现在哪个入口都没开"),
          h("div", { className: "dwc-hero-sub" }, "两个入口（QQ、B 站）都关着，所以谁也找不到她。在下面打开一个就行。"));
      }

      const dmIsOn = onIds.includes(s.dm);
      const dynIsOn = onIds.includes(s.dynamic);
      const list = (ids) => ids.map(nameOf).join(" 和 ");
      return h("div", { className: "dwc-hero" },
        h("div", { className: "dwc-hero-main" },
          "她的入口：", h("b", null, list(onIds)),
          offIds.length ? h("span", { className: "dwc-hero-off" }, `（${list(offIds)} 关着）`) : null),
        h("div", { className: "dwc-hero-sub" },
          dmIsOn
            ? `她会在 ${nameOf(s.dm)} 上陪你聊天`
            : `聊天被分配给 ${nameOf(s.dm)}，但那个入口关着 —— 现在没人陪你聊`),
        h("div", { className: "dwc-hero-sub" },
          dynIsOn
            ? `她的动态走 ${nameOf(s.dynamic)}`
            : `动态被分配给 ${nameOf(s.dynamic)}，但那个入口关着 —— 现在不发`),
        h("div", { className: "dwc-hero-sub dwc-hero-note" },
          "她还是同一个人：日记、记忆、人设只有一份，不管你在哪边跟她说话。"));
    }

    /**
     * ② 一张表：每件事归谁
     *   · 左边是「这件事」，右边是给谁做（能点的按钮 = 可以改）
     *   · 灰掉的行**必须写原因**，不能只画一个 —（那是之前最难懂的地方）
     *
     * ⚠️ 2026-11-04 主人要求：
     *   「只配置了哔站的话总控制台里就选不了 QQ，只配置了 qq 的话就选不了哔站，
     *    会提醒未配置该功能」
     *   → 没配置好的入口，选项**灰掉 + 划掉 + 标「未配置」**，点了也弹一句为什么 ✓
     *     （之前只判断「开没开」，没判断「装没装/登没登录」✗）
     */
    function AbilityTable({ data, onSave, notice, setNotice }) {
      const s = data.shared ?? {};
      const chans = data.channels ?? [];
      const capsById = Object.fromEntries(chans.map((c) => [c.id, c.caps ?? {}]));
      const enabledOf = Object.fromEntries(chans.map((c) => [c.id, c.enabled]));
      const setupOf = Object.fromEntries(chans.map((c) => [c.id, c.setup ?? { ok: true }]));
      const ready = (id) => setupOf[id]?.ok !== false;

      // 一行「谁在做这件事」
      const pickRow = (feature) => {
        const isOn = enabledOf[s[feature.pick]] && ready(s[feature.pick]);
        const unavailable = chans.every((c) => !ready(c.id));
        return h("div", { className: "dwc-arow" + (isOn ? "" : " dwc-arow-off"), key: feature.key },
          h("div", { className: "dwc-aname" },
            h("div", { className: "dwc-label" }, feature.name),
            h("div", { className: "dwc-hint" }, feature.desc)),
          h("div", { className: "dwc-aval" },
            h("div", { className: "dwc-seg" }, chans.map((c) => {
              const selected = s[feature.pick] === c.id;
              const ok = ready(c.id);
              // 三种状态，一眼分清：
              //   ① 未配置 → 灰掉划掉 + 标「未配置」，点了提示怎么配
              //   ② 已配置但关着 → 灰掉 + 标「关着」
              //   ③ 正常 → 可点
              const dead = !ok || (!c.enabled && !selected);
              const tag = !ok ? "未配置" : (!c.enabled && !selected ? "关着" : null);
              const title = !ok ? `${nameOf(c.id)}：${setupOf[c.id]?.reason ?? "未配置"}` : (tag === "关着" ? `${nameOf(c.id)} 现在是关着的，选了也没人做` : undefined);
              return h("button", {
                key: c.id,
                className: "dwc-segbtn" + (selected ? " on" : "") + (dead ? " dead" : ""),
                title,
                onClick: () => {
                  if (!ok) {
                    setNotice?.(`选不了「${nameOf(c.id)}」：${setupOf[c.id]?.reason ?? "未配置"}${setupOf[c.id]?.hint ? " —— " + setupOf[c.id].hint : ""}`);
                    return;
                  }
                  if (s[feature.pick] !== c.id) onSave({ [feature.pick]: c.id });
                },
              }, nameOf(c.id), tag ? h("span", { className: "dwc-segdead" }, tag) : null);
            })),
            isOn ? null : h("div", { className: "dwc-why" },
              unavailable
                ? "两个入口都没配置好 —— 先去「养鱼 · B站」或「养鱼 · QQ」把它配好"
                : `现在是 ${nameOf(s[feature.pick])} 做这件事，但它${ready(s[feature.pick]) ? "关着" : "还没配置好"} —— 没人做`)));
      };

      // 一行「某条鱼独有的能力」（开关或纯展示）
      const soloRow = (feature) => {
        const id = feature.only;
        const enabled = enabledOf[id];
        const ok = ready(id);
        const cap = capsById[id] ?? {};
        let on;
        let why = "";
        if (feature.toggle === "share") {
          on = s.share !== false && enabled && cap.on !== false;
          if (s.share === false) why = "你把它关了";
          else if (!ok) why = `${nameOf(id)} 还没配置`;
          else if (!enabled) why = `${nameOf(id)} 关着`;
        } else {
          on = canDo(id, feature, cap);
          if (!ok) why = `${nameOf(id)} 还没配置`;
          else if (!enabled) why = `${nameOf(id)} 关着`;
          else if (cap.on === false) why = "这条鱼关了";
        }
        return h("div", { className: "dwc-arow" + (on ? "" : " dwc-arow-off"), key: feature.key },
          h("div", { className: "dwc-aname" },
            h("div", { className: "dwc-label" }, feature.name, h("span", { className: "dwc-tag" }, `只有 ${nameOf(id)}`)),
            h("div", { className: "dwc-hint" }, feature.desc)),
          h("div", { className: "dwc-aval" },
            feature.toggle === "share"
              ? h("button", {
                  className: "dwc-pillbtn" + (s.share !== false ? " on" : ""),
                  onClick: () => onSave({ share: s.share === false }),
                }, s.share !== false ? "会推给你" : "不推")
              : h("span", { className: "dwc-state" }, on ? "会" : "不会"),
            why ? h("div", { className: "dwc-why" }, why) : null));
      };

      return h("div", { className: "dwc-card" },
        h("div", { className: "dwc-head" }, h("span", { className: "dwc-h" }, "谁做什么"),
          h("span", { className: "dwc-hint dwc-grow" }, "能点的地方就是能改的")),
        h("div", { className: "dwc-body" },
          FEATURES.filter((f) => f.pick).map(pickRow),
          FEATURES.filter((f) => f.only).map(soloRow)));
    }

    // ③ 两条鱼：开没开 + 开关
    /**
     * 她还是同一个人吗（2026-11-04）
     *
     * 主人最后的要求：「确保切换养鱼方式后再私聊还是在同一个上下文，还记得东西」
     *
     * 这张卡不是设置，是**状态说明** —— 让人一眼确认：
     *   · 两个入口用的是同一个对话
     *   · 日记/人设/作息只有一份
     *   · 换对话时记忆不会丢
     */
    function SamePersonCard({ data }) {
      const body = data?.body ?? null
      const chans = data?.channels ?? []
      const age = body ? Math.max(0, Math.round(body.ageDays)) : 0
      const idShort = body?.id ? String(body.id).slice(0, 8) : '—'
      return h("div", { className: "dwc-card" },
        h("div", { className: "dwc-head" },
          h("span", { className: "dwc-h" }, "她还是同一个人"),
          h("span", { className: "dwc-hint dwc-grow" }, "换到哪个入口说话，记忆都连着")),
        h("div", { className: "dwc-body" },
          h("div", { className: "dwc-same-row" },
            h("span", { className: "dwc-same-k" }, "现在这段对话"),
            h("span", { className: "dwc-same-v" },
              body ? `#${idShort} · 第 ${age + 1} 天` : "还没开始",
              body?.from === 'fallback' ? h("span", { className: "dwc-hint" }, "（还没聊过）") : null)),
          h("div", { className: "dwc-same-row" },
            h("span", { className: "dwc-same-k" }, "她记得的东西"),
            h("span", { className: "dwc-same-v" }, "日记、私密日记、人设 —— 两个入口读的是同一份")),
          h("div", { className: "dwc-same-row" },
            h("span", { className: "dwc-same-k" }, "作息和口味"),
            h("span", { className: "dwc-same-v" },
              "在任一入口改，另一边立刻跟着变",
              data?.habits?.night?.windows?.length
                ? h("span", { className: "dwc-hint" }, `（现在 ${data.habits.night.windows.length} 个醒来时段）`)
                : null)),
          h("div", { className: "dwc-hint", style: { marginTop: "8px" } },
            "换新对话只是把聊天窗口换一个（免得越拖越长），记忆在日记里，不会跟着丢。")));
    }

    function ChannelCard({ ch, onToggle, busy }) {
      return h("div", { className: "dwc-fish" + (ch.enabled ? "" : " off") },
        h("span", { className: "dwc-dot" + (ch.enabled ? "" : " off") }),
        h("div", { className: "dwc-fish-name" }, `${ch.emoji ?? ""} ${ch.label}`),
        h("div", { className: "dwc-fish-state" }, ch.enabled ? (ch.running ? "运行中" : "已打开") : "关着"),
        h("button", {
          className: "dwc-switch" + (ch.enabled ? " on" : ""),
          disabled: !!busy,
          onClick: () => onToggle(ch.id, !ch.enabled),
        }, busy === ch.id ? "…" : (ch.enabled ? "关掉" : "打开")));
    }

    function WhaleSection() {
      useStyleOnce();
      const [data, setData] = useState(null);
      const [err, setErr] = useState("");
      const [busy, setBusy] = useState("");
      const [note, setNote] = useState("");
      // 2026-11-04：点了「未配置」的选项时，就地告诉他为什么、去哪儿配
      const [notice, setNotice] = useState("");

      const load = useCallback(async () => {
        setErr("");
        try {
          const j = await api.get("/channels");
          setData(j);
        } catch (e) { setErr(`读取失败：${e.message}`); }
      }, []);

      useEffect(() => { load(); }, [load]);

      const toggle = async (id, enabled) => {
        setBusy(id); setNote("");
        try {
          await api.post(`/channels/${id}/enabled`, { enabled });
          setNote(`✓ ${nameOf(id)} 已${enabled ? "打开" : "关掉"}`);
          await load();
        } catch (e) { setErr(e.message); } finally { setBusy(""); }
      };

      const saveShared = async (patch) => {
        setNote("");
        try {
          const j = await api.post("/shared", { shared: patch });
          setNote("✓ 已保存");
          await load();
          return j;
        } catch (e) { setErr(e.message); }
      };

      if (!data) {
        return h("div", { className: "dwc" },
          h("h3", { className: "dwc-title" }, "养鱼"),
          err ? h("div", { className: "dwc-err" }, err) : h("div", { className: "dwc-hint" }, "读取中…"));
      }

      const chans = data.channels ?? [];

      return h("div", { className: "dwc" },
        err ? h("div", { className: "dwc-err" }, err) : null,
        note ? h("div", { className: "dwc-ok" }, note) : null,
        // 有提醒时（点了未配置的选项）：显示出来，旁边给个「知道了」关掉
        notice ? h("div", { className: "dwc-notice" },
          h("span", { className: "dwc-grow" }, notice),
          h("button", { className: "dwc-linkbtn", onClick: () => setNotice("") }, "知道了")) : null,

        // ① 大字三行：现在到底在干什么（一进来先看这个）
        h(Summary, { data }),

        // ② 一张表：每件事归谁，能点的地方就能改
        //   ⚠️ 2026-11-04：没配置好的入口点不动，点了会弹一句「为什么」——
        //   所以要把 setNotice 传下去，不能只灰掉不说话 ✗
        h(AbilityTable, { data, onSave: saveShared, notice, setNotice }),

        // ③ 她的两个入口：开没开 + 开关（不是「两条鱼」，是同一个她在两个地方能说话）
        h("div", { className: "dwc-card" },
          h("div", { className: "dwc-head" },
            h("span", { className: "dwc-h" }, "她在哪些地方能说话"),
            h("span", { className: "dwc-hint dwc-grow" }, "关掉只是那边安静了：日记和设置都还在"),
            h("button", { className: "dwc-linkbtn", onClick: load }, "刷新")),
          h("div", { className: "dwc-body", style: { padding: "4px 14px" } },
            chans.map((c) => h(ChannelCard, { key: c.id, ch: c, onToggle: toggle, busy })),
            chans.length === 0 ? h("div", { className: "dwc-hint", style: { padding: "10px 0" } }, "一个入口都没装。") : null)),

        // ⚠️ 2026-11-04 主人：「总控制台只管鱼用 qq 还是哔站这相关的设置，其他的都不放在总控制台」
        //
        //   所以这里**只留三样**，全是「哪个入口干什么」的事：
        //     ① 现在是什么状态（她有哪些入口）
        //     ② 谁做什么（私聊/动态归谁、分享视频开不开）
        //     ③ 各入口开没开
        //
        //   搬走的（回到各插件自己的设置页）：
        //     · 记忆/人设 —— 那是「她是谁」，属于插件本身，不是「用哪个入口」
        //     · 常用手感（主动概率、发几条…）—— 同上，各插件有自己的作息和语气设置
        //   这样总控制台就不会和「养鱼 · B站」「养鱼 · QQ」两页的内容打架 ✓

        // ④ 她还是同一个人吗（2026-11-04 主人要求：切换入口后还在同一个上下文）
        //
        //   ⚠️ 这张卡**不属于"设置"**，不需要改任何东西 ——
        //   它只是把「两个入口是不是真的连着同一个她」摆出来，让人一眼放心 ✓
        //   （所以它不违反「总控制台只管用哪个入口」：这里没有可调的项，只有状态）
        h(SamePersonCard, { data }),

        h("div", { className: "dwc-card dwc-foot" },
          h("div", { className: "dwc-body" },
            h("div", { className: "dwc-hint" },
              "这里只决定「哪个入口干什么」。她是谁、几点醒、怎么说话，在各自的页面里改："),
            h("div", { className: "dwc-links" },
              chans.filter((c) => (c.setup?.ok ?? true)).map((c) => h("span", {
                key: c.id,
                className: "dwc-linkchip",
              }, `→ 设置里的「养鱼 · ${c.id === 'bili' ? 'B站' : 'QQ'}」`)),
              chans.filter((c) => !(c.setup?.ok ?? true)).length
                ? h("span", { className: "dwc-hint" }, "（未配置的入口配好之后，这里会多出它的入口）")
                : null)),
            // ⚠️ 2026-11-04：原来这里有一整张「她是谁（记忆/人设只有一份）」的卡片。
            //   按主人要求「其他的都不放在总控制台」，那张卡搬走了 ——
            //   但「只有一份」这个事实太重要，不能连说明一起弄丢，所以留一行小字 ✓
            h("div", { className: "dwc-hint", style: { marginTop: "10px" } },
              "不管你在哪个入口跟她说话，她都是同一个人：日记、人设、作息只有一份。")));
    }

    const inject = ["slots"];
    const NS = "whale-core";
    const NAMES = { nav: "养鱼" };

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: NS, order: 5, label: () => NAMES.nav },
              WhaleSection,
            ),
            "whale-core: settings section",
          ),
        "whale-core: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.WhaleSection = WhaleSection;
    return module.exports;
  },
});
