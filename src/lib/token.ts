import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { groupTokens, tokenBalances, tokenTxs } from '../db/schema'
import type { GroupToken } from '../db/schema'
import { generateId } from './utils'

// ─── Atomic Balance Operations ───

/** Credit (add) tokens to user. UPSERT pattern. */
export async function creditToken(
  db: Database, userId: string, tokenId: string, tokenType: string, amount: number
): Promise<void> {
  const id = generateId()
  const now = Math.floor(Date.now() / 1000)
  await db.run(
    sql`INSERT INTO token_balance (id, user_id, token_id, token_type, balance, updated_at)
        VALUES (${id}, ${userId}, ${tokenId}, ${tokenType}, ${amount}, ${now})
        ON CONFLICT (user_id, token_id, token_type) DO UPDATE
        SET balance = balance + ${amount}, updated_at = ${now}`
  )
}

/** Debit (subtract) tokens from user. CAS pattern. Returns false if insufficient. */
export async function debitToken(
  db: Database, userId: string, tokenId: string, tokenType: string, amount: number
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const result = await db.run(
    sql`UPDATE token_balance SET balance = balance - ${amount}, updated_at = ${now}
        WHERE user_id = ${userId} AND token_id = ${tokenId} AND token_type = ${tokenType} AND balance >= ${amount}`
  )
  return (result.meta?.changes ?? 0) > 0
}

/** Get token balance for a user. */
export async function getTokenBalance(
  db: Database, userId: string, tokenId: string, tokenType: string
): Promise<number> {
  const row = await db
    .select({ balance: tokenBalances.balance })
    .from(tokenBalances)
    .where(
      sql`${tokenBalances.userId} = ${userId} AND ${tokenBalances.tokenId} = ${tokenId} AND ${tokenBalances.tokenType} = ${tokenType}`
    )
    .limit(1)
  return row.length > 0 ? row[0].balance : 0
}

// ─── Transaction Recording ───

/** Record a token transaction. For mining rewards with ref_id, silently skip if dedup unique constraint fails. */
export async function recordTokenTx(db: Database, tx: {
  tokenId: string
  tokenType?: string
  fromUserId?: string | null
  toUserId: string
  amount: number
  type: string
  refId?: string | null
  refType?: string | null
  memo?: string | null
  remoteActorUri?: string | null
}): Promise<string | null> {
  const id = generateId()
  try {
    await db.insert(tokenTxs).values({
      id,
      tokenId: tx.tokenId,
      tokenType: tx.tokenType || 'local',
      fromUserId: tx.fromUserId || null,
      toUserId: tx.toUserId,
      amount: tx.amount,
      type: tx.type,
      refId: tx.refId || null,
      refType: tx.refType || null,
      memo: tx.memo || null,
      remoteActorUri: tx.remoteActorUri || null,
      createdAt: new Date(),
    })
    return id
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) {
      return null
    }
    throw e
  }
}

// ─── Mining Functions ───

/** Calculate effective reward after halving. */
export function getEffectiveReward(baseReward: number, token: GroupToken): number {
  if (token.halvingInterval === 0) return baseReward
  const halvings = Math.floor(token.minedTotal / token.halvingInterval)
  return Math.floor(baseReward * Math.pow(token.halvingRatio / 100, halvings))
}

/** Get actual mine reward amount, considering halving + supply limit. */
export function getMineRewardAmount(token: GroupToken, baseReward: number): number {
  const effective = getEffectiveReward(baseReward, token)
  if (effective === 0) return 0
  // No supply limit
  if (token.totalSupply === 0) return effective
  // Calculate mining pool: total supply minus admin allocation
  const adminAlloc = Math.floor(token.totalSupply * token.adminAllocationPct / 100)
  const available = token.totalSupply - adminAlloc - token.minedTotal
  if (available >= effective) return effective
  return 0
}

/** Check if user has reached daily mining cap. Returns remaining allowance. */
export async function checkDailyCap(
  db: Database, tokenId: string, userId: string, dailyCap: number
): Promise<number> {
  if (dailyCap === 0) return Infinity
  // Start of today in UTC (epoch seconds)
  const now = new Date()
  const startOfDay = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
  )
  const result = await db.all<{ today_total: number }>(
    sql`SELECT COALESCE(SUM(amount), 0) as today_total FROM token_tx
        WHERE token_id = ${tokenId} AND to_user_id = ${userId}
        AND type LIKE 'reward_%' AND created_at >= ${startOfDay}`
  )
  const todayTotal = result.length > 0 ? result[0].today_total : 0
  return dailyCap - todayTotal
}

/** Full mining reward flow. Called via waitUntil(). */
export async function tryMineReward(
  db: Database, groupId: string, userId: string,
  rewardType: 'reward_post' | 'reward_reply' | 'reward_like' | 'reward_liked',
  refId: string
): Promise<void> {
  // 1. Query token for this group
  const tokens = await db
    .select()
    .from(groupTokens)
    .where(eq(groupTokens.groupId, groupId))
    .limit(1)
  if (tokens.length === 0) return
  const token = tokens[0]

  // 2. Get base reward based on type
  let baseReward = 0
  switch (rewardType) {
    case 'reward_post': baseReward = token.rewardPost; break
    case 'reward_reply': baseReward = token.rewardReply; break
    case 'reward_like': baseReward = token.rewardLike; break
    case 'reward_liked': baseReward = token.rewardLiked; break
  }
  if (baseReward === 0) return

  // 3. Calculate effective reward
  const effective = getMineRewardAmount(token, baseReward)
  if (effective === 0) return

  // 4. Check daily cap
  const remaining = await checkDailyCap(db, token.id, userId, token.dailyRewardCap)
  if (remaining < effective) return

  // 5. Credit tokens
  await creditToken(db, userId, token.id, 'local', effective)

  // 6. Record transaction (dedup by ref_id)
  const txId = await recordTokenTx(db, {
    tokenId: token.id,
    tokenType: 'local',
    toUserId: userId,
    amount: effective,
    type: rewardType,
    refId,
    refType: rewardType === 'reward_post' ? 'topic' :
             rewardType === 'reward_reply' ? 'comment' :
             rewardType === 'reward_like' ? 'like_given' : 'like_received',
    memo: null,
  })
  if (txId === null) {
    // Dedup: already rewarded for this ref. Roll back the credit.
    await debitToken(db, userId, token.id, 'local', effective)
    return
  }

  // 7. Update minedTotal with CAS to prevent over-mining
  const updateResult = await db.run(
    sql`UPDATE group_token SET mined_total = mined_total + ${effective}
        WHERE id = ${token.id}
        AND (total_supply = 0
             OR mined_total + ${effective} <= total_supply - CAST(total_supply * admin_allocation_pct / 100 AS INTEGER))`
  )
  if ((updateResult.meta?.changes ?? 0) === 0) {
    console.warn(`[token] Supply exhausted for token ${token.id}, mined_total CAS failed`)
  }
}

// ─── Admin / Utility Functions ───

/** Calculate claimable vesting amount for admin. */
export function getClaimableAmount(token: GroupToken): number {
  const adminTotal = Math.floor(token.totalSupply * token.adminAllocationPct / 100)
  if (token.vestingMonths === 0) return adminTotal - token.adminVestedTotal
  if (!token.vestingStartAt) return 0
  const now = Math.floor(Date.now() / 1000)
  const vestingStartSec = token.vestingStartAt as number
  const monthsElapsed = Math.floor((now - vestingStartSec) / (30 * 86400))
  const vestedSoFar = Math.min(
    Math.floor(adminTotal * monthsElapsed / token.vestingMonths),
    adminTotal
  )
  return Math.max(vestedSoFar - token.adminVestedTotal, 0)
}

/** Get remaining mining pool. */
export function getRemainingPool(token: GroupToken): number {
  if (token.totalSupply === 0) return Infinity
  const adminAlloc = Math.floor(token.totalSupply * token.adminAllocationPct / 100)
  return Math.max(token.totalSupply - adminAlloc - token.minedTotal, 0)
}

/** Auto-airdrop on join. */
export async function airdropOnJoin(db: Database, groupId: string, userId: string): Promise<void> {
  // 1. Query token for this group
  const tokens = await db
    .select()
    .from(groupTokens)
    .where(eq(groupTokens.groupId, groupId))
    .limit(1)
  if (tokens.length === 0) return
  const token = tokens[0]
  if (token.airdropOnJoin !== 1 || token.airdropPerMember === 0) return

  // 2. Check supply
  if (token.totalSupply > 0 && getRemainingPool(token) < token.airdropPerMember) return

  // 3. Credit tokens
  await creditToken(db, userId, token.id, 'local', token.airdropPerMember)

  // 4. Record transaction (dedup by group_join ref)
  const txId = await recordTokenTx(db, {
    tokenId: token.id,
    tokenType: 'local',
    toUserId: userId,
    amount: token.airdropPerMember,
    type: 'airdrop',
    refId: groupId,
    refType: 'group_join',
    memo: null,
  })
  if (txId === null) {
    // Already airdropped to this user for this group, roll back
    await debitToken(db, userId, token.id, 'local', token.airdropPerMember)
    return
  }

  // 5. Update minedTotal with CAS
  await db.run(
    sql`UPDATE group_token SET mined_total = mined_total + ${token.airdropPerMember}
        WHERE id = ${token.id}
        AND (total_supply = 0
             OR mined_total + ${token.airdropPerMember} <= total_supply - CAST(total_supply * admin_allocation_pct / 100 AS INTEGER))`
  )
}
