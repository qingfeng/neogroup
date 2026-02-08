# NeoGroup - 项目文档

基于 Hono 框架的小组讨论社区，部署在 Cloudflare Workers 上。

> **开发环境搭建请参考 [skill.md](./skill.md)**

## 技术栈

| 组件 | 技术 |
|-----|------|
| Web 框架 | [Hono](https://hono.dev) |
| 运行时 | Cloudflare Workers |
| 数据库 | Cloudflare D1 (SQLite) |
| ORM | [Drizzle](https://orm.drizzle.team) |
| 会话存储 | Cloudflare KV |
| 文件存储 | Cloudflare R2 |
| AI | Cloudflare Workers AI |
| 认证 | Mastodon OAuth2 |
| 联邦协议 | ActivityPub |
| 模板引擎 | Hono JSX (SSR) |

## 项目结构

```
src/
├── index.ts              # 入口文件，API 路由，Cron handler
├── types.ts              # TypeScript 类型定义
├── db/
│   ├── index.ts          # 数据库连接
│   └── schema.ts         # Drizzle 表结构定义
├── lib/
│   ├── utils.ts          # 工具函数
│   └── notifications.ts  # 站内通知
├── middleware/
│   └── auth.ts           # 认证中间件
├── services/
│   ├── activitypub.ts    # ActivityPub 联邦服务
│   ├── mastodon.ts       # Mastodon OAuth 服务
│   ├── mastodon-bot.ts   # Mastodon Bot（@机器人自动发帖）
│   ├── mastodon-sync.ts  # Mastodon 回复同步
│   └── session.ts        # 会话管理
├── routes/
│   ├── activitypub.ts    # ActivityPub 路由 (WebFinger, Actor, Inbox, etc.)
│   ├── auth.ts           # 认证路由 (/auth/*)
│   ├── home.tsx          # 首页路由 (/)
│   ├── topic.tsx         # 话题路由 (/topic/*)
│   ├── group.tsx         # 小组路由 (/group/*)
│   └── user.tsx          # 用户路由 (/user/*)
└── components/           # JSX 页面组件
```

## 数据库表结构

| 表名 | 说明 |
|-----|------|
| user | 用户基本信息（含 AP 密钥对 `ap_public_key`/`ap_private_key`） |
| auth_provider | 认证方式（Mastodon OAuth），`metadata` JSON 含 AP username |
| group | 小组 |
| group_member | 小组成员 |
| topic | 话题/帖子 |
| comment | 评论 |
| comment_like | 评论点赞 |
| comment_repost | 评论转发记录 |
| topic_like | 话题喜欢 |
| topic_repost | 话题转发记录 |
| notification | 站内通知（支持远程 AP actor） |
| report | 举报 |
| mastodon_app | Mastodon 应用配置（按实例缓存） |
| ap_follower | ActivityPub 关注者 |

## ActivityPub 联邦机制

### 用户身份

每个用户登录后自动获得 ActivityPub 身份 `username@域名`（如 `qingfeng@neogrp.club`）。用户名取自 Mastodon OAuth 登录时的用户名，存储在 `auth_provider.metadata` JSON 的 `username` 字段。

首次被联邦请求访问时，系统自动生成 RSA-2048 密钥对（Web Crypto API），存储在 `user.ap_public_key` / `user.ap_private_key`。

### AP 端点

| 端点 | 说明 |
|------|------|
| `GET /.well-known/webfinger?resource=acct:user@domain` | WebFinger 用户发现 |
| `GET /.well-known/nodeinfo` | NodeInfo 入口 |
| `GET /nodeinfo/2.0` | NodeInfo 2.0 实例信息 |
| `GET /ap/users/:username` | Actor Profile (Person) |
| `POST /ap/users/:username/inbox` | Inbox — 接收 Follow/Undo/Create 活动 |
| `GET /ap/users/:username/outbox` | Outbox — 话题 + 评论总数 |
| `GET /ap/users/:username/followers` | Followers Collection |
| `GET /ap/notes/:topicId` | 话题作为 AP Note |
| `GET /ap/comments/:commentId` | 评论作为 AP Note（含 `inReplyTo`） |
| `POST /ap/users/:username/backfill` | 管理端点：将已有话题批量推送给关注者 |

### 话题联邦

- 创建话题时自动调用 `deliverTopicToFollowers()` 将 `Create(Note)` 推送到所有 AP 关注者
- 话题暴露为 AP Note：`/ap/notes/:topicId`，内容包含标题（加粗）+ 正文 + 话题链接
- 外部 Mastodon 用户关注 `username@域名` 后，新话题会出现在其时间线

### 评论联邦

- 创建评论时自动调用 `deliverCommentToFollowers()` 将 `Create(Note)` 推送到所有 AP 关注者
- 评论暴露为 AP Note：`/ap/comments/:commentId`
- 评论 Note 包含 `inReplyTo` 字段：回复评论指向 `/ap/comments/:parentId`，顶层评论指向 `/ap/notes/:topicId`
- 外部用户可搜索评论的 AP URL 找到并互动

### Inbox 处理

| Activity 类型 | 处理逻辑 |
|---------------|---------|
| `Follow` | Fetch 远程 actor → 存储到 `ap_follower` 表 → 发送 `Accept` |
| `Undo(Follow)` | 从 `ap_follower` 表删除 |
| `Create(Note)` + Mention | 1. **远程用户归属**：为远程 Actor 创建本地影子用户（关联 `auth_provider`）<br>2. **话题/评论创建**：根据 Context 创建 Topic 或 Comment<br>3. **群组转发 (Boost)**：如果提及了 Group Actor，自动发送 `Announce` 活动将原贴转发给群组关注者 |

### Group Actor 机制

- **群组身份**：每个 Group 也是一个 ActivityPub Actor（如 `@board@neogrp.club`）。
- **自动转发 (Boost)**：当外部用户 @群组 发帖时，群组会自动 Boost 该贴，确保群组关注者能看到。
- **回复处理**：支持识别 `inReplyTo`，如果回复的是 Fediverse 来源的帖子（通过 `mastodonStatusId`索引），会自动归档为评论。
- **群组 @ 支持**：外部用户 @ 群组（如 `@board@neogrp.club`）发帖，群组会自动 Boost；远程 Mastodon 上对该帖的后续回复会同步为话题下的评论。
- **本地回复联邦**：本地用户回复带有远程 Mastodon 原帖的 Topic/Comment 时，以本地 AP 身份发送 ActivityPub 回复到远程线程（保留 `inReplyTo`），不再用用户 Mastodon token 直接发 toot；删除评论会发送 Delete 并尝试删除对应 toot。

### 影子用户 (Shadow Users)

- 当收到来自 Fediverse 的 Create 活动时，系统自动为远程用户创建本地账号（如果不存在）。
- 用户名格式：`preferredUsername@domain`。
- 存储远程用户的头像、昵称、URL，确保在站内显示正确的作者信息。


### HTTP 签名

使用 draft-cavage 格式，RSA-SHA256 算法，签名字段包括 `(request-target)`、`host`、`date`、`digest`、`content-type`。使用 Web Crypto API 签名，兼容 Mastodon。

### 相关代码

- `src/services/activitypub.ts` — 密钥管理、JSON-LD 构建、HTTP 签名、`deliverTopicToFollowers()`、`deliverCommentToFollowers()`、`getNoteJson()`、`getCommentNoteJson()`
- `src/routes/activitypub.ts` — WebFinger、Actor、Inbox、Outbox、Followers、Note 路由

## 转发（Repost/Boost）机制

### 话题转发

- 用户点击话题的「转发」按钮 → 通过 AP URL `/ap/notes/:topicId` 用 `resolveStatusByUrl()` 在用户所在 Mastodon 实例上 resolve → 调用 `reblogStatus()` 完成 boost
- 转发记录存入 `topic_repost` 表，页面显示转发计数 + 转发者列表弹窗

### 评论转发

- 所有评论都可转发（不再要求 `mastodonStatusId`）
- 转发逻辑：优先使用 `mastodonStatusId` + `mastodonDomain` 通过 `resolveStatusId()` resolve；如果没有则 fallback 到 AP URL `/ap/comments/:commentId` 通过 `resolveStatusByUrl()` resolve
- 转发记录存入 `comment_repost` 表，页面显示转发计数

### 相关代码

- `src/routes/topic.tsx` — `POST /:id/repost`（话题转发）、`POST /:id/comment/:commentId/repost`（评论转发）
- `src/services/mastodon.ts` — `reblogStatus()`、`resolveStatusByUrl()`、`resolveStatusId()`

## 站内通知

### 通知类型

| type | 说明 | actor 来源 |
|------|------|-----------|
| `reply` | 回复了你的话题 | 站内用户 |
| `comment_reply` | 回复了你的评论 | 站内用户 |
| `topic_like` | 喜欢了你的话题 | 站内用户 |
| `comment_like` | 赞了你的评论 | 站内用户 |
| `mention` | 远程用户 @ 了你 | 远程 AP actor |

### 远程 actor 通知

`mention` 类型的通知 `actorId` 为 `'remote'`（不在 users 表中），通过 `actorName`、`actorAvatarUrl`、`actorUrl` 字段存储远程用户信息。`metadata` JSON 存放内容摘要和原帖 URL。

通知页面使用 `leftJoin(users)` 查询，当 `actor.id` 为 null 时 fallback 到这些远程字段渲染。

### 相关代码

- `src/lib/notifications.ts` — `createNotification()`
- `src/routes/notification.tsx` — 通知列表页面

## Mastodon 同步机制

### 话题同步

话题可以通过 Mastodon Bot 创建（@机器人 发帖），此时话题会关联一个 `mastodon_status_id`。

当用户访问话题页面时，系统会调用 `syncMastodonReplies()` 同步 Mastodon 上对该帖子的所有回复为评论。

### 评论同步

发表评论时可以勾选"同步到 Mastodon"：

1. **话题有 `mastodon_status_id`**: 评论作为回复发送到 Mastodon（回复原帖）
2. **话题没有 `mastodon_status_id`**: 评论作为独立 status 发送，内容包含：
   - `@帖子作者@实例` mention（通知帖子作者）
   - 帖子标题和链接

评论发送到 Mastodon 后，会保存 `mastodon_status_id` 和 `mastodon_domain`。

当用户再次访问话题页面时，系统会调用 `syncCommentReplies()` 同步 Mastodon 上对这些评论的回复。

### 相关代码

- `src/services/mastodon-sync.ts` — `syncMastodonReplies()`, `syncCommentReplies()`
- `src/routes/topic.tsx` — 评论发布逻辑、同步调用

## 常用命令

```bash
# 本地开发
npm run dev

# 部署
npm run deploy

# 生成数据库迁移
npx drizzle-kit generate

# 执行迁移（远程）
npx wrangler d1 execute neogroup --remote --file=drizzle/0006_xxx.sql

# 查看远程数据库
npx wrangler d1 execute neogroup --remote --command="SELECT * FROM user LIMIT 10;"

# 查看日志
npx wrangler tail
```

## 从 Django 迁移数据

如果有旧的 Django 版本数据:

```bash
# 1. 修改 scripts/migrate-data.js 中的 LOCAL_DB_PATH
# 2. 生成迁移 SQL
node scripts/migrate-data.js > migrate.sql

# 3. 执行迁移
npx wrangler d1 execute neogroup --remote --file=migrate.sql
```
