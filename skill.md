# NeoGroup 部署指南

这是一份 AI Agent 友好的部署指南。你可以将本文件交给 Claude Code、Cursor 等 AI 工具，让它们自动完成部署。

## Cloudflare 免费版完全兼容

NeoGroup 只依赖以下 Cloudflare 免费资源，**无需付费**：

| 资源 | 用途 | 免费额度 |
|------|------|---------|
| Workers | 运行应用 | 10 万请求/天 |
| D1 | 数据库 | 5GB 存储 |
| KV | 会话存储 | 1GB 存储 |

以下资源为**可选**，不配置不影响核心功能：

| 资源 | 用途 | 不配置的影响 |
|------|------|-------------|
| R2 | 图片上传 | 不能上传头像和图片，其他功能正常 |
| Workers AI | Bot 长文自动生成标题 | 不用 Bot 功能则无影响 |
| Queue | Nostr event 投递 | 不能同步内容到 Nostr 网络 |

## 前置条件

- Node.js v20 或更高版本
- Cloudflare 账号（免费版即可，注册地址：https://dash.cloudflare.com/sign-up ）
- Wrangler CLI（通过 npx 自动使用，无需全局安装）

## 部署步骤

### 第 1 步：安装依赖

```bash
npm install
```

### 第 2 步：登录 Cloudflare

```bash
npx wrangler login
```

这会打开浏览器让用户授权。**Agent 注意**：这一步需要用户在浏览器中操作，等待命令返回成功即可。

验证登录成功：

```bash
npx wrangler whoami
```

预期输出包含账号名称和 Account ID。

### 第 3 步：创建 D1 数据库

```bash
npx wrangler d1 create neogroup
```

预期输出：
```
✅ Successfully created DB 'neogroup'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**记下 `database_id` 值。**

> 如果报错 `already exists`，说明已有同名数据库。运行 `npx wrangler d1 list` 查看已有数据库的 ID，直接使用即可。

### 第 4 步：创建 KV 命名空间

```bash
npx wrangler kv namespace create KV
```

预期输出：
```
✅ Successfully created KV namespace
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

**记下 `id` 值。**

> 如果报错 `already exists`，运行 `npx wrangler kv namespace list` 查看已有命名空间的 ID。

### 第 5 步：创建配置文件

```bash
cp wrangler.toml.example wrangler.toml
```

编辑 `wrangler.toml`，将占位符替换为实际的 ID：

- 将 `your-database-id-here` 替换为第 3 步获得的 D1 database_id
- 将 `your-kv-namespace-id-here` 替换为第 4 步获得的 KV id

`APP_URL` 暂时保留不动，第 8 步会处理。

> `wrangler.toml` 已在 `.gitignore` 中，不会被提交到仓库。

### 第 6 步：初始化数据库

**必须按顺序执行 `drizzle/` 目录下的所有 `.sql` 迁移文件**，缺少任何一个都会导致运行时报错。

本地开发数据库：

```bash
for f in drizzle/*.sql; do
  npx wrangler d1 execute neogroup --local --file="$f"
done
```

远程生产数据库：

```bash
for f in drizzle/*.sql; do
  npx wrangler d1 execute neogroup --remote --file="$f"
done
```

> `drizzle/*.sql` 的文件名以数字编号（0000、0001、...），shell glob 会按字母序展开，正好是正确的执行顺序。

### 第 7 步：本地开发验证

```bash
npm run dev
```

访问 http://localhost:8787 ，确认页面能正常加载。按 `Ctrl+C` 停止。

### 第 8 步：部署到 Cloudflare

```bash
npm run deploy
```

部署成功后，Wrangler 会输出你的 Workers URL，格式为：

```
https://neogroup.<your-subdomain>.workers.dev
```

**记下这个 URL。**

### 第 9 步：设置 APP_URL

编辑 `wrangler.toml`，将 `APP_URL` 设置为第 8 步获得的 Workers URL（或你的自定义域名）：

```toml
[vars]
APP_URL = "https://neogroup.xxx.workers.dev"
```

然后重新部署：

```bash
npm run deploy
```

> `APP_URL` 用于 ActivityPub 联邦身份。如果不设置，系统会从请求自动推断，但建议显式配置以确保一致性。

### 第 10 步：验证部署

访问你的 URL，确认：

1. 首页能正常加载
2. 点击登录，输入 Mastodon 实例域名（如 `mastodon.social`），能跳转到 OAuth 授权页面

## 可选：绑定自定义域名

如果你有自己的域名且已添加到 Cloudflare：

1. 在 `wrangler.toml` 中添加：

```toml
[[routes]]
pattern = "your-domain.com"
custom_domain = true
```

2. 将 `APP_URL` 更新为自定义域名：

```toml
[vars]
APP_URL = "https://your-domain.com"
```

3. 重新部署：`npm run deploy`

> **重要**：ActivityPub 身份绑定域名（如 `user@your-domain.com`），更换域名后已有的联邦关注关系会断开。请在首次部署时就确定好域名。

## 可选：启用图片上传（R2）

如果需要用户上传头像和图片：

1. 创建 R2 存储桶：

```bash
npx wrangler r2 bucket create neogroup-uploads
```

2. 在 `wrangler.toml` 中取消 R2 部分的注释：

```toml
[[r2_buckets]]
binding = "R2"
bucket_name = "neogroup-uploads"
```

3. 重新部署：`npm run deploy`

## 可选：启用 Nostr 集成

Nostr 集成允许用户将发帖/评论同步到 Nostr 去中心化网络。架构分为两部分：

- **Cloudflare Worker** — 密钥管理、签名、Queue 投递
- **Mac Mini**（或任意服务器）— 运行 broadcaster + 本地 relay，只推不拉

```
Worker → Queue → Mac Mini broadcaster → 公共 relay（分发）
                                       → 本地 relay（备份）
```

Nostr 客户端从公共 relay 读取内容。本地 relay 不对外暴露，只做私人存档。

### Cloudflare 侧配置

#### 1. 生成密钥

```bash
# AES-256 Master Key（用于加密用户 Nostr 私钥，64 位 hex）
openssl rand -hex 32

# Bridge Token（Worker 和 Mac Mini 共享认证）
openssl rand -hex 16
```

#### 2. 设置 Worker Secrets

```bash
npx wrangler secret put NOSTR_MASTER_KEY
# 粘贴 64 位 hex Master Key

npx wrangler secret put NOSTR_BRIDGE_TOKEN
# 粘贴 Bridge Token

npx wrangler secret put NOSTR_BRIDGE_URL
# 输入 Mac Mini broadcaster 的 URL（如 https://bridge.your-domain.com）
```

#### 3. 创建 Queue

```bash
npx wrangler queues create nostr-events
npx wrangler queues create nostr-events-dlq
```

#### 4. 启用 wrangler.toml 中的 Queue 配置

取消 `wrangler.toml` 中 Nostr Queue 部分的注释（producer 和 consumer 都要取消）：

```toml
[[queues.producers]]
queue = "nostr-events"
binding = "NOSTR_QUEUE"

[[queues.consumers]]
queue = "nostr-events"
max_batch_size = 20
max_retries = 5
dead_letter_queue = "nostr-events-dlq"
```

#### 5. 设置 NIP-05 推荐 relay

在 `wrangler.toml` 的 `[vars]` 中添加（指向公共 relay，不需要自己的域名）：

```toml
NOSTR_RELAY_URL = "wss://relay.damus.io"
```

此 URL 出现在 NIP-05 响应中，告诉 Nostr 客户端去哪里拉取用户 event。broadcaster 会把 event 推送到这些公共 relay，客户端直接从公共 relay 读取。

#### 6. 部署

```bash
npm run deploy
```

### Mac Mini 侧配置

Mac Mini 需要运行三个服务：

| 服务 | 端口 | 对外暴露 | 说明 |
|------|------|---------|------|
| nostr-rs-relay | 8080 | 否（仅 localhost） | 本地存档 relay |
| broadcaster | 3000 | 是（通过 tunnel） | 接收 Worker event 并广播 |
| cloudflared | — | — | 只暴露 bridge 域名 |

#### 1. 安装本地 relay

```bash
# 需要先安装 protobuf
brew install protobuf

# 安装 nostr-rs-relay
cargo install nostr-rs-relay
```

创建配置：

```bash
mkdir -p ~/.nostr-rs-relay
```

`~/.nostr-rs-relay/config.toml`：

```toml
[info]
name = "NeoGroup Archive"
description = "Private archive relay"

[network]
port = 8080
address = "127.0.0.1"
```

> relay 只监听 127.0.0.1，外部完全无法访问。broadcaster 通过 `ws://localhost:8080` 写入。

#### 2. 安装 broadcaster

```bash
cd broadcaster/
npm install
cp .env.example .env
```

编辑 `.env`：

```bash
BRIDGE_TOKEN=<与 Worker NOSTR_BRIDGE_TOKEN 相同的值>
RELAY_LIST=ws://localhost:8080,wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band
PORT=3000
```

- `ws://localhost:8080` — 本地 relay（私人备份，不占公共资源）
- 公共 relay — 用于内容分发。broadcaster 只推不拉，不会有外部连接进来

#### 3. 配置 Cloudflare Tunnel（只暴露 bridge）

只需要把 broadcaster 暴露给 Worker 调用，本地 relay 不需要对外暴露：

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create nostr-bridge
cloudflared tunnel route dns nostr-bridge bridge.your-domain.com
```

`~/.cloudflared/config.yml`：

```yaml
tunnel: <tunnel-id>
credentials-file: /Users/<username>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: bridge.your-domain.com
    service: http://localhost:3000
  - service: http_status:404
```

> 只有 `bridge.your-domain.com` 对外，且只有持有正确 Bearer Token 的 Worker 能调用。

#### 4. 启动所有服务

手动测试：

```bash
# 终端 1：本地 relay
nostr-rs-relay --config ~/.nostr-rs-relay/config.toml

# 终端 2：broadcaster
cd broadcaster && node index.js

# 终端 3：tunnel
cloudflared tunnel run nostr-bridge
```

用 pm2 守护进程（生产环境）：

```bash
npm install -g pm2

# 启动三个服务
pm2 start nostr-rs-relay -- --config ~/.nostr-rs-relay/config.toml
pm2 start broadcaster/index.js --name nostr-broadcaster
pm2 start cloudflared -- tunnel run nostr-bridge

# 保存 + 开机自启
pm2 save
pm2 startup
```

#### 5. 验证

```bash
# 1. broadcaster 健康检查（本地）
curl http://localhost:3000/health
# 预期：{"status":"ok","relays":{...},"connectedCount":4,"totalCount":4}

# 2. 通过 tunnel 访问
curl https://bridge.your-domain.com/health
# 预期：同上（说明 tunnel 正常）

# 3. 在网站上：编辑资料 → Nostr 设置 → 开启同步
# 4. 发一个帖子，检查 broadcaster 日志
pm2 logs nostr-broadcaster
# 预期：[Broadcast] Event xxxx... kind=1 -> relay.damus.io:ok, nos.lol:ok, ...

# 5. 在 Nostr 客户端（Damus/Amethyst）搜索 username@your-domain.com 验证 NIP-05
```

## Agent 自动化脚本

如果你是 AI Agent，可以按以下流程自动执行。每一步都有预期输出，用于验证是否成功。

```bash
# 1. 安装依赖
npm install

# 2. 从模板创建配置文件
cp wrangler.toml.example wrangler.toml

# 3. 登录 Cloudflare（需要用户在浏览器中操作）
npx wrangler login

# 4. 创建 D1 数据库并提取 ID
#    如果已存在，从 list 命令获取
D1_OUTPUT=$(npx wrangler d1 create neogroup 2>&1) || true
D1_ID=$(echo "$D1_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
if [ -z "$D1_ID" ]; then
  D1_ID=$(npx wrangler d1 list 2>&1 | grep neogroup | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
fi
echo "D1 ID: $D1_ID"

# 5. 创建 KV 命名空间并提取 ID
#    如果已存在，从 list 命令获取
KV_OUTPUT=$(npx wrangler kv namespace create KV 2>&1) || true
KV_ID=$(echo "$KV_OUTPUT" | grep -oE '[0-9a-f]{32}')
if [ -z "$KV_ID" ]; then
  KV_ID=$(npx wrangler kv namespace list 2>&1 | grep -A1 "KV" | grep -oE '[0-9a-f]{32}')
fi
echo "KV ID: $KV_ID"

# 6. 更新 wrangler.toml（跨平台兼容写法）
#    Agent 建议直接用文件编辑工具替换，而不是 sed
#    如果必须用 sed：
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/your-database-id-here/$D1_ID/" wrangler.toml
  sed -i '' "s/your-kv-namespace-id-here/$KV_ID/" wrangler.toml
else
  sed -i "s/your-database-id-here/$D1_ID/" wrangler.toml
  sed -i "s/your-kv-namespace-id-here/$KV_ID/" wrangler.toml
fi

# 7. 初始化数据库（本地 + 远程，执行全部迁移文件）
for f in drizzle/*.sql; do
  npx wrangler d1 execute neogroup --local --file="$f"
done
for f in drizzle/*.sql; do
  npx wrangler d1 execute neogroup --remote --file="$f"
done

# 8. 部署
npm run deploy
# 从输出中提取 Workers URL，更新 wrangler.toml 的 APP_URL，然后再次部署

# 9. 验证
# 访问 Workers URL 确认首页可加载
```

> **提示**：Agent 使用文件编辑工具（如 Edit）直接修改 `wrangler.toml` 比用 `sed` 更可靠。

## 常见问题

### Q: 登录时提示回调地址无效？

Mastodon 应用是按域名注册的。如果你更换了部署域名，需要清空 mastodon_app 表：

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

如果遇到权限问题（`EPERM`）：

```bash
WRANGLER_LOG=none npx wrangler tail neogroup --format=pretty
```

### Q: ActivityPub 联邦需要注意什么？

- `.workers.dev` 域名可以使用 ActivityPub，但建议用自定义域名
- 用户 AP 身份绑定域名（如 `user@neogrp.club`），**更换域名后关注关系会断开**
- 用户首次被 AP 请求访问时自动生成密钥对，无需额外配置
