# NeoGroup 开发环境设置

这是一个 Claude Code Agent 技能文件，用于帮助开发者快速搭建 NeoGroup 开发环境。

## 前置条件

- Node.js v20 或更高版本
- Cloudflare 账号
- Wrangler CLI（会自动通过 npx 使用）

## 设置步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

这会打开浏览器让你授权 Wrangler 访问你的 Cloudflare 账号。

### 3. 创建 D1 数据库

```bash
npx wrangler d1 create neogroup
```

输出示例：
```
✅ Successfully created DB 'neogroup'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**记下 `database_id`，后面要用。**

### 4. 创建 KV 命名空间

```bash
npx wrangler kv namespace create KV
```

输出示例：
```
✅ Successfully created KV namespace "KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

**记下 `id`，后面要用。**

### 5. 创建本地配置文件

从模板创建配置文件：

```bash
cp wrangler.toml.example wrangler.toml
```

编辑 `wrangler.toml`，替换占位符：

```toml
[[d1_databases]]
binding = "DB"
database_name = "neogroup"
database_id = "替换为你的database_id"

[[kv_namespaces]]
binding = "KV"
id = "替换为你的KV命名空间id"
```

### 6. 初始化数据库表结构

```bash
# 生成迁移 SQL（如果 drizzle 目录已有则跳过）
npx drizzle-kit generate

# 应用到本地开发数据库
npx wrangler d1 execute neogroup --local --file=drizzle/0000_peaceful_white_tiger.sql

# 应用到远程生产数据库
npx wrangler d1 execute neogroup --remote --file=drizzle/0000_peaceful_white_tiger.sql
```

### 7. 本地开发

```bash
npm run dev
```

访问 http://localhost:8787

### 8. 部署到 Cloudflare

```bash
npm run deploy
```

### 9. 设置 APP_URL 环境变量

ActivityPub 联邦功能需要知道站点的公开 URL。在 `wrangler.toml` 中添加：

```toml
[vars]
APP_URL = "https://your-domain.com"
APP_NAME = "NeoGroup"
# MASTODON_BOT_TOKEN = "..." (deprecated)
# MASTODON_BOT_DOMAIN = "..." (deprecated)
```

如果不设置 `APP_URL`，系统会从请求的 `Origin` 自动推断，但建议显式配置以确保 AP URL 一致性。

## 可选：绑定自定义域名

1. 确保域名已添加到 Cloudflare
2. 删除域名已有的 A/CNAME 记录
3. 在 `wrangler.toml` 中添加：

```toml
[[routes]]
pattern = "your-domain.com"
custom_domain = true
```

4. 重新部署：`npm run deploy`

## 数据库迁移

首次部署后，需要按顺序执行 `drizzle/` 目录下的所有迁移文件。迁移文件以数字编号，必须按顺序执行：

```bash
# 查看所有迁移文件
ls drizzle/*.sql

# 逐个执行（远程）
npx wrangler d1 execute neogroup --remote --file=drizzle/0000_peaceful_white_tiger.sql
npx wrangler d1 execute neogroup --remote --file=drizzle/0001_xxx.sql
# ... 依次执行所有 .sql 文件
```

**重要**：新部署必须执行所有迁移文件，否则会缺少表或字段导致运行时错误。

最近新增迁移示例：

```bash
# 站内关注（user_follow）
npx wrangler d1 execute neogroup --remote --file=drizzle/0015_user_follow.sql
```

## ActivityPub 注意事项

- ActivityPub 需要 HTTPS + 自定义域名才能正常工作（`.workers.dev` 域名也可以，但建议用自定义域名）
- 用户的 AP 身份绑定域名（如 `user@neogrp.club`），**更换域名后 AP 身份会失效**，已有的关注关系会断开
- 用户首次被 AP 请求访问时会自动生成密钥对，无需额外配置
- Backfill 端点 (`POST /ap/users/:username/backfill`) 可以将已有话题推送给关注者，需要登录后访问

## 常见问题

### Q: 登录时提示回调地址无效？

Mastodon 应用是按域名注册的。如果你更换了部署域名，需要清空 mastodon_app 表让系统重新注册：

```bash
npx wrangler d1 execute neogroup --remote --command="DELETE FROM mastodon_app;"
```

### Q: 如何查看远程数据库内容？

```bash
npx wrangler d1 execute neogroup --remote --command="SELECT * FROM user LIMIT 10;"
```

### Q: 如何查看 Worker 日志？

```bash
npx wrangler tail
```

如果遇到 Wrangler 写日志文件权限问题（`EPERM`），可以用：

```bash
WRANGLER_LOG=none npx wrangler tail neogroup --format=pretty
```

## 项目技术栈

| 组件 | 技术 |
|-----|------|
| Web 框架 | Hono |
| 运行时 | Cloudflare Workers |
| 数据库 | Cloudflare D1 (SQLite) |
| ORM | Drizzle |
| 会话存储 | Cloudflare KV |
| 认证 | Mastodon OAuth2 |
| 模板引擎 | Hono JSX (SSR) |
| 样式 | 原生 CSS (豆瓣风格) |

## Agent 自动化脚本

如果你是 AI Agent，可以按以下顺序执行命令来自动设置环境：

```bash
# 1. 安装依赖
npm install

# 2. 从模板创建配置文件
cp wrangler.toml.example wrangler.toml

# 3. 登录 Cloudflare（需要用户交互）
npx wrangler login

# 4. 创建 D1 数据库并提取 ID
D1_OUTPUT=$(npx wrangler d1 create neogroup 2>&1)
D1_ID=$(echo "$D1_OUTPUT" | grep -o 'database_id = "[^"]*"' | cut -d'"' -f2)

# 5. 创建 KV 命名空间并提取 ID
KV_OUTPUT=$(npx wrangler kv namespace create KV 2>&1)
KV_ID=$(echo "$KV_OUTPUT" | grep -o 'id = "[^"]*"' | cut -d'"' -f2)

# 6. 更新 wrangler.toml 中的 ID
sed -i '' "s/your-database-id-here/$D1_ID/" wrangler.toml
sed -i '' "s/your-kv-namespace-id-here/$KV_ID/" wrangler.toml

# 7. 初始化数据库（执行所有迁移文件）
for f in drizzle/*.sql; do
  npx wrangler d1 execute neogroup --local --file="$f"
done

# 8. 启动开发服务器
npm run dev
```

**注意：** `wrangler.toml` 已加入 `.gitignore`，不会被提交到仓库，避免泄露你的资源 ID。
