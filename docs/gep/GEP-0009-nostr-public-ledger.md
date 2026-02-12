# GEP-0009: Nostr-Native Public Ledger（可验证账本）

- Status: Draft
- Author: qingfeng
- Created: 2026-02-12
- Target Version: future
- Depends: GEP-0005 (Lightning), GEP-0008 (DVM)
- Related: NIP-32 (Labels), NIP-33 (Parameterized Replaceable Events), Nostr Event Signing

## Summary

将站内每一笔余额变动（空投、转账、escrow、充值、提现）发布为 Nostr 签名事件，让 Relay 上的事件链成为**可公开审计的真账本**，数据库降级为**只读缓存**。

任何人都可以从 Relay 重放事件，独立计算每个账户的余额，验证平台数据库是否造假。

## Motivation

当前 GEP-0005 实现的余额系统是纯中心化账本：

| 问题 | 说明 |
|------|------|
| **管理员可篡改** | `UPDATE user SET balance_sats = 999999` 即可凭空造钱，无审计痕迹 |
| **不可验证** | 外部用户无法验证平台的余额声明是否真实 |
| **不透明** | 所有交易记录只在 D1 中，用户只能信任平台 |
| **无不可抵赖性** | DB 记录可以被修改或删除，没有密码学证据 |

这不符合 Nostr 生态的去中心化精神——我们已经有了密钥、签名、Relay 发布的全套基础设施，不用白不用。

## Goals

- 每笔余额变动附带 Nostr 签名事件，发布到公共 Relay
- 外部验证器可从 Relay 重放事件，独立计算余额
- 对现有 API 零破坏，用户体感不变（速度不变、接口不变）
- 实现成本低：复用现有 Nostr 签名 + Queue + Relay 基础设施

## Non-Goals

- 不替换数据库（DB 仍是运行时状态源，用于 CAS 防双花）
- 不要求用户自管私钥（现阶段密钥仍由平台托管，但事件链为未来自管钥升级铺路）
- 不做链上结算（仍是 Lightning + 站内账本）
- 不做实时共识（不是区块链，Relay 只做存证）

## Design

### 核心原则

```
DB = 运行时状态机（快、原子、防双花）
Nostr Events = 不可变审计日志（慢、可验证、公开透明）
```

每次 balance 操作：
1. 先在 DB 执行原子操作（CAS debit/credit）— 这保证了速度和一致性
2. 再签名 Nostr event 并入 Queue — 异步发布到 Relay，不阻塞主流程
3. 事件包含足够信息让外部验证器可重建完整账本

### 事件 Kind 定义

使用自定义 **Regular Event Kind 1112**（`NeoGroup Ledger Entry`）。

> **为什么不用 Parameterized Replaceable Event (Kind 30000-39999)?**
>
> Replaceable Event 的定义是 Relay 只保留最新版本。这对账本是致命的——管理员可以发布一个同 `d` tag 的新事件覆盖旧记录，篡改历史。Regular Event 是 **append-only**（不可替换），一旦发到 Relay 就永久存在，这正是审计账本需要的不可变性。
>
> **防重复投递**：Queue 重试可能导致同一事件被多次发布。由于 Nostr event ID 是内容的 SHA-256 hash，完全相同的事件会产生相同的 ID，Relay 自动去重。验证器额外按 `d` tag（ledger_entry_id）去重，取 `created_at` 最早的事件，忽略重复。

### 事件结构

```json
{
  "kind": 1112,
  "pubkey": "<签名者公钥>",
  "created_at": 1234567890,
  "content": "<明文 memo>",
  "tags": [
    ["d", "<ledger_entry_id>"],
    ["t", "escrow_freeze"],
    ["amount", "-100"],
    ["balance", "900"],
    ["p", "<涉及的对手方 pubkey>", "", "counterparty"],
    ["e", "<关联的 DVM job event_id>", "", "ref"],
    ["e", "<上一笔系统事件 ID>", "", "prev"],
    ["L", "neogroup.ledger"],
    ["l", "escrow_freeze", "neogroup.ledger"]
  ],
  "id": "<sha256>",
  "sig": "<schnorr signature>"
}
```

### Tag 说明

| Tag | 含义 | 示例 |
|-----|------|------|
| `d` | 交易唯一 ID（= ledger_entry.id） | `"1ViqllY1EKYV"` |
| `t` | 交易类型 | `"escrow_freeze"` / `"transfer_out"` / `"airdrop"` |
| `amount` | 金额变动（正=收入，负=支出） | `"-100"` / `"50"` |
| `balance` | 操作后余额快照 | `"900"` |
| `p` | 对手方公钥（转账/escrow 场景） | 接收方或发送方的 pubkey |
| `e` + `ref` | 关联事件 ID（DVM job event 等） | job 的 nostr event_id |
| `e` + `prev` | 上一笔系统签名事件 ID（链式审计） | 见下文「事件链」 |
| `L` | Label namespace（NIP-32） | `"neogroup.ledger"` |
| `l` | Label value（方便 Relay 过滤） | 交易类型 |

### 事件链（Hash Chain）

为防止管理员删除中间交易，系统密钥签名的事件通过 `["e", "<prev_event_id>", "", "prev"]` tag 形成**默克尔链**：

```
[airdrop #1] → [deposit #2] → [escrow_release #3] → [airdrop #4] → ...
     ↑              ↑                  ↑                   ↑
  genesis      prev=#1             prev=#2              prev=#3
```

- **系统密钥签名的事件**（airdrop, deposit, escrow_release, escrow_refund, transfer_in）**强制包含 `prev` tag**，形成严格链式结构
- **用户密钥签名的事件**（transfer_out, escrow_freeze, withdraw）**不要求 `prev` tag**，避免高并发时的竞争条件
- 如果链条中间缺少一个事件，后续事件的 `prev` 指向一个不存在的 ID → 验证器立刻检测到断裂

这确保了系统"印钞"环节（airdrop、deposit）的完整性——管理员无法悄悄插入或删除一笔系统操作。

### DB 辅助字段

`ledger_entry` 表新增：

```sql
ALTER TABLE ledger_entry ADD COLUMN nostr_event_id TEXT;
```

系统维护一个 KV 键 `ledger_prev_system_event_id`，存储最新一笔系统签名事件的 ID，用于构建链。

### 谁签名什么

| 操作 | 签名者 | 链式（prev） | 说明 |
|------|--------|:---:|------|
| `airdrop` | 系统密钥 | Yes | 管理员操作，用平台密钥签 |
| `deposit` | 系统密钥 | Yes | Lightning 充值到账，平台确认 |
| `escrow_release` | 系统密钥 | Yes | 系统结算，用平台密钥签 |
| `escrow_refund` | 系统密钥 | Yes | 系统退款，用平台密钥签 |
| `transfer_in` | 系统密钥 | Yes | 系统确认收款方到账 |
| `transfer_out` | 发送方用户密钥 | No | 用户发起转账 |
| `escrow_freeze` | 用户密钥 | No | 用户发布任务冻结资金 |
| `withdraw` | 用户密钥 | No | 用户发起提现 |

> **诚实声明**：当前用户密钥由平台托管（`nostr_priv_encrypted`），平台理论上可以代签用户事件。但事件链本身仍有价值——任何 DB 篡改都会与 Relay 上的事件链产生不一致，可被外部检测。未来用户自管密钥后（NWC / NIP-46 Remote Signing），不可抵赖性将完全成立。

### 系统密钥

平台需要一个 **系统级 Nostr 身份**（System Keypair），用于签署平台发起的操作：

```
# wrangler secret put SYSTEM_NOSTR_PUBKEY
# wrangler secret put SYSTEM_NOSTR_PRIV_ENCRYPTED
# wrangler secret put SYSTEM_NOSTR_PRIV_IV
```

系统身份对应一个 NIP-05：`system@neogrp.club`，其公钥公开可查。

### 数据流

```
用户请求 POST /api/transfer
  ↓
① DB: CAS debit sender (原子操作，防双花)
  ↓ 成功？
② DB: credit receiver + insert ledger_entry (×2)
  ↓
③ 签名 Kind 1112 event (sender key → transfer_out)
④ 签名 Kind 1112 event (system key → transfer_in, with prev tag)
  ↓
⑤ Queue.send([event1, event2]) → Consumer → Relay
  ↓
⑥ 回写 nostr_event_id 到 ledger_entry
  ↓
⑦ 返回 API 响应 { ok: true }
```

步骤 ③-⑥ 在 `waitUntil` 中异步执行，不影响 API 延迟。即使 Relay 暂时不可达，Queue 会自动重试（最多 5 次）。

### 验证流程

外部验证器（任何人都可以运行）：

```
1. 连接 Relay，订阅 Kind 1112 + filter L="neogroup.ledger"
2. 验证每个事件的签名（schnorr verify）
3. 按 d tag 去重（同一 ledger_entry_id 取最早的 created_at）
4. 验证系统事件的 prev 链完整性（无断裂、无分叉）
5. 按 created_at 排序，逐条重放：
   - airdrop: system 签名 → 目标用户 balance += amount
   - transfer_out: 用户签名 → 用户 balance -= amount
   - transfer_in: system 签名 → 用户 balance += amount
   - escrow_freeze: 用户签名 → 用户 balance -= amount
   - escrow_release: system 签名 → provider balance += amount
   - escrow_refund: system 签名 → 用户 balance += amount
   - deposit: system 签名 → 用户 balance += amount
   - withdraw: 用户签名 → 用户 balance -= amount
6. 最终余额 vs 平台 API GET /api/balance → 一致则平台诚实
7. 报告：链完整性 ✓/✗，余额匹配 ✓/✗，异常事件列表
```

### 隐私策略

**默认全公开**。这是 "Public Ledger" 的核心价值。

- 金额（`amount`）、余额（`balance`）、交易类型（`t`）均为明文
- `content` 字段存放 memo（明文）
- 对手方通过 `p` tag 公开

如果用户需要隐私交易，应使用 **GEP-0007 (Cashu eCash)**——Cashu 是隐私层，Lightning Ledger 是结算层，结算层理应公开透明。两者互补，不冲突。

## Implementation Plan

### Phase 1: 事件发布（核心）

1. 生成系统 Nostr 密钥对，配置为 Worker Secret
2. 添加 `/.well-known/nostr.json` 中的 `system` 映射
3. `ledger_entry` 表新增 `nostr_event_id` 字段（迁移 `0027_ledger_event.sql`）
4. `src/services/nostr.ts` — 新增 `buildLedgerEvent()` 辅助函数
5. `src/lib/balance.ts` — 每个 composite 函数增加签名 + Queue 入队逻辑（通过可选 `env` 参数）
6. API 端点（airdrop, transfer, deposit webhook, withdraw）传入 env
7. KV 维护 `ledger_prev_system_event_id` 用于链式签名

### Phase 2: 历史回填

8. `scripts/backfill-ledger-events.ts` — 迁移脚本：读取 DB 中所有已有 ledger_entry，按 created_at 排序，逐条签名发布到 Relay，补全事件链。否则验证器的初始余额对不上

### Phase 3: 查询接口

9. `GET /api/ledger` 响应中增加 `nostr_event_id` 字段
10. `GET /api/ledger/:id/event` — 返回指定 ledger entry 的 Nostr 事件 JSON
11. DVM 市场页面展示交易的 Nostr 事件链接（可在 nostr.band 等浏览器查看）

### Phase 4: 验证工具

12. `scripts/verify-ledger.ts` — 命令行验证脚本：连接 Relay → 拉取所有 Kind 1112 → 验签 → 验链 → 重放计算 → 对比 API 余额
13. 可选：`/api/audit` 公开端点，返回验证摘要（总交易数、链完整性、最新事件时间等）

### Phase 5: 未来升级路径

14. 支持外部签名器（用户持有自己私钥，通过 NIP-46 Remote Signing 签署转账事件）
15. 此时用户签名的事件具有完全不可抵赖性

## 关键文件

| 文件 | 操作 |
|------|------|
| `src/lib/balance.ts` | 修改：每个操作增加签名 + Queue |
| `src/services/nostr.ts` | 修改：增加 `buildLedgerEvent()` 辅助函数 |
| `drizzle/0027_ledger_event.sql` | 新建：ledger_entry 加 nostr_event_id |
| `src/routes/api.ts` | 修改：传 env 给 balance 函数 |
| `scripts/backfill-ledger-events.ts` | 新建：历史回填脚本 |
| `scripts/verify-ledger.ts` | 新建：验证脚本 |

## 复用

- `buildSignedEvent()` — 已有的 Nostr 签名函数
- `NOSTR_QUEUE` — 已有的 Cloudflare Queue binding
- Queue Consumer — 已有的 WebSocket → Relay 发布
- `generateId()` — ledger entry ID 生成
- KV — 已有的 Cloudflare KV binding（存 prev_event_id）

## Trade-offs

| 方面 | 决策 | 理由 |
|------|------|------|
| DB vs Event 谁是权威 | DB 是运行时权威，Event 是审计权威 | CAS 防双花必须在 DB 层面，Relay 无法保证事件顺序 |
| 隐私 vs 透明 | **全公开**，不提供隐私开关 | 透明是 Public Ledger 核心价值；隐私需求走 GEP-0007 Cashu |
| 用户密钥托管 | 接受现状，未来可升级 | 事件链的审计价值不依赖于密钥自管；自管密钥是锦上添花 |
| Kind 选择 | **1112（Regular Event）** | Regular Event 不可替换（append-only），防止历史篡改 |
| 链式结构 | 系统事件强制 prev，用户事件不强制 | 保证"印钞"环节链式完整，避免用户事件高并发竞争 |
| 同步 vs 异步 | 签名同步，发布异步（Queue） | 不增加 API 延迟，Queue 保证最终送达 |

## Security Considerations

- **Relay 可用性**：Relay 宕机不影响业务（DB 是主状态源），Queue 自动重试。建议发布到多个 Relay 增强持久性
- **事件伪造**：需要私钥才能签名，外部无法伪造
- **重放攻击**：Nostr event ID = 内容 SHA-256，Relay 自动去重；验证器按 `d` tag 再去重
- **历史篡改**：Regular Event 不可覆盖；系统事件 prev 链使删除可检测；多 Relay 发布增加篡改成本
- **余额溢出**：DB 层 CAS 已防护，Event 层是旁路审计，不参与余额计算
- **密钥泄露**：系统密钥泄露可伪造 airdrop 事件，但无法实际增加 DB 余额（需 DB 写权限）。两者同时泄露才构成真实威胁
- **prev 链竞争**：高并发下多个系统操作可能同时读到相同的 `prev_event_id`。解决方案：KV 写入使用 `put` 覆盖语义，接受短暂分叉，验证器识别并报警
