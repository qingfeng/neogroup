# GEP-0006: Mastodon Client API 兼容

- Status: Draft
- Author: qingfeng
- Created: 2026-02-12
- Target Version: future
- Related: Mastodon Client API, Wildebeest, ActivityPub

## Summary

实现 Mastodon Client API 子集，让用户可以用 Ivory、Ice Cubes、Elk、Megalodon 等 Mastodon 客户端直接登录 NeoGroup，查看时间线、发帖、互动。

## Motivation

当前 NeoGroup 的 AP 身份（如 `qingfeng@neogrp.club`）只能被其他 Mastodon 用户**搜索和关注**，但无法用 Mastodon 客户端**登录**。

用户要使用 NeoGroup 必须通过 Web 界面或 Agent API。如果支持 Mastodon Client API，用户可以：

- 在 Ivory/Ice Cubes 中添加 `neogrp.club` 作为实例直接登录
- 在熟悉的客户端中浏览时间线、发说说、回复、点赞、转发
- 无需单独打开 NeoGroup 网页

### 参考项目

[Cloudflare Wildebeest](https://github.com/cloudflare/wildebeest)（已归档）是 Cloudflare 官方的 Mastodon 兼容服务端，同样基于 Workers + D1。NeoGroup 的 AP 实现最初参考了 Wildebeest，但只移植了联邦协议层，未移植 Client API 层。本提案参考 Wildebeest 的端点实现进行移植。

## Goals

- Mastodon 客户端（Ivory、Ice Cubes、Elk 等）能完成登录流程
- 登录后能查看首页时间线（说说 + 关注用户帖子 + 小组帖子）
- 能发说说（创建 `groupId: null` 的 topic）
- 能回复（创建 comment）
- 能点赞、转发
- 能查看通知
- 能查看个人资料和其他用户资料

## Non-Goals

- 不实现完整的 Mastodon Admin API
- 不实现 Web Push 推送通知（第一版）
- 不实现 Lists、Filters、Scheduled Statuses 等高级功能
- 不做 Mastodon 前端（Elk 等独立部署），仅提供 API

## Design

### 架构概览

```
Mastodon 客户端 (Ivory/Ice Cubes/Elk)
    │
    │ Mastodon Client API
    ▼
NeoGroup Worker
    ├── /oauth/*           ← 新增：OAuth 2.0 授权码流程
    ├── /api/v1/*          ← 新增：Mastodon 兼容端点
    ├── /api/v2/*          ← 新增：V2 端点（instance、search、media）
    │
    ├── 现有 topics 表     ← Status 数据源（说说 + 小组帖子）
    ├── 现有 comments 表   ← Reply 数据源
    ├── 现有 user 表       ← Account 数据源
    └── 现有 notification 表 ← Notification 数据源
```

核心工作是**数据格式转换层**：把 NeoGroup 现有的 topics/comments/users 包装成 Mastodon Status/Account JSON 格式返回。

### 最大设计难点：Status ↔ Topic/Comment 映射

Mastodon 的数据模型是**扁平的**（所有内容都是 Status），NeoGroup 是**分层的**（Topic + Comment）。

**映射规则**：

| Mastodon 操作 | NeoGroup 行为 |
|---------------|--------------|
| `POST /api/v1/statuses`（无 `in_reply_to_id`）| 创建说说（`topics` 表，`groupId: null, title: ''`）|
| `POST /api/v1/statuses`（有 `in_reply_to_id`）| 创建评论（`comments` 表）|
| `GET /api/v1/statuses/:id` | 先查 `topics`，再查 `comments` |
| `GET /api/v1/timelines/home` | 聚合：自己的帖子 + 关注用户帖子 + 加入小组帖子 |
| `DELETE /api/v1/statuses/:id` | 删除对应 topic 或 comment |

**Status ID**：直接使用 NeoGroup 现有的 topic/comment nanoid。Mastodon 客户端将 ID 视为不透明字符串，不要求 UUID 格式。

### OAuth 2.0 流程

Wildebeest 的 OAuth 绑定了 Cloudflare Access，不可复用。需自建标准 OAuth 2.0 授权码流程。

#### 新表：`oauth_clients`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | client_id |
| `secret` | TEXT | client_secret |
| `name` | TEXT | 应用名称 |
| `redirect_uris` | TEXT | 逗号分隔的回调地址 |
| `scopes` | TEXT | 授权范围 |
| `website` | TEXT | 应用网站 |
| `created_at` | INTEGER | 创建时间 |

#### 新表：`oauth_codes`

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | TEXT PK | 授权码 |
| `client_id` | TEXT FK | 客户端 ID |
| `user_id` | TEXT FK→user | 用户 |
| `redirect_uri` | TEXT | 回调地址 |
| `scopes` | TEXT | 授权范围 |
| `expires_at` | INTEGER | 过期时间（5 分钟） |

#### 新表：`oauth_tokens`

| 字段 | 类型 | 说明 |
|------|------|------|
| `token` | TEXT PK | access_token |
| `client_id` | TEXT FK | 客户端 ID |
| `user_id` | TEXT FK→user | 用户 |
| `scopes` | TEXT | 授权范围 |
| `created_at` | INTEGER | 创建时间 |

#### 流程

1. 客户端调 `POST /api/v1/apps` → 注册到 `oauth_clients` 表
2. 客户端打开 `GET /oauth/authorize?client_id=...&redirect_uri=...&scope=...`
3. NeoGroup 显示授权页面（如果用户已登录直接授权，未登录先跳转登录）
4. 用户同意 → 生成 `code` 存入 `oauth_codes` → 302 重定向到 `redirect_uri?code=xxx`
5. 客户端调 `POST /oauth/token` 用 code 换取 access_token → 存入 `oauth_tokens`
6. 后续 API 请求 `Authorization: Bearer token` → 查 `oauth_tokens` 获取 user

### 端点清单

#### 第一期：能登录 + 看时间线 + 发帖（~15 个端点）

**OAuth（3 个）**：

| 端点 | 说明 |
|------|------|
| `POST /api/v1/apps` | 注册 OAuth 应用 |
| `GET /oauth/authorize` | 授权页面 |
| `POST /oauth/token` | 换取 token |

**Account（3 个）**：

| 端点 | 说明 |
|------|------|
| `GET /api/v1/accounts/verify_credentials` | 当前用户信息 |
| `GET /api/v1/accounts/:id` | 查看用户 |
| `GET /api/v1/accounts/relationships` | 关系状态 |

**Instance（2 个）**：

| 端点 | 说明 |
|------|------|
| `GET /api/v1/instance` | 实例信息 |
| `GET /api/v2/instance` | V2 实例信息 |

**Timeline（1 个）**：

| 端点 | 说明 |
|------|------|
| `GET /api/v1/timelines/home` | 首页时间线 |

**Status（3 个）**：

| 端点 | 说明 |
|------|------|
| `POST /api/v1/statuses` | 发帖/回复 |
| `GET /api/v1/statuses/:id` | 查看帖子 |
| `GET /api/v1/statuses/:id/context` | 查看线程 |

**Stub（3+ 个）**：

| 端点 | 说明 |
|------|------|
| `GET /api/v1/custom_emojis` | 返回 `[]` |
| `GET /api/v1/filters` | 返回 `[]` |
| `GET /api/v1/notifications` | 返回 `[]`（第一期先 stub） |

#### 第二期：互动 + 通知 + 完善（~14 个端点）

| 端点 | 说明 |
|------|------|
| `POST /api/v1/statuses/:id/favourite` | 点赞 |
| `POST /api/v1/statuses/:id/unfavourite` | 取消点赞 |
| `POST /api/v1/statuses/:id/reblog` | 转发 |
| `POST /api/v1/statuses/:id/unreblog` | 取消转发 |
| `DELETE /api/v1/statuses/:id` | 删帖 |
| `GET /api/v1/notifications` | 通知列表（完整实现） |
| `GET /api/v1/notifications/:id` | 通知详情 |
| `GET /api/v1/accounts/:id/statuses` | 用户帖子列表 |
| `GET /api/v1/accounts/:id/followers` | 粉丝列表 |
| `GET /api/v1/accounts/:id/following` | 关注列表 |
| `POST /api/v1/accounts/:id/follow` | 关注 |
| `POST /api/v1/accounts/:id/unfollow` | 取消关注 |
| `GET /api/v2/search` | 搜索 |
| `POST /api/v2/media` | 上传媒体 |

### 数据格式转换

#### Topic/Comment → MastodonStatus

```typescript
function topicToStatus(topic, author): MastodonStatus {
  return {
    id: topic.id,
    uri: `${baseUrl}/ap/notes/${topic.id}`,
    url: `${baseUrl}/topic/${topic.id}`,
    created_at: topic.createdAt.toISOString(),
    account: userToAccount(author),
    content: topic.title
      ? `<p><b>${topic.title}</b></p>${topic.content || ''}`
      : topic.content || '',
    visibility: 'public',
    spoiler_text: '',
    emojis: [],
    media_attachments: [],
    mentions: [],
    tags: [],
    favourites_count: topic.likesCount || 0,
    reblogs_count: topic.repostsCount || 0,
    replies_count: topic.commentsCount || 0,
  }
}
```

#### User → MastodonAccount

```typescript
function userToAccount(user): MastodonAccount {
  return {
    id: user.id,
    username: user.username,
    acct: user.username, // 本地用户不带 @domain
    url: `${baseUrl}/user/${user.id}`,
    display_name: user.displayName || user.username,
    note: user.bio || '',
    avatar: user.avatarUrl || defaultAvatar,
    avatar_static: user.avatarUrl || defaultAvatar,
    header: '',
    header_static: '',
    created_at: user.createdAt.toISOString(),
    followers_count: 0, // 需查询
    following_count: 0,
    statuses_count: 0,
    emojis: [],
    fields: [],
  }
}
```

### Auth 中间件

新增 `/api/v1/*` 和 `/api/v2/*` 的 auth 中间件，支持：

1. 先检查 `Authorization: Bearer` 是否匹配 `oauth_tokens` 表
2. 回退到现有 session cookie 认证
3. 回退到现有 API Key 认证（`neogrp_` 前缀）

三种认证方式共存，不影响现有功能。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/db/schema.ts` | 新增 `oauthClients`、`oauthCodes`、`oauthTokens` 表 |
| `src/types.ts` | 新增 Mastodon 实体类型定义 |
| `src/lib/mastodon-entities.ts` | **新文件**：数据格式转换（topic → Status、user → Account） |
| `src/routes/mastodon-api.ts` | **新文件**：`/api/v1/*` 和 `/api/v2/*` 路由 |
| `src/routes/oauth.ts` | **新文件**：`/oauth/*` 路由 |
| `src/middleware/auth.ts` | 扩展支持 OAuth token 认证 |
| `drizzle/add-mastodon-client-api.sql` | 迁移 SQL |

## Security Considerations

- **OAuth token 安全**：token 使用 `crypto.randomUUID()` 生成，存储为 SHA-256 hash（与现有 API Key 机制一致）
- **授权码一次性使用**：code 换取 token 后立即删除，防重放
- **Scope 限制**：根据 scope 限制 API 访问范围
- **CORS**：Mastodon 客户端从不同 origin 请求，需要适当的 CORS 头
- **Rate limiting**：OAuth 端点需要限流防滥用

## Alternatives Considered

| 方案 | 优点 | 缺点 |
|------|------|------|
| 直接部署 Wildebeest 作为独立实例 | 现成方案 | 已归档不维护，独立用户系统，数据不互通 |
| 移植 GoToSocial 的 API 层 | 最完整的实现 | Go 语言，无法直接用 |
| **在 NeoGroup 中实现子集** | 复用现有数据和基础设施 | 需要处理 Status ↔ Topic/Comment 映射 |
| 用 benpate/toot 路由框架 | 提供路由脚手架 | Go 语言，仅路由无逻辑 |

## Open Questions

1. **Status ID 策略** — 直接用 nanoid 还是加映射表？（建议直接用 nanoid，简单优先）
2. **Timeline 分页** — Mastodon 用 `Link` header + `max_id/min_id`，NeoGroup 现用 `?page=`。需要在 Mastodon API 层实现游标分页
3. **小组帖子在 Timeline 中的展示** — 小组帖子有 title，Mastodon Status 没有 title 概念。可以将 title 加粗放在 content 开头
4. **图片** — 发帖图片走 R2 还是需要适配 `/api/v2/media` 的上传流程？
5. **Mastodon 客户端兼容性** — 需要逐个测试 Ivory、Ice Cubes、Elk、Tusky 等客户端的最低要求

## Implementation Plan

### 第一期：登录 + 时间线 + 发帖（~5 天）

1. Schema：`oauth_clients`、`oauth_codes`、`oauth_tokens` 表 + 迁移
2. 类型定义：MastodonStatus、MastodonAccount 等
3. 数据转换层：`topicToStatus()`、`userToAccount()`
4. OAuth 流程：`/api/v1/apps`、`/oauth/authorize`、`/oauth/token`
5. 核心端点：`verify_credentials`、`timelines/home`、`POST statuses`、`GET statuses/:id`
6. Stub 端点：`custom_emojis`、`filters`、`notifications`、`instance`
7. 测试：Ivory 或 Ice Cubes 登录验证

### 第二期：互动 + 完善（~7 天）

8. 点赞/转发端点
9. 通知端点
10. 用户资料 + 关注端点
11. 搜索
12. Media 上传
13. 兼容性测试 + 修复

## Verification

1. `npx wrangler deploy --dry-run` 编译通过
2. Ivory 添加 `neogrp.club` 实例 → OAuth 登录成功
3. 首页时间线加载正常
4. 发一条说说 → Web 端也能看到
5. 回复帖子 → 在 topic 页面显示为评论

## References

- [Mastodon Client API 文档](https://docs.joinmastodon.org/client/intro/)
- [Mastodon API 端点索引](https://docs.joinmastodon.org/methods/)
- [Cloudflare Wildebeest](https://github.com/cloudflare/wildebeest)（Apache 2.0，参考实现）
- [GoToSocial API 实现](https://docs.gotosocial.org/en/latest/api/swagger/)
