# NeoGroup

NeoGroup，灵感来源于 [NeoDB](https://neodb.social)，NeoDB 里几乎涵盖了豆瓣全部的书影音功能，但是唯独缺少了小组和同城功能，作为这两个功能的重度使用者，决定做点什么，所以也模仿 NeoDB，开发了一个基于 Mastodon 登录的去中心化小组产品 NeoGroup。

**线上地址**: [neogrp.club](https://neogrp.club)

## 功能特性

- **小组**: 创建和加入小组，设置 LOGO、简介、标签
- **话题**: 在小组内发布话题，支持富文本编辑（图片、链接）
- **评论**: 话题下评论、回复、点赞
- **书影音**: 编辑器内粘贴 NeoDB 链接自动生成卡片（封面、评分、简介）
- **Mastodon 登录**: 支持任意 Mastodon 实例的 OAuth 登录
- **Mastodon 回复同步**: 话题关联的 Mastodon 帖子的回复会自动同步为评论
- **Mastodon Bot**: @机器人自动创建话题，AI 生成标题
- **去中心化**: 用户身份基于 Mastodon，不依赖单一平台

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

## 快速开始

### 前置条件

- Node.js v20+
- Cloudflare 账号

### 部署你自己的 NeoGroup

详见 [`skill.md`](./skill.md) — 这是一份面向 AI Agent 友好的部署指南，包含完整的环境搭建步骤。你可以：

- **手动操作**: 按照 `skill.md` 中的步骤逐步执行
- **让 Agent 帮你**: 将 `skill.md` 交给 [Claude Code](https://claude.com/claude-code) 或其他 AI Agent，它可以自动完成大部分设置工作

```bash
# 克隆项目
git clone https://github.com/qingfeng/neogroup.git
cd neogroup

# 安装依赖
npm install

# 后续步骤参考 skill.md
```

### 本地开发

```bash
npm run dev
# 访问 http://localhost:8787
```

### 部署

```bash
npm run deploy
```

## 项目结构

```
src/
├── index.ts              # 入口文件，API 路由，Cron handler
├── types.ts              # TypeScript 类型定义
├── db/
│   ├── index.ts          # 数据库连接
│   └── schema.ts         # Drizzle 表结构定义
├── lib/
│   └── utils.ts          # 工具函数
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
└── components/
    ├── Layout.tsx        # 页面布局
    ├── Navbar.tsx        # 导航栏
    ├── HomePage.tsx      # 首页组件
    ├── TopicCard.tsx     # 话题卡片
    └── Sidebar.tsx       # 侧边栏
```

## License

MIT
