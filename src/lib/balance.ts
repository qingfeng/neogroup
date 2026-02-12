import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { users, ledgerEntries } from '../db/schema'
import { generateId } from './utils'

// ─── Atomic primitives ───

/** Debit (subtract) sats from user. Returns false if insufficient balance (CAS). */
export async function debitBalance(db: Database, userId: string, amountSats: number): Promise<boolean> {
  const result = await db.run(
    sql`UPDATE "user" SET balance_sats = balance_sats - ${amountSats} WHERE id = ${userId} AND balance_sats >= ${amountSats}`
  )
  return (result.meta?.changes ?? 0) > 0
}

/** Credit (add) sats to user. */
export async function creditBalance(db: Database, userId: string, amountSats: number): Promise<void> {
  await db.run(
    sql`UPDATE "user" SET balance_sats = balance_sats + ${amountSats} WHERE id = ${userId}`
  )
}

/** Get current balance. */
export async function getBalance(db: Database, userId: string): Promise<number> {
  const row = await db.select({ balanceSats: users.balanceSats }).from(users).where(eq(users.id, userId)).limit(1)
  return row.length > 0 ? row[0].balanceSats : 0
}

/** Record a ledger entry. */
export async function recordLedger(db: Database, entry: {
  userId: string
  type: string
  amountSats: number
  balanceAfter: number
  refId?: string | null
  refType?: string | null
  memo?: string | null
}): Promise<void> {
  await db.insert(ledgerEntries).values({
    id: generateId(),
    userId: entry.userId,
    type: entry.type,
    amountSats: entry.amountSats,
    balanceAfter: entry.balanceAfter,
    refId: entry.refId || null,
    refType: entry.refType || null,
    memo: entry.memo || null,
    createdAt: new Date(),
  })
}

// ─── Composite operations ───

/** Freeze escrow: debit customer + ledger. Returns false if insufficient balance. */
export async function escrowFreeze(db: Database, userId: string, sats: number, jobId: string): Promise<boolean> {
  const ok = await debitBalance(db, userId, sats)
  if (!ok) return false
  const balance = await getBalance(db, userId)
  await recordLedger(db, {
    userId,
    type: 'escrow_freeze',
    amountSats: -sats,
    balanceAfter: balance,
    refId: jobId,
    refType: 'dvm_job',
    memo: `Escrow freeze for job ${jobId}`,
  })
  return true
}

/** Release escrow: credit provider + two ledger entries (customer release + provider payment). */
export async function escrowRelease(
  db: Database,
  customerUserId: string,
  providerUserId: string,
  sats: number,
  jobId: string,
): Promise<void> {
  // Credit provider
  await creditBalance(db, providerUserId, sats)

  // Customer ledger: escrow_release (informational, balance unchanged since already frozen)
  const customerBalance = await getBalance(db, customerUserId)
  await recordLedger(db, {
    userId: customerUserId,
    type: 'escrow_release',
    amountSats: 0, // balance already deducted at freeze
    balanceAfter: customerBalance,
    refId: jobId,
    refType: 'dvm_job',
    memo: `Escrow released for job ${jobId}`,
  })

  // Provider ledger: job_payment
  const providerBalance = await getBalance(db, providerUserId)
  await recordLedger(db, {
    userId: providerUserId,
    type: 'job_payment',
    amountSats: sats,
    balanceAfter: providerBalance,
    refId: jobId,
    refType: 'dvm_job',
    memo: `Payment for job ${jobId}`,
  })
}

/** Refund escrow: credit customer + ledger. */
export async function escrowRefund(db: Database, userId: string, sats: number, jobId: string): Promise<void> {
  await creditBalance(db, userId, sats)
  const balance = await getBalance(db, userId)
  await recordLedger(db, {
    userId,
    type: 'escrow_refund',
    amountSats: sats,
    balanceAfter: balance,
    refId: jobId,
    refType: 'dvm_job',
    memo: `Escrow refund for job ${jobId}`,
  })
}

/** Transfer sats between users. Returns false if sender has insufficient balance. */
export async function transfer(
  db: Database,
  fromId: string,
  toId: string,
  sats: number,
  memo?: string,
): Promise<boolean> {
  const ok = await debitBalance(db, fromId, sats)
  if (!ok) return false

  await creditBalance(db, toId, sats)

  const fromBalance = await getBalance(db, fromId)
  const toBalance = await getBalance(db, toId)
  const transferId = generateId()

  await recordLedger(db, {
    userId: fromId,
    type: 'transfer_out',
    amountSats: -sats,
    balanceAfter: fromBalance,
    refId: transferId,
    refType: 'transfer',
    memo: memo || null,
  })

  await recordLedger(db, {
    userId: toId,
    type: 'transfer_in',
    amountSats: sats,
    balanceAfter: toBalance,
    refId: transferId,
    refType: 'transfer',
    memo: memo || null,
  })

  return true
}
