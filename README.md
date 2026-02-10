# NeoGroup

**每个人都可以拥有自己的去中心化讨论组。**

NeoGroup 是一个开源的小组讨论社区，部署在 Cloudflare Workers 上，通过 ActivityPub 协议与整个 Fediverse 互联。

你可以把它想象成：一个你自己掌控的豆瓣小组 / Telegram 群组 / Discord 频道 —— 但它是开放的、去中心化的、属于你的。

**线上实例**: [neogrp.club](https://neogrp.club)

## 为什么需要 NeoGroup

- 你的社区不应该寄居在某个平台上，随时可能被封禁或下线
- 你的讨论内容不应该被算法裹挟，被广告打断
- 你和你的朋友应该可以自由地建立连接 —— 即使你们在不同的实例上

NeoGroup 让你 5 分钟内部署一个属于自己的讨论组，**Cloudflare 免费版即可运行**，无需服务器、无需运维。每个 NeoGroup 实例都是 Fediverse 的一部分，不同实例的用户可以互相关注、互动、讨论。

## 快速部署

**前置条件**：Node.js v20+、Cloudflare 账号（免费版即可）

```bash
git clone https://github.com/qingfeng/neogroup.git
cd neogroup
```

后续步骤参考 **[skill.md](./skill.md)** —— 这是一份 AI Agent 友好的部署指南，你可以让 Claude Code、Cursor 等 AI 工具读取它，自动完成全部部署流程。

> **Cloudflare 免费版**包含 Workers、D1 数据库、KV 存储，足以运行完整的 NeoGroup 实例。图片上传（R2）、AI 标题生成、Nostr 同步（Queue）均为可选功能。

## 功能特性

- **小组** — 创建和加入讨论小组
- **话题与评论** — 发布话题、评论、回复、点赞、转发
- **Mastodon 登录** — 支持任意 Mastodon 实例的 OAuth 登录，无需注册新账号
- **ActivityPub 联邦** — 每个用户和小组都是 Fediverse Actor，外部用户可以关注并接收更新
- **Mastodon 同步** — 评论同步到 Mastodon，Mastodon 上的回复同步回网站
- **书影音卡片** — 编辑器内粘贴 NeoDB 链接自动生成卡片
- **Nostr 同步** — 一键将帖子同步到 Nostr 去中心化网络，支持 NIP-05 身份验证
- **站内关注** — 关注其他用户，接收通知

## 去中心化架构

```
┌──────────────┐     ActivityPub     ┌──────────────┐
│  你的实例     │ ◄────────────────► │  其他实例     │
│  my.group    │                     │  neogrp.club │
└──────┬───────┘                     └──────┬───────┘
       │                                     │
       │    ActivityPub          Nostr        │
       ▼                           ▼         ▼
┌──────────────┐           ┌──────────────┐
│  Mastodon    │           │  Nostr       │
│  Misskey ... │           │  Relays      │
└──────────────┘           └──────────────┘
```

每个 NeoGroup 实例的用户和小组都有 ActivityPub 身份（如 `user@my.group`），可以被任何 Mastodon、Misskey 等 Fediverse 平台的用户关注和互动。用户还可以开启 Nostr 同步，将帖子同步到 Nostr 网络，并通过 NIP-05 验证身份（如 `user@my.group`）。

## 技术栈

| 组件 | 技术 |
|------|------|
| Web 框架 | [Hono](https://hono.dev) |
| 运行时 | Cloudflare Workers |
| 数据库 | Cloudflare D1 (SQLite) |
| ORM | [Drizzle](https://orm.drizzle.team) |
| 会话存储 | Cloudflare KV |
| 文件存储 | Cloudflare R2（可选） |
| AI | Cloudflare Workers AI（可选） |
| 认证 | Mastodon OAuth2 |
| 联邦协议 | ActivityPub + Nostr |
| 模板引擎 | Hono JSX (SSR) |

## 文档

- **[skill.md](./skill.md)** — 部署指南（AI Agent 友好）
- **[CLAUDE.md](./CLAUDE.md)** — 项目架构、数据库表结构、核心机制说明

## 灵感

NeoGroup 灵感来源于 [NeoDB](https://neodb.social)。NeoDB 几乎涵盖了豆瓣全部的书影音功能，但唯独缺少了小组和同城功能。作为这两个功能的重度使用者，决定做点什么 —— 于是有了 NeoGroup。

## License

MIT
