import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Database } from '../db'
import { authProviders, groups, groupFollowers, topics } from '../db/schema'
import type { Bindings } from '../types'
import { generateId, stripHtml, truncate } from '../lib/utils'
import { boostToGroupFollowers } from './activitypub'
import { getOrCreateMastodonUser } from './mastodon-sync'

const DEFAULT_STATUS_LIMIT = 10
const DEFAULT_KNOWN_ACCOUNT_LIMIT = 30
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000
const KNOWN_ACCOUNT_CURSOR_KEY = 'mastodon_group_mentions:known_account_offset'

interface MastodonAccount {
  id: string
  username: string
  acct: string
  display_name: string
  avatar: string
  url: string
}

interface MastodonStatus {
  id: string
  uri: string
  url: string
  content: string
  created_at: string
  in_reply_to_id: string | null
  account: MastodonAccount
  mentions: Array<{ acct: string; username: string; url: string }>
}

export interface MastodonGroupMentionPollResult {
  followersChecked: number
  knownAccountsChecked: number
  topicsCreated: number
}

interface LocalGroup {
  id: string
  actorName: string
}

interface PollCandidate {
  actorUri: string
  domain: string
  acct: string
  accountId?: string
  groups: LocalGroup[]
  source: 'follower' | 'known_account'
}

export function parseMastodonActor(actorUri: string): { domain: string; acct: string } | null {
  try {
    const url = new URL(actorUri)
    const parts = url.pathname.split('/').filter(Boolean)
    const username = parts.at(-1)?.replace(/^@/, '')
    if (!username) return null
    return { domain: url.hostname, acct: username }
  } catch {
    return null
  }
}

export function mentionsGroup(status: Pick<MastodonStatus, 'mentions' | 'content'>, actorName: string, host: string): boolean {
  const targetAcct = `${actorName}@${host}`.toLowerCase()
  return status.mentions.some(mention => mention.acct.toLowerCase() === targetAcct)
    || status.content.includes(`@${actorName}@${host}`)
}

export function titleFromStatus(content: string): string {
  const text = stripHtml(content)
    .replace(/^(@[^\s]+\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return truncate(text || 'Fediverse 帖子', 100)
}

async function fetchAccount(domain: string, acct: string): Promise<MastodonAccount | null> {
  const response = await fetch(`https://${domain}/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`)
  if (!response.ok) return null
  return await response.json() as MastodonAccount
}

async function fetchStatuses(domain: string, accountId: string, sinceId: string | null): Promise<MastodonStatus[]> {
  const url = new URL(`https://${domain}/api/v1/accounts/${accountId}/statuses`)
  url.searchParams.set('exclude_reblogs', 'true')
  url.searchParams.set('limit', String(DEFAULT_STATUS_LIMIT))
  if (sinceId) url.searchParams.set('since_id', sinceId)

  const response = await fetch(url.toString())
  if (!response.ok) return []
  return await response.json() as MastodonStatus[]
}

function candidateFromAuthProvider(row: { providerId: string; metadata: string | null }, groupsToCheck: LocalGroup[]): PollCandidate | null {
  if (!row.metadata) return null

  let metadata: Record<string, any>
  try {
    metadata = JSON.parse(row.metadata)
  } catch {
    return null
  }

  const actor = typeof metadata.uri === 'string'
    ? parseMastodonActor(metadata.uri)
    : (typeof metadata.url === 'string' ? parseMastodonActor(metadata.url) : null)

  let domain = actor?.domain || null
  const providerParts = row.providerId.split('@')
  const providerDomain = providerParts.length >= 2 ? providerParts.at(-1) : null
  if (!domain && providerParts.length >= 2) {
    domain = providerDomain || null
  }

  const acct = actor?.acct || metadata.username || metadata.acct?.split('@')[0]
  if (!domain || !acct) return null

  const providerAccountId = providerParts.length >= 2 ? providerParts[0] : undefined
  const accountId = providerDomain === domain
    ? (metadata.id || (/^\d+$/.test(providerAccountId || '') ? providerAccountId : undefined))
    : undefined
  const actorUri = metadata.uri || `https://${domain}/users/${acct}`

  return {
    actorUri,
    domain,
    acct,
    accountId,
    groups: groupsToCheck,
    source: 'known_account',
  }
}

export function remoteStatusIds(status: Pick<MastodonStatus, 'uri' | 'url' | 'id'>): string[] {
  return [status.uri, status.url, status.id].filter(Boolean)
}

async function hasExistingTopic(db: Database, groupId: string, status: MastodonStatus): Promise<boolean> {
  const ids = remoteStatusIds(status)
  const existing = await db
    .select({ id: topics.id })
    .from(topics)
    .where(and(
      eq(topics.groupId, groupId),
      inArray(topics.mastodonStatusId, ids)
    ))
    .limit(1)
  return existing.length > 0
}

export async function pollMastodonGroupMentions(
  env: Bindings,
  db: Database,
): Promise<MastodonGroupMentionPollResult> {
  const baseUrl = env.APP_URL || 'https://neogrp.club'
  const host = new URL(baseUrl).host
  const knownAccountLimit = DEFAULT_KNOWN_ACCOUNT_LIMIT

  const localGroups = await db
    .select({
      id: groups.id,
      actorName: groups.actorName,
    })
    .from(groups)
    .where(isNotNull(groups.actorName))
  const groupsToCheck = localGroups
    .filter((group): group is LocalGroup => !!group.actorName)

  const followerRows = await db
    .select({
      groupId: groupFollowers.groupId,
      actorUri: groupFollowers.actorUri,
      actorName: groups.actorName,
    })
    .from(groupFollowers)
    .innerJoin(groups, eq(groups.id, groupFollowers.groupId))
    .where(isNotNull(groups.actorName))

  const knownOffset = parseInt(await env.KV.get(KNOWN_ACCOUNT_CURSOR_KEY) || '0', 10) || 0
  const knownRows = await db
    .select({
      providerId: authProviders.providerId,
      metadata: authProviders.metadata,
    })
    .from(authProviders)
    .where(eq(authProviders.providerType, 'mastodon'))
    .orderBy(desc(authProviders.createdAt))
    .limit(knownAccountLimit + 1)
    .offset(knownOffset)
  const knownRowsToProcess = knownRows.slice(0, knownAccountLimit)
  await env.KV.put(KNOWN_ACCOUNT_CURSOR_KEY, knownRows.length > knownAccountLimit ? String(knownOffset + knownAccountLimit) : '0')

  const candidates = new Map<string, PollCandidate>()
  for (const follower of followerRows) {
    if (!follower.actorName) continue
    const actor = parseMastodonActor(follower.actorUri)
    if (!actor) continue
    candidates.set(`follower:${follower.groupId}:${follower.actorUri}`, {
      actorUri: follower.actorUri,
      domain: actor.domain,
      acct: actor.acct,
      groups: [{ id: follower.groupId, actorName: follower.actorName }],
      source: 'follower',
    })
  }

  for (const row of knownRowsToProcess) {
    const candidate = candidateFromAuthProvider(row, groupsToCheck)
    if (candidate) candidates.set(`known:${candidate.actorUri}`, candidate)
  }

  let followersChecked = 0
  let knownAccountsChecked = 0
  let topicsCreated = 0

  for (const candidate of candidates.values()) {
    const cursorKey = `mastodon_group_mentions:${candidate.source}:${candidate.actorUri}`
    const sinceId = await env.KV.get(cursorKey)

    try {
      const account = candidate.accountId
        ? null
        : await fetchAccount(candidate.domain, candidate.acct)
      const accountId = candidate.accountId || account?.id
      if (!accountId) continue

      const statuses = await fetchStatuses(candidate.domain, accountId, sinceId)
      if (candidate.source === 'follower') followersChecked++
      else knownAccountsChecked++
      if (statuses.length > 0) {
        await env.KV.put(cursorKey, statuses[0].id)
      }

      for (const status of statuses.reverse()) {
        if (!sinceId && Date.now() - new Date(status.created_at).getTime() > INITIAL_LOOKBACK_MS) continue
        if (status.in_reply_to_id) continue

        for (const group of candidate.groups) {
          if (!mentionsGroup(status, group.actorName, host)) continue
          if (await hasExistingTopic(db, group.id, status)) continue

          const userId = await getOrCreateMastodonUser(db, status.account, candidate.domain)
          const topicId = generateId()
          const createdAt = new Date(status.created_at)

          await db.insert(topics).values({
            id: topicId,
            groupId: group.id,
            userId,
            title: titleFromStatus(status.content),
            content: status.content,
            type: 1,
            mastodonStatusId: status.uri || status.url || status.id,
            mastodonDomain: 'activitypub_origin',
            createdAt,
            updatedAt: createdAt,
          }).onConflictDoNothing()

          const inserted = await db
            .select({ id: topics.id })
            .from(topics)
            .where(eq(topics.id, topicId))
            .limit(1)
          if (inserted.length === 0) continue

          topicsCreated++
          await boostToGroupFollowers(db, group.actorName, status.uri || status.url || status.id, baseUrl)
        }
      }
    } catch (e) {
      console.error(`[Cron] Mastodon group mention poll failed for ${candidate.actorUri}:`, e)
    }
  }

  return { followersChecked, knownAccountsChecked, topicsCreated }
}
