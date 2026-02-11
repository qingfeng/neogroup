# GEP-0003: Self-Hosted Nostr Relay on Cloudflare

- Status: Draft
- Author: qingfeng
- Created: 2026-02-11
- Target Version: future
- Related: [Nosflare](https://github.com/Spl0itable/nosflare), NIP-01

## Summary

部署一个自建的 Nostr relay，运行在 Cloudflare Workers + D1 上，作为 NeoGroup 的专用事件发布端点。不同步外部数据，只用于发布和存储本站产生的 Nostr 事件。

## Motivation

当前 NeoGroup 依赖公共 relay（damus、nos.lol、nostr.band）发布和轮询事件，存在以下问题：

1. **可用性风险**：公共 relay 可能下线、限流或拒绝特定事件
2. **数据持久性**：公共 relay 可能清理旧事件，本站历史内容可能丢失
3. **延迟**：NIP-72 社区轮询通过公共 relay 中转，增加了延迟
4. **控制权**：无法控制事件的存储策略、访问策略

自建 relay 后，本站产生的所有 Nostr 事件有一份可靠的存储，不依赖第三方。

## Goals

- 本站事件有可靠的自有存储
- 外部 Nostr 客户端可直接连接读取事件
- 与现有公共 relay 并行使用，不替代
- 运行在 Cloudflare 上，无需额外服务器

## Non-Goals

- 不做通用公共 relay（不接收不相关的外部事件）
- 不做 relay 间数据同步
- 不做付费 relay

## Architecture

```
NeoGroup Worker (签名 + Queue)
    ↓ WebSocket
自建 Relay (Cloudflare Workers + Durable Objects + D1)
    ↑ WebSocket
外部 Nostr 客户端 (Damus, Amethyst, etc.)
```

### 组件

| 组件 | 技术 | 说明 |
|------|------|------|
| WebSocket 入口 | Workers | 处理 REQ/EVENT/CLOSE 协议 |
| 连接管理 | Durable Objects | 维持长连接，广播新事件 |
| 事件存储 | D1 | 存储 Nostr 事件，支持按 filter 查询 |
| NIP-11 | Workers | relay 信息文档 |

### 写入策略（仅接受本站事件）

relay 不接受任意外部事件，只接受以下来源：

1. **本站用户的事件**：pubkey 在 `user.nostr_pubkey` 表中存在
2. **本站小组的事件**：pubkey 在 `group.nostr_pubkey` 表中存在

可选：通过共享 secret token 验证写入来源（NeoGroup Worker → relay 时附带 token）。

### 读取策略（完全开放）

任何 Nostr 客户端都可以连接读取，支持标准 NIP-01 filter：

- `ids`: 按 event ID
- `authors`: 按 pubkey
- `kinds`: 按 event kind
- `#e`, `#p`, `#a`: 按 tag
- `since`, `until`, `limit`: 时间范围和分页

## Implementation Plan

### Phase 1: 基于 Nosflare 部署

1. Fork [Nosflare](https://github.com/Spl0itable/nosflare)
2. 修改写入策略：只接受本站 pubkey 或带有效 token 的事件
3. 部署为独立 Worker（如 `relay.neogrp.club`）
4. NIP-11 配置：name、description、contact、supported_nips

### Phase 2: 接入 NeoGroup

1. 将 `relay.neogrp.club` 加入 `NOSTR_RELAYS` 列表（放在第一位）
2. NIP-05 响应中推荐自建 relay
3. Kind 0 metadata 中包含自建 relay 的推荐
4. NIP-72 社区轮询优先从自建 relay 查询

### Phase 3: 优化

1. 事件去重（relay 层面）
2. 存储清理策略（保留多久、保留哪些 kind）
3. 监控和告警（D1 存储量、连接数）
4. 可选：NIP-42 AUTH（限制写入需要认证）

## Cost

| 资源 | 免费额度 | 预计用量 |
|------|---------|---------|
| Workers requests | 10 万/天 | 低（主要是 NeoGroup 发布 + 少量客户端查询） |
| Durable Objects | **需要付费 $5/月** | WebSocket 长连接管理 |
| D1 | 5GB | 取决于事件量，初期远低于上限 |

**注意**：Durable Objects 是 Workers Paid plan 功能，最低 $5/月。这是自建 relay 的唯一硬性成本。如果不需要实时广播（push），可以用纯 Workers + D1 实现 pull 模式的 relay（客户端定期 REQ 查询），避免 Durable Objects 成本。

## Alternatives Considered

| 方案 | 优点 | 缺点 |
|------|------|------|
| 继续只用公共 relay | 零成本 | 数据不可控 |
| VPS 跑 strfry/nostream | 完整功能 | 需要维护服务器 |
| Mac Mini 跑 relay | 自有硬件 | 需要固定 IP、端口映射 |
| **Nosflare (Cloudflare)** | 无服务器、全球分布 | 需要 Paid plan ($5/月) |

## Open Questions

1. 是否需要 Durable Objects？如果只做 pull 模式（NeoGroup 发布、客户端查询），纯 Workers + D1 就够了，可以免费
2. 是否需要独立 D1 数据库？还是复用 NeoGroup 的 D1（加一张 events 表）
3. 域名：`relay.neogrp.club` 还是 `neogrp.club`（同一域名不同路径 `/relay`）
4. 是否开放外部用户写入（带 PoW 要求）

## References

- [Nosflare](https://github.com/Spl0itable/nosflare) — Cloudflare Workers 上的 Nostr relay 实现
- [NIP-01](https://nips.nostr.com/1) — Basic protocol flow
- [NIP-11](https://nips.nostr.com/11) — Relay Information Document
- [NIP-42](https://nips.nostr.com/42) — Authentication of clients to relays
