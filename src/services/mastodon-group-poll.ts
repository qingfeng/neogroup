import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Database } from '../db'
import { groups, groupFollowers, topics } from '../db/schema'
import type { Bindings } from '../types'
import { generateId, stripHtml, truncate } from '../lib/utils'
import { boostToGroupFollowers } from './activitypub'
import { getOrCreateMastodonUser } from './mastodon-sync'

const DEFAULT_STATUS_LIMIT = 10
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000

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
  topicsCreated: number
}

export function parseMastodonActor(actorUri: string): { domain: string; acct: string } | null {
  try {
    const url = new URL(actorUri)
    const parts = url.pathname.split('/').filter(Boolean)
    const username = parts.at(-1)
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

async function hasExistingTopic(db: Database, status: MastodonStatus): Promise<boolean> {
  const ids = [status.uri, status.url, status.id].filter(Boolean)
  const existing = await db
    .select({ id: topics.id })
    .from(topics)
    .where(inArray(topics.mastodonStatusId, ids))
    .limit(1)
  return existing.length > 0
}

export async function pollMastodonGroupMentions(
  env: Bindings,
  db: Database,
): Promise<MastodonGroupMentionPollResult> {
  const baseUrl = env.APP_URL || 'https://neogrp.club'
  const host = new URL(baseUrl).host

  const followers = await db
    .select({
      groupId: groupFollowers.groupId,
      actorUri: groupFollowers.actorUri,
      actorName: groups.actorName,
    })
    .from(groupFollowers)
    .innerJoin(groups, eq(groups.id, groupFollowers.groupId))
    .where(isNotNull(groups.actorName))

  let followersChecked = 0
  let topicsCreated = 0

  for (const follower of followers) {
    if (!follower.actorName) continue

    const actor = parseMastodonActor(follower.actorUri)
    if (!actor) continue

    const cursorKey = `mastodon_group_mentions:${follower.groupId}:${follower.actorUri}`
    const sinceId = await env.KV.get(cursorKey)

    try {
      const account = await fetchAccount(actor.domain, actor.acct)
      if (!account) continue

      const statuses = await fetchStatuses(actor.domain, account.id, sinceId)
      followersChecked++
      if (statuses.length > 0) {
        await env.KV.put(cursorKey, statuses[0].id)
      }

      for (const status of statuses.reverse()) {
        if (!sinceId && Date.now() - new Date(status.created_at).getTime() > INITIAL_LOOKBACK_MS) continue
        if (status.in_reply_to_id) continue
        if (!mentionsGroup(status, follower.actorName, host)) continue
        if (await hasExistingTopic(db, status)) continue

        const userId = await getOrCreateMastodonUser(db, status.account, actor.domain)
        const topicId = generateId()
        const createdAt = new Date(status.created_at)

        await db.insert(topics).values({
          id: topicId,
          groupId: follower.groupId,
          userId,
          title: titleFromStatus(status.content),
          content: status.content,
          type: 1,
          mastodonStatusId: status.uri || status.url || status.id,
          mastodonDomain: 'activitypub_origin',
          createdAt,
          updatedAt: createdAt,
        })

        topicsCreated++
        await boostToGroupFollowers(db, follower.actorName, status.uri || status.url || status.id, baseUrl)
      }
    } catch (e) {
      console.error(`[Cron] Mastodon group mention poll failed for ${follower.actorUri}:`, e)
    }
  }

  return { followersChecked, topicsCreated }
}
