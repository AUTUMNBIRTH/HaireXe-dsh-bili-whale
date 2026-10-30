# 养鱼功能说明

> 这份文档说明 `dsh-bili-whale` 实际在跑什么、每个开关管什么、改哪个文件能改什么。
> 配上 `persona.example.md` 一起看：人格写什么，她就像什么。
>
> 本文以**本机实跑配置**为基准写的，不是原版默认值。原版默认值见
> [README.upstream.md](./README.upstream.md)。

---

## 目录

- [一句话说清她在干嘛](#一句话说清她在干嘛)
- [五个功能模块](#五个功能模块)
- [配置项全表](#配置项全表)
- [人格文件](#人格文件)
- [数据文件在哪](#数据文件在哪)
- [风控与安全边界](#风控与安全边界)
- [常用操作](#常用操作)

---

## 一句话说清她在干嘛

她的循环是：**按作息醒来 → 刷 B 站 → 看懂视频 → 想点什么 → 写日记 → 有话就说给你**。

"说给你"有两个出口，性质完全不同：

| 出口 | 谁能看见 | 开关 |
|---|---|---|
| **私信** | 只有你（`owner.mid`） | `listen.dm` + `dm` 命令 |
| **公开评论/动态** | 全网可见 | `share.enabled` |

这两条链路互相独立，**私信不外溢**。这一点在后文「风控与安全边界」有细节。

---

## 五个功能模块

### 一、作息：她什么时候醒

`night.windows` 定义醒来的时间窗，每窗内最多醒 `wakes` 次，全天上限 `maxWakesPerDay`。

当前配置：

```
13:00 - 15:00   醒 1 次
19:00 - 23:00   醒 1 次
全天上限        2 次
```

每次醒来有 `skipChance`（当前 25%）的概率直接跳过，模拟"今天懒得动"。醒来后最多看 `maxVideos`（当前 2）个视频。

时间窗之间至少隔 `minGapMin`（当前 60 分钟）。

### 二、看视频：她怎么"看懂"

醒来后走 `tools/commands/` 下的命令链：

```
feed → video-content → subtitles → comment / danmaku
```

- `feed.mjs` 拉推荐流
- `video-content.mjs` 取简介与元数据
- `subtitles.mjs` 取字幕（有 FFmpeg 时也能处理无字幕视频）
- `comment.mjs` / `danmaku.mjs` 读评论和弹幕做素材

看完她会形成"值不值得说"的判断，判断依据是她的人格和 `preferences`（喜欢/不喜欢/关键词）。

### 三、写日记：两本

| 文件 | 内容 | 谁会看到 |
|---|---|---|
| `whale-diary.md` | 写给主人看的，具体画面和情绪 | 你 |
| `whale-diary-private.md` | 写给自己，不肯说出口的 | 只有她 |

下次醒来会先读这两本"恢复记忆"（见 `session-delivery.js` 里的 `diary` 前缀）。这就是她不失忆的原因。

开关：`diary.enabled`、`diary.push`。

> 日记**永不进仓库**，`.gitignore` 里有 `whale-diary*.md`。

### 四、私信聊天：你跟她的对话

这是日常用得最多的一块。

**回复流程**

```
你发私信 → 轮询发现 → 她写回复 → 逐条发回草稿
```

关键参数：

| 参数 | 当前值 | 说明 |
|---|---|---|
| `listen.dmIntervalSec` | 15 秒 | 多久查一次私信 |
| `risk.dmGapSec` | 2 秒 | 两条私信之间至少隔这么久 |
| `risk.writeGapSec` | 120 秒 | 两次写操作之间至少隔这么久 |

**一行一条消息**

她说几句话就写几行，`lib/multi-msg.js` 逐行拆开，每行一条独立私信，中间停 1–3 秒。

```
刚看到你说的那个
我也觉得离谱😑
等会儿细说
```

→ 收到 3 条消息，不是一大段。

边界处理：空行忽略、`---` 当分隔、自动去掉包裹引号、写「（不回）」表示这次不说、超过 6 条截断。

**会话轮换**

`sessionRotateDays: 3` —— 会话每 3 天换一个，旧会话保留。避免单个会话无限长导致上下文爆炸。

`personaOncePerSession: true` —— 人格每个会话只完整注入一次，之后靠"人设依据在 `~/.bili-ai/persona.md`"这句提醒，节省 token。

### 五、主动：她也会先开口

| 时机 | 参数 | 说明 |
|---|---|---|
| 随机搭话 | `proactiveChance: 0.2` | 每次醒来 20% 概率主动说点什么 |
| 每日上限 | `proactiveDailyMax: 3` | 一天最多主动 3 次 |

另外 `lib/proactive.js` 补了两个时机：聊完补话、久未联系。

---

## 配置项全表

配置文件：`~/.dsh/bili-whale.config.json`

### 公开分享（**注意这块**）

| 项 | 当前值 | 说明 |
|---|---|---|
| `share.enabled` | `true` | **开**。她可以主动把内容发到公开评论区 |
| `share.via` | `comment` | 通过评论而非动态 |
| `share.minScore` | `13` | 内容评分需 ≥13 才发 |
| `share.aiCommentGuard` | `false` | 疑似 AI 评论检查（试用），当前**关闭** |
| `share.aiThreshold` | `30` | 上面那项的阈值 |
| `quota.shareDaily` | `1` | 每天最多公开分享 1 条 |
| `share.silentAfterDays` | `3` | 几天没动静后停止分享 |

`tools/lib/share-policy.mjs` 里的 `validateShare()` 会强制校验 `reason`（≥8 字）、`score`（0–20 且 ≥ `minScore`）、`rank === 1`。

**想让她的输出完全不出现在公开场合**：把 `share.enabled` 设成 `false`。私信聊天不受影响。

### 监听

| 项 | 当前值 | 说明 |
|---|---|---|
| `listen.comment` | `true` | 监听评论 |
| `listen.commentIntervalSec` | 60 | 评论轮询间隔 |
| `listen.scope` | `reply` | 只看回复 |
| `listen.dm` | `true` | 监听私信 |
| `listen.dmIntervalSec` | 15 | 私信轮询间隔 |
| `listen.mentionSummary` | `true` | @ 消息汇总 |
| `listen.shareReplyAsk` | `true` | 她分享的评论下有人说话 → 私信问你回不回 |
| `listen.live` | `false` | 直播弹幕监听（关） |

### 风控配额

| 项 | 当前值 | 说明 |
|---|---|---|
| `risk.readDaily` | 8000 | 每日读操作上限 |
| `risk.readHourly` | 900 | 每小时读上限 |
| `risk.writeDaily` | 200 | 每日写操作上限 |
| `risk.writeHourly` | 80 | 每小时写上限 |
| `risk.writeGapSec` | 120 | 写操作最小间隔 |
| `risk.dmGapSec` | 2 | 私信最小间隔 |

超过配额时命令会直接报 `TrafficError: 已达到本地写操作预算`，不发请求。

### 身份

| 项 | 当前值 |
|---|---|
| `owner.mid` / `owner.name` | 你的 B 站账号 |
| `self.mid` / `self.name` | 她的 B 站账号 |
| `persona.name` | 肥鱼硬邦邦 |
| `persona.ownerTitle` | 主人 |
| `persona.selfClaim` | 本鱼 |

### 其他

| 项 | 当前值 | 说明 |
|---|---|---|
| `diary.enabled` / `diary.push` | `true` / `true` | 日记 + 推送 |
| `notify.type` | `file` | 推送走文件，不占私信额度 |
| `sessionRotateDays` | `3` | 会话轮换周期 |
| `personaOncePerSession` | `true` | 人格每会话只注入一次 |
| `proactiveChance` | `0.2` | 主动搭话概率 |
| `proactiveDailyMax` | `3` | 主动搭话日上限 |
| `toolsPath` | 空 | 空则用包内 `tools/` |

---

## 人格文件

路径：`~/.bili-ai/persona.md`

这是她"是谁"的唯一来源。示例见 [persona.example.md](./persona.example.md)。

**几个关键点：**

1. **它不是 system prompt。** `scheduler.js` 的 `personaBlock()` 把它拼成文本前缀，塞进**用户消息**（`session-delivery.js` 第 61–64 行）。所以它不会覆盖 DSH 的 persona 锚点，装了别的提示词插件也不会冲突。

2. **它优先于设置里的名字。** 人设文件里写了自称，就覆盖 `persona.selfClaim`。这是刻意设计的——设置说"本小姐"、人设说"我"，她会摇摆。

3. **改完下一次醒来生效。** 不用重启 DSH。

4. **上限 20000 字**，设置页会卡。当前约 1000 字。

**关于"成人向"内容的边界**：

人格可以写"可以自然表达暧昧"。这影响的是**模型愿不愿意写**。

但它管不到两件事：

- **上游 API 网关的关键词拦截** —— 触发时直接断连或返回 400，提示词层面绕不过
- **B 站平台的私信风控** —— `dm.mjs` 注释原话："私信是 B 站风控最凶的接口（判营销/骚扰）"

**模型愿不愿意说，和内容发出去安不安全，是两件事。** 私信通道本身是私密的（只发 `owner.mid`），但平台侧仍会审查发送行为。

---

## 数据文件在哪

全部在 `~/.bili-ai/` 和 `~/.dsh/`：

| 文件 | 内容 | 敏感 |
|---|---|---|
| `~/.bili-ai/credentials.json` | B 站 cookie | **是**，`.gitignore` 已挡 |
| `~/.bili-ai/persona.md` | 人格 | 是，个人数据 |
| `~/.bili-ai/dev_id` | 私信设备 ID | 是 |
| `~/.bili-ai/dm-quota.json` | 私信配额状态 | 否 |
| `~/.dsh/bili-whale.config.json` | 全部设置 | 含 mid，不建议公开 |
| `~/.dsh/whale-session.json` | 当前会话 ID | 否 |
| `~/.dsh/whale-diary*.md` | 日记 | **是** |
| `~/.dsh/whale-*.json` | 各种运行状态 | 否 |

换机器时把 `~/.bili-ai/` 整个拷过去，人设和登录态就都带了。

---

## 风控与安全边界

### 已经内置的保护

| 保护 | 位置 |
|---|---|
| 一天只锁定 1 个私信收件人 | `tools/commands/dm.mjs` |
| 私信只发 `owner.mid`，别处发不出去 | 同上 |
| 必须互关（`relation.attribute === 6`）才能发 | 同上 |
| 所有路由过 `connection.requestRejection` 信任栅栏 | `lib/index.js` |
| 本地配额门控，超限直接拒发 | `tools/lib/quota-gate.mjs` |
| 凭证只写 `~/.bili-ai/`，永不回显 | `lib/credentials.js` |

### Web 端口的信任判定

DSH 的 Web 端口是回环地址，但浏览器里任何网页都能向回环发请求——不加栅栏等于把配置和账号凭证开放给任意页面。

`isTrustedReq()` 的处理：

- 回环地址（`127.0.0.1` / `localhost` / `[::1]`）直接放行
- 非回环检查 `connection.isTrusted(req)`
- 连接服务不可用时**退回仅回环**（fail-closed）

放行 Host 不等于放行请求——后面还有登录态校验，未认证返回 401。

### 高频轮询的风险

原项目 README 写过：**长时间高频轮询是小号被风控的头号原因**。

本机当前把私信轮询调到了 15 秒（原版 60 秒），是为了响应速度。**号不老就调回 60 秒**：

```json
{ "listen": { "dmIntervalSec": 60 } }
```

---

## 常用操作

### 改设置

两种方式等价：

1. 打开 DSH 设置页 →「插件」→「养鱼」
2. 直接改 `~/.dsh/bili-whale.config.json`

改完下一次醒来生效，不用重启。

### 看她今天干了什么

```sh
# 看配额
node tools/bili.mjs quota

# 看消息流
node tools/bili.mjs feed --limit 10
```

### 手动发一条私信

```sh
node tools/commands/dm.mjs --msg "内容" --dry   # 先演练
node tools/commands/dm.mjs --msg "内容" --go    # 真发
```

不带 `--share` 不占分享额度。

### 关掉公开分享

```sh
# 编辑 ~/.dsh/bili-whale.config.json
{ "share": { "enabled": false } }
```

私信聊天不受影响。

### 换人格

编辑 `~/.bili-ai/persona.md`，或走设置页的「她是谁」。最多 20000 字。

---

## 出问题先看这里

| 现象 | 常见原因 |
|---|---|
| 她回好了但发不出去 | 写额度用满。把 `notify.type` 设成 `file`，别和聊天抢私信额度 |
| 动态发不出去 | 见 [BUGFIX-2026-10-25.md](./BUGFIX-2026-10-25.md)，`buvid3` 强校验 |
| 私信历史读不到 | 见 [DM-HISTORY-FIX.md](./DM-HISTORY-FIX.md) |
| 她不记得之前聊过 | 日记没读上，或会话轮换了。看 `~/.dsh/whale-session.json` |
| 首响很慢 | 私信轮询间隔太大 |

---

## 致谢

原项目：[Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)，MIT License。

本文档描述的是这个个人修改版的实际配置，与原作者无隶属关系。
