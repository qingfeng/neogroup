# GEP-0001: Support FEP-76ea Conversation Threads

- Status: Draft
- Author: Codex (AI)
- Created: 2026-02-08
- Target Version: next release
- Related Spec: [FEP-76ea](https://codeberg.org/fediverse/fep/src/branch/main/fep/76ea/fep-76ea.md)

## Summary
Add first-class support for ActivityPub conversation threads per FEP‑76ea. Each topic exposes an authoritative thread collection; comments reference it via `thr:thread`. New replies send `Add` updates; deletions send `Remove`. Keep `inReplyTo` for Mastodon compatibility.

## Goals
- Provide an authoritative, fetchable thread collection for each topic.
- Reduce missed replies and heavy `inReplyTo` crawling.
- Maintain compatibility with implementations that ignore `thr:thread` (e.g., Mastodon).

## Scope
- ActivityPub representations of topics/comments.
- Thread collection endpoint + `Add` / `Remove` delivery.
- No UI changes required initially.

## Design
- **Thread ID**: `https://neogrp.club/ap/threads/:topicId` (OrderedCollection, newest-first).
- **Outbound comment Create** includes:
  - `thr:thread`: thread URL
  - `inReplyTo`: existing target (topic or parent comment) for compatibility.
- **Delivery**:
  - On new comment: actor sends `Add` with `object` = comment, `target` = thread.
  - On delete: send `Remove` with same target.
- **Thread fetch**: `GET /ap/threads/:topicId` returns OrderedCollection of comment URLs (or embedded objects), reverse chronological.
- **Namespace**: add `thr` context per FEP‑76ea.

## Compat & Fallback
- Mastodon and other non-supporting instances ignore `thr:thread` but still use `inReplyTo`.
- If `Add/Remove` causes remote errors, fall back to existing follower delivery only; keep `thr:thread` set.

## Security / Abuse
- Only thread owner (topic author/server) may emit `Add/Remove` for that thread.
- Rate-limit external fetches of thread collections; reject oversized `target` references.

## Migration
- None. Thread collections are derived from existing comments.

## Phased Rollout
1. Read-only thread endpoint + include `thr:thread` in outbound comments.
2. Emit `Add` on new comments; log delivery failures.
3. Emit `Remove` on deletions; add metrics.
4. Optional: cache thread collection for faster fetches.

## Open Questions
- Embed objects vs URLs in OrderedCollection? (default: URLs)
- Should group actor own the thread when topic is group-owned? (default: topic author)
