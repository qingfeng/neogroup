# GEP-0002: Actor Tokens for Non-Public Groups (FEP-db0e)

- Status: Draft
- Author: Codex (AI)
- Created: 2026-02-08
- Related Spec: [FEP-db0e](https://codeberg.org/fediverse/fep/src/branch/main/fep/db0e/fep-db0e.md)
- Scope: Private/Semi-private group access control

## Summary
Implement FEP-db0e "actor tokens" to authenticate access to non-public groups. The group actor issues short-lived tokens proving membership; remote servers present the token (plus HTTP signature) when fetching group-owned objects. This keeps private content restricted while posts may reside on member servers.

## Goals
- Enforce access rules for private groups across federated storage.
- Avoid infinite token validity (short TTL, no revocation).
- Remain compatible for public groups (no change).

## Design
- **Token issuer**: Group actor.
- **Endpoint**: `endpoints.sm:actorToken` (GET, signed request) returns token JSON.
- **Token fields**: `issuer`, `actor`, `issuedAt`, `validUntil` (<=2h, default 30m), `signatures[ { algorithm: "rsa-sha256", keyId, signature } ]`.
- **Requesting token**: Remote server signs GET with any of its actors; issuer verifies requester is a member (same domain member exists, or explicit member list) before issuing.
- **Using token**: When fetching protected objects/collections, client includes `Authorization: ActivityPubActorToken <json>` and signs HTTP request with the same actor as `actor` in token.
- **Verification** (resource server):
  1) Verify HTTP signature; actor in token matches signer.
  2) Check times: `issuedAt` < now < `validUntil`, window <= 2h (with clock skew margin).
  3) Verify token signature (sorted source string per FEP-db0e) using issuer public key.
  4) Confirm requested object belongs to a collection owned by `issuer` (e.g., group timelines, posts marked private).
  5) Else 403.
- **Service actor option**: For our own outbound fetches, prefer a server-wide service actor to avoid multi-user key handling.

## Storage & Config
- No DB schema change required for tokens (ephemeral). Need group privacy flag and membership lookup; reuse existing group_member table.
- Config: default token TTL 30m; max 2h; clock skew allowance 5m.

## Compatibility
- Public groups: skip token requirement.
- Unsupported servers: may get 403 on protected resources; federation remains for public content.

## Rollout Plan
1) Mark group privacy levels (public / private / invite-only).
2) Add `sm:actorToken` issuance endpoint + verification middleware for protected fetch.
3) Protect group-owned objects/collections for private groups; add token fetch in outbound fetcher.
4) Metrics & logging; optionally feature-flag token enforcement per group.

## Open Questions
- Exact membership proof for issuing: domain-based or explicit member list? (default: explicit member in group_member with matching domain).
- Should we cache tokens for outbound fetches? (default: no cache > 30m).
- How to expose capability in actor? (add to endpoints only for private groups).
