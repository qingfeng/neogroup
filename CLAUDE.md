# NeoGroup - Hono + Cloudflare Workers

这是一个基于 Hono 框架的小组讨论社区，部署在 Cloudflare Workers 上。

## 技术栈

- **框架**: Hono (轻量级 Web 框架)
- **运行时**: Cloudflare Workers
- **数据库**: Cloudflare D1 (SQLite)
- **ORM**: Drizzle ORM
- **会话存储**: Cloudflare KV
- **认证**: Mastodon OAuth2
- **模板**: Hono JSX (SSR)

## 项目结构

```
src/
├── index.ts              # 入口文件
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
│   └── session.ts        # 会话管理
├── routes/
│   ├── auth.ts           # 认证路由 (/auth/*)
│   ├── home.tsx          # 首页路由 (/)
│   ├── topic.tsx         # 话题路由 (/topic/*)
│   ├── group.tsx         # 小组路由 (/group/*)
│   └── user.tsx          # 用户路由 (/user/*)
├── components/
│   ├── Layout.tsx        # 页面布局
│   ├── Navbar.tsx        # 导航栏
│   ├── HomePage.tsx      # 首页组件
│   ├── TopicCard.tsx     # 话题卡片
│   └── Sidebar.tsx       # 侧边栏
public/
└── static/
    ├── css/style.css     # 样式文件
    └── img/              # 静态图片
scripts/
└── migrate-data.js       # 数据迁移脚本
```

## 开发环境设置

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 Cloudflare 资源

需要 Node.js v20+ 和 Wrangler CLI。

```bash
# 登录 Cloudflare
npx wrangler login

# 创建 D1 数据库
npx wrangler d1 create neogroup

# 创建 KV 命名空间
npx wrangler kv namespace create KV
```

### 3. 创建本地配置

复制模板文件并填入你的 ID：

```bash
cp wrangler.toml.example wrangler.toml
```

编辑 `wrangler.toml`，替换占位符：

```toml
[[d1_databases]]
binding = "DB"
database_name = "neogroup"
database_id = "你的数据库ID"

[[kv_namespaces]]
binding = "KV"
id = "你的KV命名空间ID"
```

### 4. 初始化数据库

```bash
# 生成迁移文件
npx drizzle-kit generate

# 应用到本地开发数据库
npx wrangler d1 execute neogroup --local --file=drizzle/0000_*.sql

# 应用到远程生产数据库
npx wrangler d1 execute neogroup --remote --file=drizzle/0000_*.sql
```

### 5. 本地开发

```bash
npm run dev
```

访问 http://localhost:8787

### 6. 部署

```bash
npm run deploy
# 或
npx wrangler deploy
```

## 数据库表结构

| 表名 | 说明 |
|-----|------|
| user | 用户基本信息 |
| auth_provider | 认证方式（支持多种登录） |
| group | 小组 |
| group_member | 小组成员 |
| topic | 话题/帖子 |
| comment | 评论 |
| comment_like | 评论点赞 |
| report | 举报 |
| mastodon_app | Mastodon 应用配置 |

## 自定义域名

在 `wrangler.toml` 中添加:

```toml
[[routes]]
pattern = "你的域名.com"
custom_domain = true
```

需要先将域名添加到 Cloudflare 并删除已有的 A/CNAME 记录。

## 环境变量

| 变量 | 说明 |
|-----|------|
| APP_NAME | 应用名称，显示在页面标题 |
| APP_URL | 应用 URL（可选，会自动检测） |

## 常用命令

```bash
# 本地开发
npm run dev

# 部署
npm run deploy

# 生成数据库迁移
npx drizzle-kit generate

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
