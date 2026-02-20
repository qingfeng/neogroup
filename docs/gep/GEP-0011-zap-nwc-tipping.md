# GEP-0011: Zap 打赏 — 基于 NWC 的点对点 Lightning 打赏

- Status: Draft
- Author: qingfeng
- Created: 2026-02-21
- Target Version: future
- Related: NIP-47 (Nostr Wallet Connect), LNURL-pay (LUD-06/16), Lightning Network

## Summary

为帖子和评论添加 Zap（⚡ 打赏）功能。用户自行配置钱包，资金点对点流转，平台不经手：

1. **收款方** — 设置 Lightning Address（如 `user@getalby.com`）
2. **付款方** — 设置 NWC 连接串（从 Alby、Phoenix 等钱包获取）
3. **Zap 按钮** — 帖子/评论上点击 ⚡ → 选金额 → 自动完成支付
4. **Zap 展示** — 帖子/评论显示累计 Zap 金额

## Motivation

当前 NeoGroup 的 Lightning 支付（GEP-0005）是站内余额模式：用户充值到站内 → 站内转账/购买。这依赖平台运营 LNbits 基础设施。

Zap 打赏是一种更轻量的方式：

| 对比 | 站内余额 (GEP-0005) | Zap 打赏 (本提案) |
|------|---------------------|-------------------|
| 资金流向 | 用户 → 站内 → 用户 | 用户钱包 → 用户钱包（点对点） |
| 平台角色 | 托管余额 | 仅撮合（不碰钱） |
| 基础设施 | 需要 LNbits + Alby Hub | 无需任何后端（用户自带钱包） |
| 配置门槛 | 平台管理员部署 Lightning 节点 | 用户各自配置自己的钱包 |
| 适用场景 | 付费内容、DVM escrow | 打赏、社交激励 |

两者可共存：站内余额用于复杂场景（付费内容、escrow），Zap 用于轻量打赏。即使未部署 LNbits，Zap 也能独立工作。

## Goals

- 用户配置 Lightning Address 即可收款，配置 NWC 即可付款
- 支付全程点对点，平台不托管任何资金
- 无需站内余额系统，无需 LNbits 基础设施
- 帖子/评论展示 Zap 累计金额和记录
- Web UI 和 API 都支持

## Non-Goals

- 不替代 GEP-0005 站内余额（两者独立共存）
- 不做 Nostr NIP-57 Zap Receipt（不发布 Zap 到 Nostr 网络）
- 不做平台抽成
- 不做匿名打赏（Zap 记录关联发送者）
- 不做法币支付

## Design

### 核心流程

```
用户 A 点击帖子上的 ⚡ 按钮，选择 100 sats
  │
  ▼
Worker 解析收款方 Lightning Address
  → GET https://recipient-domain/.well-known/lnurlp/username
  → GET callback?amount=100000  (毫聪)
  → 获得 bolt11 invoice
  │
  ▼
Worker 通过发送方 NWC 发起支付
  → 解析 NWC 连接串 (nostr+walletconnect://...)
  → WebSocket 连接 NWC relay
  → 发送加密 pay_invoice 请求 (kind 23194)
  → 等待支付结果 (kind 23195)
  │
  ▼
支付成功
  → 写入 zap 表
  → 更新帖子累计 Zap 金额
  → 通知收款方
```

### 用户设置

#### 收款：Lightning Address

用户在个人设置页填写 Lightning Address（如 `user@getalby.com`、`user@walletofsatoshi.com`）。

Lightning Address 本质是 LNURL-pay 的人类可读形式（[LUD-16](https://github.com/lnurl/luds/blob/luds/16.md)），任何支持 LNURL 的钱包都能生成。

存储在 `user.lightning_address` 字段（已存在）。

#### 付款：NWC 连接串

用户在个人设置页填写 NWC 连接串，格式：

```
nostr+walletconnect://<wallet_pubkey>?relay=<relay_url>&secret=<secret_key>
```

获取方式：打开钱包 App（Alby、Phoenix、Mutiny 等）→ 设置 → Nostr Wallet Connect → 创建连接 → 复制连接串。

NWC 连接串包含一个 secret key，具有支付权限，必须加密存储。使用 AES-256-GCM 加密后存入数据库（复用 `NOSTR_MASTER_KEY` 或新增专用密钥）。

### NWC 通信 (NIP-47)

NWC 使用 Nostr relay 作为通信通道，但不依赖 Nostr 社交网络。流程：

```
Worker                          NWC Relay                    用户钱包
  │                                │                            │
  │  WebSocket connect             │                            │
  ├───────────────────────────────►│                            │
  │                                │                            │
  │  ["EVENT", {                   │                            │
  │    kind: 23194,                │  转发给钱包                │
  │    content: encrypt({          ├───────────────────────────►│
  │      method: "pay_invoice",    │                            │
  │      params: {                 │                            │
  │        invoice: "lnbc..."      │                            │
  │      }                         │                            │
  │    })                          │                            │
  │  }]                            │                            │
  │                                │                            │
  │                                │  ["EVENT", {               │
  │                                │    kind: 23195,            │
  │  收到支付结果                   │◄───────────────────────────┤
  │◄───────────────────────────────┤    content: encrypt({      │
  │                                │      result_type: "...",   │
  │  WebSocket close               │      result: { preimage } │
  │                                │    })                      │
  │                                │  }]                        │
```

**关键实现细节**：

- 加密方式：NIP-04（AES-CBC + ECDH 共享密钥）
- 签名：用 NWC 连接串中的 `secret` 签名请求事件
- 超时：等待响应最多 30 秒
- 项目已有 secp256k1（`@noble/curves`）和 WebSocket relay 通信代码，可复用

### LNURL-pay 解析

将 Lightning Address 转换为 bolt11 invoice：

```typescript
async function fetchInvoice(lightningAddress: string, amountMsats: number): Promise<string> {
  const [user, domain] = lightningAddress.split('@')
  // 1. 获取 LNURL-pay metadata
  const metadata = await fetch(`https://${domain}/.well-known/lnurlp/${user}`)
  const { callback, minSendable, maxSendable } = await metadata.json()

  // 2. 验证金额范围
  if (amountMsats < minSendable || amountMsats > maxSendable) throw Error

  // 3. 请求 invoice
  const invoice = await fetch(`${callback}?amount=${amountMsats}`)
  const { pr } = await invoice.json()  // pr = bolt11 payment request
  return pr
}
```

### 数据模型

#### user 表变更

| 字段 | 类型 | 说明 |
|------|------|------|
| `lightning_address` | TEXT | 收款用 Lightning Address（已存在） |
| `nwc_encrypted` | TEXT | NWC 连接串（AES-256-GCM 加密） |
| `nwc_iv` | TEXT | 加密 IV（base64） |

#### 新表：`zap`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | nanoid |
| `sender_id` | TEXT FK→user | 打赏者 |
| `recipient_id` | TEXT FK→user | 收款方 |
| `topic_id` | TEXT FK→topic NULL | 关联话题 |
| `comment_id` | TEXT FK→comment NULL | 关联评论 |
| `amount_sats` | INTEGER | 打赏金额 |
| `payment_hash` | TEXT | Lightning 支付 hash（去重） |
| `created_at` | INTEGER | 时间戳 |

索引：`(topic_id)`、`(comment_id)`、`(recipient_id)`、`(payment_hash)` UNIQUE

#### topic / comment 表变更

| 字段 | 类型 | 说明 |
|------|------|------|
| `zap_total` | INTEGER DEFAULT 0 | 累计 Zap 金额（冗余，避免每次 SUM） |

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `PUT` | `/api/me` | 更新 `lightning_address`（已有）、`nwc`（新增） |
| `POST` | `/api/topics/:id/zap` | Zap 话题 `{ amount_sats }` |
| `POST` | `/api/topics/:id/comments/:cid/zap` | Zap 评论 `{ amount_sats }` |
| `GET` | `/api/topics/:id/zaps` | 话题的 Zap 记录 |

### Web UI

#### 设置页

用户设置页新增两个字段：
- **Lightning Address**（收款）— 文本输入，提示 `user@getalby.com`
- **NWC 连接**（付款）— 密码输入，提示粘贴 `nostr+walletconnect://...`

#### Zap 按钮

帖子/评论 meta 区域增加 ⚡ 按钮：

```
⚡ 2,100 sats
```

点击弹出金额选择：

```
┌─────────────────────┐
│  ⚡ Zap              │
│                     │
│  21  100  500  1000 │
│  [ 自定义金额 ]      │
│                     │
│  [发送]              │
└─────────────────────┘
```

- 收款方未设 Lightning Address → ⚡ 按钮不显示
- 当前用户未设 NWC → 点击后提示去设置
- 支付中 → 按钮显示 loading
- 支付成功 → 金额动画更新 + toast 提示

#### Zap 列表

点击累计金额可展开 Zap 记录（类似点赞列表弹窗）：

```
⚡ 2,100 sats
├── alice  500 sats  2分钟前
├── bob    1000 sats  1小时前
└── carol  600 sats  3小时前
```

### 通知

新增通知类型：

| type | 说明 |
|------|------|
| `zap` | "alice ⚡ 打赏了你的帖子 100 sats" |

### 错误处理

| 场景 | 处理 |
|------|------|
| 收款方 Lightning Address 无效/不可达 | 返回错误，提示收款方 Lightning Address 有问题 |
| LNURL-pay 金额超出范围 | 返回错误，提示调整金额 |
| NWC 连接失败（relay 不可达） | 返回错误，提示检查 NWC 配置 |
| NWC 支付被钱包拒绝（余额不足等） | 返回钱包错误信息 |
| NWC 响应超时（30s） | 返回超时错误 |
| 重复支付（相同 payment_hash） | 幂等处理，不重复记录 |

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/db/schema.ts` | 加 `nwcEncrypted`/`nwcIv` 字段、`zapTotal` 字段、`zaps` 表 |
| `src/services/nwc.ts` | **新文件**：NWC 连接串解析、加密通信、`payInvoice()` |
| `src/services/lnurl.ts` | **新文件**：Lightning Address 解析、`fetchInvoice()` |
| `src/routes/api.ts` | 加 Zap 端点、更新 PUT /api/me |
| `src/routes/topic.tsx` | Web UI Zap 按钮、金额弹窗、Zap 列表 |
| `src/routes/user.tsx` | 设置页加 Lightning Address 和 NWC 输入 |
| `src/components/ZapButton.tsx` | **新文件**：Zap 按钮组件 |
| `src/lib/notifications.ts` | 加 `zap` 通知类型 |
| `drizzle/xxxx_zap.sql` | 迁移 SQL |
| `public/static/css/style.css` | Zap 按钮和弹窗样式 |

## Security Considerations

- **NWC 密钥存储**：NWC 连接串含支付权限的 secret key，必须 AES-256-GCM 加密后存入 D1，解密仅在支付时短暂进行
- **金额限制**：单次 Zap 建议限制最大金额（如 10,000 sats），防误操作
- **LNURL 验证**：只信任 HTTPS 的 LNURL-pay 端点
- **重放防护**：`payment_hash` 唯一索引，防止重复记录
- **NWC relay 安全**：WebSocket 连接使用加密消息（NIP-04），中间人无法读取支付请求
- **无资金托管风险**：平台不持有任何资金，即使数据库泄露也无法转走用户的钱（NWC secret 加密存储，且支付需要钱包确认）

## Alternatives Considered

| 方案 | 优点 | 缺点 |
|------|------|------|
| 站内余额打赏 (GEP-0005) | 即时、无需外部钱包 | 平台托管资金，需要 LNbits 基础设施 |
| WebLN (浏览器扩展) | 标准化，Alby 扩展支持 | 仅限浏览器，Agent 无法使用 |
| LNURL-withdraw (收款方拉取) | 收款方主动 | 流程复杂，不适合打赏场景 |
| **NWC (NIP-47)** | 点对点、Agent 友好、无需基础设施、用户自带钱包 | 需要用户自行配置 NWC |

## Open Questions

1. **NWC 加密密钥** — 复用 `NOSTR_MASTER_KEY` 还是新增专用 `ZAP_ENCRYPTION_KEY`？（建议新增，避免 Nostr 未启用时无法加密）
2. **Zap 金额预设** — 默认档位 21/100/500/1000 sats 是否合适？
3. **匿名打赏** — 是否支持不记录发送者的匿名 Zap？（第一版建议不支持）
4. **NWC 权限控制** — 是否允许用户设置单次/每日最大 Zap 额度？（钱包侧通常有此控制）
5. **离线钱包** — 用户钱包离线时 NWC 支付会超时，是否需要排队重试？（建议不重试，直接报错）

## Implementation Plan

### Phase 1：核心支付流程

1. 数据库迁移：`zaps` 表、user 表加 NWC 字段
2. `src/services/lnurl.ts` — LNURL-pay 解析
3. `src/services/nwc.ts` — NWC 通信
4. `src/routes/api.ts` — Zap API 端点
5. 端到端测试

### Phase 2：Web UI

1. 用户设置页加 Lightning Address / NWC 输入
2. Zap 按钮组件 + 金额选择弹窗
3. Zap 列表展示
4. 通知

### Phase 3：优化

1. Zap 动画效果
2. 累计金额实时更新
3. 错误处理 UI 优化

## References

- [NIP-47: Nostr Wallet Connect](https://nips.nostr.com/47) — NWC 协议规范
- [LUD-06: LNURL-pay](https://github.com/lnurl/luds/blob/luds/06.md) — LNURL-pay 基础规范
- [LUD-16: Lightning Address](https://github.com/lnurl/luds/blob/luds/16.md) — 人类可读 Lightning Address
- [Alby NWC](https://nwc.getalby.com) — Alby 的 NWC 实现
- [NWC HTTP](https://github.com/getAlby/http-nostr) — NWC over HTTP（备选方案）
- [@noble/curves](https://github.com/paulmillr/noble-curves) — secp256k1（项目已使用）
