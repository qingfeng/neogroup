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
│   ├── mastodon.ts       # Mastodon OAuth 服务
│   ├── mastodon-bot.ts   # Mastodon Bot（@机器人自动发帖）
│   ├── mastodon-sync.ts  # Mastodon 回复同步
│   └── session.ts        # 会话管理
├── routes/
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
| user | 用户基本信息 |
| auth_provider | 认证方式（Mastodon OAuth） |
| group | 小组 |
| group_member | 小组成员 |
| topic | 话题/帖子 |
| comment | 评论 |
| comment_like | 评论点赞 |
| topic_like | 话题喜欢 |
| notification | 站内通知 |
| report | 举报 |
| mastodon_app | Mastodon 应用配置（按实例缓存） |

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
