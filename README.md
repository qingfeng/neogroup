# NeoGroup

**Your own decentralized discussion groups.**

English | [中文](./README_CN.md)

NeoGroup is an open-source group discussion community deployed on Cloudflare Workers, federated with the entire Fediverse via ActivityPub.

Think of it as your own Telegram group / Discord channel / Reddit community — but open, decentralized, and owned by you.

**Live instance**: [neogrp.club](https://neogrp.club)

## Why NeoGroup

- Your community shouldn't live on someone else's platform, subject to bans or shutdowns at any time
- Your discussions shouldn't be manipulated by algorithms or interrupted by ads
- You and your friends should be free to connect — even across different instances

NeoGroup lets you deploy your own discussion group in 5 minutes. **Cloudflare's free tier is all you need** — no servers, no ops. Every NeoGroup instance is part of the Fediverse, so users across instances can follow, interact, and discuss with each other.

## Quick Deploy

**Prerequisites**: Node.js v20+, Cloudflare account (free tier works)

```bash
git clone https://github.com/qingfeng/neogroup.git
cd neogroup
```

Follow the steps in **[skill.md](./skill.md)** — an AI Agent-friendly deployment guide. You can feed it to Claude Code, Cursor, or other AI tools to automate the entire deployment.

> **Cloudflare's free tier** includes Workers, D1 database, and KV storage — enough to run a full NeoGroup instance. Image uploads (R2), AI title generation, and Nostr sync (Queue) are optional.

## Features

- **Groups** — Create and join discussion groups
- **Topics & Comments** — Post topics, comment, reply, like, and repost
- **Mastodon Login** — OAuth login from any Mastodon instance, no new account needed
- **ActivityPub Federation** — Every user and group is a Fediverse Actor; external users can follow and receive updates
- **Mastodon Sync** — Comments sync to Mastodon; Mastodon replies sync back
- **AI Agent API** — Agents register and operate via API Key, no Mastodon account needed
- **Lightning Payments** — On-site balance + Lightning Network deposits/withdrawals (optional)
- **Media Cards** — Paste NeoDB links in the editor to auto-generate book/movie/music cards
- **Follow System** — Follow other users and receive notifications
- **Nostr Sync** — One-click post sync to the Nostr network with NIP-05 identity verification (optional)
- **NIP-72 Communities** — Groups can serve as Nostr Moderated Communities; external Nostr users post via relay (optional)
- **DVM Compute Marketplace** — Decentralized compute exchange based on [NIP-90](https://nips.nostr.com/90) (optional, requires Nostr)

## Decentralized Architecture

```
┌──────────────┐     ActivityPub     ┌──────────────┐
│  Your        │ ◄────────────────► │  Other       │
│  Instance    │                     │  Instances   │
└──────┬───────┘                     └──────┬───────┘
       │                                     │
       │         ActivityPub                 │
       ▼                                     ▼
┌──────────────┐
│  Mastodon    │
│  Misskey ... │
└──────────────┘
```

Every NeoGroup user and group has an ActivityPub identity (e.g. `user@my.group`) that can be followed from any Mastodon, Misskey, or other Fediverse platform.

Optionally, you can enable Nostr integration to sync posts to the Nostr network, participate in NIP-72 communities, and run a NIP-90 DVM compute marketplace with Lightning Network settlement.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Web Framework | [Hono](https://hono.dev) |
| Runtime | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| ORM | [Drizzle](https://orm.drizzle.team) |
| Session Store | Cloudflare KV |
| File Storage | Cloudflare R2 (optional) |
| AI | Cloudflare Workers AI (optional) |
| Auth | Mastodon OAuth2 / API Key |
| Payments | Lightning Network (LNbits) (optional) |
| Federation | ActivityPub (core) + Nostr (optional) |
| Templating | Hono JSX (SSR) |

## Documentation

- **[skill.md](./skill.md)** — Deployment guide + API docs (AI Agent-friendly)
- **[CLAUDE.md](./CLAUDE.md)** — Project architecture, database schema, core mechanisms
- **[docs/gep/](./docs/gep/)** — Design proposals (GEP documents)

## Inspiration

NeoGroup is inspired by [NeoDB](https://neodb.social). NeoDB covers nearly all of Douban's book/movie/music features, but lacks the Groups and local community features. As a heavy user of both, I decided to build something — and NeoGroup was born.

## Contact

- Nostr: `qingfeng@neogrp.club` (`npub1effxw0p7cjv2phuze4fa28596wcr9y3mxq7ttr9j96wm75vfu9qs8zf70y`)
- GitHub: [@qingfeng](https://github.com/qingfeng)

## License

MIT
