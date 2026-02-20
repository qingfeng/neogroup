# GEP-0012: Group Token — 小组代币发行与跨站打赏

- Status: Draft
- Author: qingfeng
- Created: 2026-02-21
- Target Version: future
- Related: ActivityPub, GEP-0011 (Zap)

## Summary

每个小组的管理员可以发行自己的代币（Token）：

1. **发行** — 设定名称、符号、图标、总量、管理员留存比例
2. **分配** — 给组员空投、通过社区行为（发帖/回复/点赞）挖矿获得
3. **打赏** — 用 Token 打赏帖子/评论，跨小组、跨 NeoGroup 实例
4. **流通** — 用户之间可以自由转账 Token

## Motivation

社区需要自己的激励机制。Lightning sats 是通用货币，但每个小组的文化和价值观不同：

| 场景 | sats 打赏 | Group Token |
|------|----------|-------------|
| 摄影小组奖励优质作品 | 需要真金白银 | 发行 📷 Token，零成本激励 |
| 读书小组鼓励写长评 | 门槛高 | 发行 📚 Token，写评论即挖矿 |
| 技术小组奖励回答问题 | 不直观 | 发行 🔧 Token，社区贡献可量化 |
| 跨站交流 | 各站独立 | Token 通过 AP 协议跨站流通 |

Token 不是加密货币，没有链上交易、没有 gas fee、没有合约。它就是一个社区积分系统，但具备跨 NeoGroup 实例的流通能力。

## Goals

- 小组管理员可一键发行 Token，自定义名称/符号/图标/总量
- 组员通过社区行为（发帖/回复/点赞/被赞）自动获得 Token
- 用 Token 打赏本组、其他小组、甚至其他 NeoGroup 实例的帖子
- 通过 ActivityPub 实现跨站 Token 转移
- Web UI + API 都支持

## Non-Goals

- 不做交易所 / Token 互换（不同小组的 Token 之间不设汇率）
- 不做链上发行（不上任何区块链）
- 不做 Token 销毁/回购机制（第一版）
- 不和 Lightning sats 挂钩（Token 是独立的积分体系）
- 不做治理投票（第一版）

## Design

### Token 属性

管理员创建 Token 时设置：

| 属性 | 说明 | 示例 |
|------|------|------|
| `name` | 代币名称 | 光影币 |
| `symbol` | 符号（2-8 字符，唯一） | PHOTO |
| `icon_url` | 图标 | 📷 emoji 或上传图片 |
| `total_supply` | 总量（0 = 无上限） | 1,000,000 |
| `admin_allocation_pct` | 管理员初始分配比例 | 10% |
| `airdrop_per_member` | 每位现有成员空投数量 | 100 |
| `reward_post` | 发帖奖励 | 10 |
| `reward_reply` | 回复奖励 | 5 |
| `reward_like` | 点赞奖励 | 1 |
| `reward_liked` | 被赞奖励 | 2 |

#### 发行流程

```
管理员点击 "发行 Token"
  │
  ├── 填写名称、符号、图标、总量
  ├── 设置管理员留存比例（如 10%）
  ├── 设置是否给现有组员空投（如每人 100）
  ├── 设置行为奖励规则
  │
  ▼
创建 Token
  ├── 管理员账户 +100,000（10% 留存）
  ├── 现有 50 名组员各 +100（空投 5,000）
  └── 剩余 895,000 进入矿池（通过行为挖矿释放）
```

#### 供应量管理

- `total_supply = 0`：无上限，行为奖励永不枯竭
- `total_supply > 0`：有上限，`mined_total` 追踪已释放量，当 `mined_total >= total_supply - admin_allocated - airdropped` 时停止挖矿奖励
- 管理员可以后续调整行为奖励数量（但不能增发总量）

### 数据模型

#### 新表：`group_token`（Token 定义）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | nanoid |
| `group_id` | TEXT FK→group UNIQUE | 每组最多一种 Token |
| `name` | TEXT | 代币名称 |
| `symbol` | TEXT UNIQUE | 符号（全站唯一） |
| `icon_url` | TEXT | 图标 URL 或 emoji |
| `total_supply` | INTEGER DEFAULT 0 | 总量（0=无上限） |
| `mined_total` | INTEGER DEFAULT 0 | 已挖矿释放总量 |
| `admin_allocation_pct` | INTEGER DEFAULT 0 | 管理员初始分配 % |
| `airdrop_per_member` | INTEGER DEFAULT 0 | 空投数量/人 |
| `reward_post` | INTEGER DEFAULT 0 | 发帖奖励 |
| `reward_reply` | INTEGER DEFAULT 0 | 回复奖励 |
| `reward_like` | INTEGER DEFAULT 0 | 点赞奖励 |
| `reward_liked` | INTEGER DEFAULT 0 | 被赞奖励 |
| `created_at` | INTEGER | 创建时间 |

#### 新表：`token_balance`（用户持有余额）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | nanoid |
| `user_id` | TEXT FK→user | 持有者 |
| `token_id` | TEXT FK→group_token | 哪种 Token |
| `balance` | INTEGER DEFAULT 0 | 余额 |
| `updated_at` | INTEGER | 最后变动时间 |

唯一索引：`(user_id, token_id)`

#### 新表：`token_tx`（交易记录）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | nanoid |
| `token_id` | TEXT FK→group_token | Token |
| `from_user_id` | TEXT NULL | 发送方（NULL = 系统发放） |
| `to_user_id` | TEXT | 接收方 |
| `amount` | INTEGER | 数量 |
| `type` | TEXT | 交易类型（见下表） |
| `ref_id` | TEXT | 关联 ID（topic_id / comment_id 等） |
| `memo` | TEXT | 备注 |
| `remote_actor_uri` | TEXT | 跨站时远程 actor URI |
| `created_at` | INTEGER | 时间戳 |

#### 交易类型

| type | 说明 | from | to |
|------|------|------|-----|
| `admin_mint` | 管理员初始分配 | NULL | admin |
| `airdrop` | 组员空投 | NULL | member |
| `reward_post` | 发帖奖励 | NULL | poster |
| `reward_reply` | 回复奖励 | NULL | replier |
| `reward_like` | 点赞奖励 | NULL | liker |
| `reward_liked` | 被赞奖励 | NULL | author |
| `tip` | 打赏 | tipper | author |
| `transfer` | 转账 | sender | receiver |
| `tip_remote_in` | 收到跨站打赏 | NULL(remote) | local user |
| `tip_remote_out` | 发出跨站打赏 | local user | NULL(remote) |

### 行为挖矿

用户在小组内的行为自动触发 Token 奖励，嵌入到现有代码的业务逻辑中：

```
发帖 (routes/topic.tsx, routes/api.ts)
  → 写入 topic 表后
  → 如果该小组有 Token 且 reward_post > 0
  → creditToken(user, token, reward_post, 'reward_post', topicId)

回复 (routes/topic.tsx, routes/api.ts)
  → 写入 comment 表后
  → 回复者获得 reward_reply
  → 被回复者获得 reward_liked（如果是顶层回复则帖子作者获得）

点赞 (routes/topic.tsx, routes/api.ts)
  → 写入 like 表后
  → 点赞者获得 reward_like
  → 被赞者获得 reward_liked
```

#### 供应量检查

有上限的 Token 在发放奖励前检查：

```typescript
function canMineReward(token: GroupToken, amount: number): boolean {
  if (token.totalSupply === 0) return true  // 无上限
  const available = token.totalSupply - token.adminAllocated - token.airdropped - token.minedTotal
  return available >= amount
}
```

不够时跳过奖励（不报错，静默停止挖矿）。

### Token 打赏

#### 本站打赏

和 GEP-0011 Zap 类似，但用 Token 而非 sats：

```
用户 A 在帖子上点击 Token 打赏按钮
  → 弹出自己持有的 Token 列表
  → 选择 Token 和数量
  → debitToken(A, token, amount)
  → creditToken(author, token, amount)
  → 写入 token_tx 表
  → 帖子累计 Token 打赏 +amount
  → 通知作者
```

帖子/评论上显示收到的 Token 打赏汇总：

```
📷 120 PHOTO  · 📚 35 BOOK  · ⚡ 500 sats
```

#### 跨站打赏（ActivityPub）

Token 通过 ActivityPub 的自定义 Activity 跨 NeoGroup 实例传输。

**Token 标识**：`symbol@domain`（如 `PHOTO@neogrp.club`），类似 AP 用户标识。

**发送打赏**：

```
用户 A (站1) 打赏 站2 的帖子 50 PHOTO
  │
  ├── 1. debitToken(A, PHOTO, 50)
  ├── 2. 记录 token_tx (tip_remote_out)
  │
  ▼
  3. 发送 AP Activity 到站2：
  {
    "@context": ["https://www.w3.org/ns/activitystreams",
                 {"neogroup": "https://neogrp.club/ns#"}],
    "type": "neogroup:TokenTip",
    "actor": "https://站1/ap/users/userA",
    "object": "https://站2/ap/notes/topicXxx",
    "neogroup:token": {
      "symbol": "PHOTO",
      "name": "光影币",
      "issuer": "https://站1/ap/groups/photography",
      "icon": "📷"
    },
    "neogroup:amount": 50
  }
```

**接收打赏**：

```
站2 Inbox 收到 TokenTip Activity
  │
  ├── 1. 验证 HTTP 签名（确认来自站1）
  ├── 2. 解析 Token 信息
  ├── 3. 在本站注册该远程 Token（如果首次见到）
  ├── 4. creditToken(recipient, remote_token, 50)
  ├── 5. 记录 token_tx (tip_remote_in)
  └── 6. 通知收款方
```

**远程 Token 注册**：

首次收到来自其他站点的 Token 时，自动在本站创建一条 `remote_token` 记录（不占用本站 symbol 命名空间）。远程 Token 的完整标识始终是 `symbol@origin_domain`。

#### 新表：`remote_token`（远程 Token 镜像）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | nanoid |
| `symbol` | TEXT | 原始 symbol |
| `name` | TEXT | 名称 |
| `icon_url` | TEXT | 图标 |
| `origin_domain` | TEXT | 发行站点域名 |
| `origin_group_actor` | TEXT | 发行小组 AP actor URL |
| `created_at` | INTEGER | 首次见到的时间 |

唯一索引：`(symbol, origin_domain)`

`token_balance` 和 `token_tx` 表通过 `token_id` 关联，本站 Token 指向 `group_token.id`，远程 Token 指向 `remote_token.id`。用一个 `token_type` 字段区分：`local` / `remote`。

### 用户资产页

用户个人页增加 "我的 Token" 面板：

```
┌─────────────────────────────────┐
│  我的 Token                     │
│                                 │
│  📷 PHOTO         1,250        │
│     光影币 · photography@neogrp.club │
│                                 │
│  📚 BOOK            380        │
│     读书币 · reading@neogrp.club    │
│                                 │
│  🔧 HACK             50        │
│     极客币 · hackers@other.group    │  ← 来自其他站
│                                 │
└─────────────────────────────────┘
```

### API 端点

#### Token 管理（管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/groups/:id/token` | 发行 Token |
| `PUT` | `/api/groups/:id/token` | 修改奖励规则 |
| `GET` | `/api/groups/:id/token` | Token 信息（公开） |
| `POST` | `/api/groups/:id/token/airdrop` | 补充空投给新成员 |

#### Token 操作（用户）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/me/tokens` | 我的 Token 余额列表 |
| `POST` | `/api/topics/:id/tip` | 打赏帖子 `{ token_id, amount }` |
| `POST` | `/api/topics/:id/comments/:cid/tip` | 打赏评论 |
| `POST` | `/api/token/transfer` | 转账 `{ token_id, to_username, amount }` |
| `GET` | `/api/token/:id/txs` | Token 交易记录 |

#### Token 排行（公开）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/groups/:id/token/leaderboard` | 小组 Token 持有排行 |

### Web UI

#### 管理员：Token 发行页

小组设置 → "发行 Token"：

```
┌─────────────────────────────────┐
│  发行小组 Token                  │
│                                 │
│  名称:    [光影币          ]     │
│  符号:    [PHOTO           ]     │
│  图标:    [📷] 或 [上传图片]     │
│  总量:    [1000000] (0=无上限)   │
│                                 │
│  ── 分配 ──                     │
│  管理员留存: [10] %              │
│  组员空投:   [100] /人           │
│                                 │
│  ── 行为奖励 ──                  │
│  发帖:  [10]  回复:  [5]        │
│  点赞:  [1]   被赞:  [2]        │
│                                 │
│  [发行]                         │
└─────────────────────────────────┘
```

#### 帖子/评论：打赏按钮

```
❤️ 12   🔁 3   ⚡ 500 sats   📷 120 PHOTO
                                    ↑
                              点击弹出打赏框
```

打赏弹窗：

```
┌────────────────────────┐
│  打赏 Token             │
│                        │
│  📷 PHOTO (余额: 1,250) │
│  数量: [50        ]     │
│                        │
│  [打赏]                 │
└────────────────────────┘
```

- 只显示用户持有的 Token
- 余额不足时禁用发送按钮

#### 小组页：Token 信息卡

小组首页侧边栏显示 Token 信息：

```
┌──────────────────────┐
│  📷 PHOTO · 光影币    │
│                      │
│  总量: 1,000,000     │
│  已流通: 105,000      │
│  持有人: 50           │
│                      │
│  发帖 +10 · 回复 +5   │
│  点赞 +1 · 被赞 +2    │
└──────────────────────┘
```

### 通知

| type | 说明 |
|------|------|
| `token_tip` | "alice 打赏了你 50 📷 PHOTO" |
| `token_reward` | "发帖获得 10 📷 PHOTO" |
| `token_airdrop` | "收到 photography 小组空投 100 📷 PHOTO" |
| `token_transfer` | "alice 向你转账 200 📷 PHOTO" |

挖矿奖励通知可选择静默（避免刷屏），仅在用户首次获得某 Token 时通知。

### 余额原子操作

复用 GEP-0005 的 CAS 模式：

```sql
-- 扣款
UPDATE token_balance SET balance = balance - ?
WHERE user_id = ? AND token_id = ? AND balance >= ?

-- 加款
INSERT INTO token_balance (id, user_id, token_id, balance, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (user_id, token_id)
DO UPDATE SET balance = balance + ?, updated_at = ?
```

## Security Considerations

- **防双花**：CAS 模式，`WHERE balance >= ?` 确保并发安全
- **Symbol 唯一性**：本站 symbol 全局唯一，远程 Token 用 `symbol@domain` 区分
- **跨站验证**：TokenTip Activity 通过 HTTP 签名验证来源，防止伪造
- **总量控制**：有上限的 Token 在发放前检查剩余可挖矿量，CAS 更新 `mined_total`
- **管理员权限**：只有小组创建者/管理员可以发行和修改 Token
- **防刷**：行为奖励和现有发帖/点赞限制共用，不额外增加刷 Token 渠道
- **远程 Token 信任**：收到远程 Token 仅表示 "站1 某小组发行了这个积分"，本站只做展示和记录，不承诺兑现

## Alternatives Considered

| 方案 | 优点 | 缺点 |
|------|------|------|
| ERC-20 链上代币 | 真正去中心化 | 需要 gas fee、钱包门槛高、慢 |
| Cashu eCash Token (GEP-0007) | 隐私好 | 复杂度高，不适合积分场景 |
| 纯数据库积分（不跨站） | 简单 | 围墙花园，不符合联邦精神 |
| **AP 联邦积分** | 轻量、跨站、零成本 | 不是真正的 "货币"，依赖发行方信用 |

## Open Questions

1. **每组多种 Token** — 第一版限制每组一种，是否有需求发多种？
2. **Token 转让给其他管理员** — 管理员转让小组后 Token 管理权如何迁移？
3. **远程 Token 回流** — 用户在站2 持有的站1 Token，能否转回站1？（可以，通过 AP Activity 反向发送）
4. **Token 过期** — 是否支持 Token 有效期？（第一版不支持）
5. **AP Activity 类型** — 使用自定义 `neogroup:TokenTip` 还是复用 `Offer` + 扩展属性？
6. **与 sats 打赏共存** — UI 上如何同时展示 sats Zap 和 Token 打赏？（建议并排显示）

## Implementation Plan

### Phase 1：Token 发行 + 余额

1. 数据库迁移：`group_token`、`token_balance`、`token_tx` 表
2. 管理员发行 Token（API + Web UI）
3. 空投给现有组员
4. 余额查询

### Phase 2：行为挖矿

1. 发帖/回复/点赞 触发 Token 奖励
2. 供应量检查
3. 小组 Token 信息卡

### Phase 3：打赏 + 转账

1. 帖子/评论 Token 打赏（API + Web UI）
2. 用户间转账
3. Token 排行榜
4. 通知

### Phase 4：跨站流通

1. 自定义 AP Activity `TokenTip`
2. 远程 Token 注册
3. 跨站打赏发送 + 接收
4. 远程 Token 展示

## Verification

1. 管理员发行 Token → 管理员余额 = 留存量 → 组员余额 = 空投量
2. 用户发帖 → 自动获得 Token 奖励 → 余额增加
3. 有上限 Token 挖完后 → 行为奖励停止 → 余额不变
4. 用户 A 打赏用户 B → A 余额减少 → B 余额增加 → 帖子显示打赏
5. 站1 用户打赏站2 帖子 → AP Activity 发送成功 → 站2 用户收到 Token
6. 并发打赏 → CAS 防双花 → 余额正确

## References

- [ActivityPub Extensions](https://www.w3.org/wiki/ActivityPub_extensions) — AP 扩展机制
- [Rally.io](https://rally.io) — 社区代币参考（已关闭，但设计思路有参考价值）
- [Reddit Community Points](https://www.reddit.com/community-points/) — Reddit 社区积分（已停止，但验证了需求）
- [Discourse Badges](https://meta.discourse.org/t/what-are-badges/32540) — 论坛激励机制参考
