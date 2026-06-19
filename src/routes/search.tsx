import { Hono } from 'hono'
import { desc, eq, sql } from 'drizzle-orm'
import type { AppContext } from '../types'
import { groups, topics, users } from '../db/schema'
import { Layout } from '../components/Layout'
import { TopicCard } from '../components/TopicCard'
import { normalizeSearchQuery, toSearchLikePattern } from '../lib/search'
import { normalizeSiteUrl } from '../lib/seo'

const search = new Hono<AppContext>()

search.get('/search', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const query = normalizeSearchQuery(c.req.query('q'))
  const pattern = toSearchLikePattern(query)
  const escapeChar = '\\'
  const appName = c.env.APP_NAME || 'NeoGroup'
  const baseUrl = normalizeSiteUrl(c.env.APP_URL || new URL(c.req.url).origin)

  const results = pattern ? await db
    .select({
      id: topics.id,
      groupId: topics.groupId,
      userId: topics.userId,
      title: topics.title,
      content: topics.content,
      type: topics.type,
      images: topics.images,
      mastodonStatusId: topics.mastodonStatusId,
      mastodonDomain: topics.mastodonDomain,
      mastodonSyncedAt: topics.mastodonSyncedAt,
      nostrEventId: topics.nostrEventId,
      nostrAuthorPubkey: topics.nostrAuthorPubkey,
      createdAt: topics.createdAt,
      updatedAt: topics.updatedAt,
      replyCount: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = ${topics.id})`.as('reply_count'),
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        bio: users.bio,
        role: users.role,
        apPublicKey: users.apPublicKey,
        apPrivateKey: users.apPrivateKey,
        nostrPubkey: users.nostrPubkey,
        nostrPrivEncrypted: users.nostrPrivEncrypted,
        nostrPrivIv: users.nostrPrivIv,
        nostrKeyVersion: users.nostrKeyVersion,
        nostrSyncEnabled: users.nostrSyncEnabled,
        balanceSats: users.balanceSats,
        lightningAddress: users.lightningAddress,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      },
      group: {
        id: groups.id,
        creatorId: groups.creatorId,
        name: groups.name,
        actorName: groups.actorName,
        description: groups.description,
        tags: groups.tags,
        iconUrl: groups.iconUrl,
        apPublicKey: groups.apPublicKey,
        apPrivateKey: groups.apPrivateKey,
        nostrPubkey: groups.nostrPubkey,
        nostrPrivEncrypted: groups.nostrPrivEncrypted,
        nostrPrivIv: groups.nostrPrivIv,
        nostrSyncEnabled: groups.nostrSyncEnabled,
        nostrCommunityEventId: groups.nostrCommunityEventId,
        nostrLastPollAt: groups.nostrLastPollAt,
        createdAt: groups.createdAt,
        updatedAt: groups.updatedAt,
      },
    })
    .from(topics)
    .innerJoin(users, eq(topics.userId, users.id))
    .leftJoin(groups, eq(topics.groupId, groups.id))
    .where(sql`(${topics.title} LIKE ${pattern} ESCAPE ${escapeChar} OR COALESCE(${topics.content}, '') LIKE ${pattern} ESCAPE ${escapeChar})`)
    .orderBy(desc(topics.updatedAt))
    .limit(50) : []

  return c.html(
    <Layout
      user={user}
      title={query ? `搜索：${query}` : '站内搜索'}
      description={`搜索 ${appName} 的小组话题和讨论内容`}
      url={`${baseUrl}/search`}
      robots="noindex, follow"
      unreadCount={c.get('unreadNotificationCount')}
      siteName={appName}
    >
      <section class="search-page">
        <h1>站内搜索</h1>
        <form action="/search" method="get" class="search-page-form">
          <input
            type="search"
            name="q"
            value={query}
            placeholder="搜索话题标题或正文"
            aria-label="搜索话题标题或正文"
            autofocus
          />
          <button type="submit" class="btn btn-primary">搜索</button>
        </form>

        {query ? (
          <>
            <p class="search-summary">找到 {results.length} 条与「{query}」相关的话题</p>
            {results.length > 0 ? (
              <div class="search-results">
                {results.map((topic) => <TopicCard topic={topic as any} />)}
              </div>
            ) : (
              <p class="card">没有找到相关话题，换个关键词试试。</p>
            )}
          </>
        ) : (
          <p class="card">输入关键词搜索站内话题。</p>
        )}
      </section>
    </Layout>
  )
})

export default search
