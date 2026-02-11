import { Hono } from 'hono'
import { eq, desc, sql, and, or, inArray } from 'drizzle-orm'
import type { AppContext } from '../types'
import type { User } from '../db/schema'
import { topics, users, groups, comments, topicLikes, groupMembers, userFollows, nostrFollows } from '../db/schema'
import { Layout } from '../components/Layout'
import { generateId, stripHtml, truncate, resizeImage, processContentImages } from '../lib/utils'
import { SafeHtml } from '../components/SafeHtml'
import { deliverTopicToFollowers } from '../services/activitypub'
import { buildSignedEvent, pubkeyToNpub, npubToPubkey } from '../services/nostr'
import { getOrCreateNostrUser } from '../services/nostr-community'

const timeline = new Hono<AppContext>()

// Timeline 页面
timeline.get('/', async (c) => {
  const db = c.get('db')
  const user = c.get('user')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const page = Math.max(1, parseInt(c.req.query('page') || '1') || 1)
  const PAGE_SIZE = 30
  const offset = (page - 1) * PAGE_SIZE

  // Timeline 查询：自己的动态 + 关注的人的动态 + 加入的小组的帖子
  const timelineTopics = await db
    .select({
      id: topics.id,
      groupId: topics.groupId,
      userId: topics.userId,
      title: topics.title,
      content: topics.content,
      type: topics.type,
      images: topics.images,
      createdAt: topics.createdAt,
      updatedAt: topics.updatedAt,
      replyCount: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = ${topics.id})`.as('reply_count'),
      likeCount: sql<number>`(SELECT COUNT(*) FROM topic_like WHERE topic_like.topic_id = ${topics.id})`.as('like_count'),
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
      group: {
        id: groups.id,
        name: groups.name,
        iconUrl: groups.iconUrl,
      },
    })
    .from(topics)
    .innerJoin(users, eq(topics.userId, users.id))
    .leftJoin(groups, eq(topics.groupId, groups.id))
    .where(
      or(
        eq(topics.userId, user.id),
        sql`${topics.userId} IN (SELECT ${userFollows.followeeId} FROM ${userFollows} WHERE ${userFollows.followerId} = ${user.id})`,
        sql`${topics.groupId} IN (SELECT ${groupMembers.groupId} FROM ${groupMembers} WHERE ${groupMembers.userId} = ${user.id})`,
      )
    )
    .orderBy(desc(topics.updatedAt))
    .limit(PAGE_SIZE)
    .offset(offset)

  // 检查当前用户是否已喜欢这些话题
  const topicIds = timelineTopics.map(t => t.id)
  let userLikedTopicIds = new Set<string>()
  if (topicIds.length > 0) {
    const userLikes = await db
      .select({ topicId: topicLikes.topicId })
      .from(topicLikes)
      .where(and(eq(topicLikes.userId, user.id), inArray(topicLikes.topicId, topicIds)))
    userLikedTopicIds = new Set(userLikes.map(l => l.topicId))
  }

  // 获取 Nostr 关注列表
  const nostrFollowList = await db
    .select({
      id: nostrFollows.id,
      targetPubkey: nostrFollows.targetPubkey,
      targetNpub: nostrFollows.targetNpub,
      targetDisplayName: nostrFollows.targetDisplayName,
      createdAt: nostrFollows.createdAt,
    })
    .from(nostrFollows)
    .where(eq(nostrFollows.userId, user.id))
    .orderBy(desc(nostrFollows.createdAt))
    .limit(20)

  const formatDate = (date: Date) => {
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
    return date.toLocaleDateString('zh-CN')
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const appName = c.env.APP_NAME || 'NeoGroup'

  return c.html(
    <Layout
      user={user}
      title="Timeline"
      siteName={appName}
      unreadCount={c.get('unreadNotificationCount')}
    >
      <div class="timeline-page">
        <div class="timeline-main">
          {/* 发布动态 */}
          <div class="timeline-composer card">
            <form action="/timeline/post" method="POST" class="timeline-post-form">
              <div class="timeline-composer-header">
                <img
                  src={resizeImage(user.avatarUrl, 64) || '/static/img/default-avatar.svg'}
                  alt=""
                  class="avatar-sm"
                />
                <textarea
                  name="content"
                  placeholder="分享你的想法..."
                  rows={3}
                  required
                ></textarea>
              </div>
              <div class="timeline-composer-actions">
                <button type="submit" class="btn btn-primary">发布</button>
              </div>
            </form>
          </div>

          {/* Timeline */}
          {timelineTopics.length === 0 ? (
            <div class="card">
              <p>还没有动态。关注其他用户或加入小组来填充你的 Timeline 吧！</p>
            </div>
          ) : (
            timelineTopics.map((item) => {
              const isPersonalPost = !item.title || item.title === ''
              const isLiked = userLikedTopicIds.has(item.id)
              const preview = item.content ? truncate(stripHtml(item.content), 200) : null
              return (
                <div class="timeline-item card" key={item.id}>
                  <div class="timeline-item-header">
                    <a href={`/user/${item.user.username}`}>
                      <img
                        src={resizeImage(item.user.avatarUrl, 64) || '/static/img/default-avatar.svg'}
                        alt=""
                        class="avatar-sm"
                      />
                    </a>
                    <div class="timeline-item-meta">
                      <a href={`/user/${item.user.username}`} class="timeline-item-author">
                        {item.user.displayName || item.user.username}
                      </a>
                      <span class="timeline-item-time">{formatDate(item.createdAt)}</span>
                      {item.group && (
                        <span class="timeline-item-group">
                          来自 <a href={`/group/${item.group.id}`}>{item.group.name}</a>
                        </span>
                      )}
                    </div>
                  </div>
                  <div class="timeline-item-body">
                    {!isPersonalPost && (
                      <h3 class="timeline-item-title">
                        <a href={`/topic/${item.id}`}>{item.title}</a>
                      </h3>
                    )}
                    {preview && (
                      <div class="timeline-item-content">
                        <a href={`/topic/${item.id}`} class="timeline-item-preview">{preview}</a>
                      </div>
                    )}
                  </div>
                  <div class="timeline-item-actions">
                    <form action={`/topic/${item.id}/like`} method="POST" style="display: inline;">
                      <button type="submit" class={`comment-action-btn ${isLiked ? 'liked' : ''}`}>
                        {isLiked ? '已喜欢' : '喜欢'}{item.likeCount > 0 ? ` (${item.likeCount})` : ''}
                      </button>
                    </form>
                    <a href={`/topic/${item.id}`} class="comment-action-btn">
                      评论{item.replyCount > 0 ? ` (${item.replyCount})` : ''}
                    </a>
                    {item.user.id === user.id && (
                      <form action={`/topic/${item.id}/delete`} method="POST" style="display: inline;" onsubmit="return confirm('确定删除？')">
                        <button type="submit" class="comment-action-btn" style="color: #c00;">删除</button>
                      </form>
                    )}
                  </div>
                </div>
              )
            })
          )}

          {/* 分页 */}
          {timelineTopics.length >= PAGE_SIZE && (
            <div class="pagination">
              {page > 1 && (
                <a href={`/timeline?page=${page - 1}`} class="pagination-link">上一页</a>
              )}
              <span class="pagination-info">第 {page} 页</span>
              <a href={`/timeline?page=${page + 1}`} class="pagination-link">下一页</a>
            </div>
          )}
        </div>

        {/* 右侧边栏 */}
        <aside class="timeline-sidebar">
          {/* Nostr 关注 */}
          <div class="card">
            <h3>Nostr 关注</h3>
            <form action="/timeline/nostr-follow" method="POST" class="nostr-follow-form">
              <input
                type="text"
                name="target"
                placeholder="输入 npub 或 hex pubkey"
                required
                style="width:100%;margin-bottom:8px;"
              />
              <button type="submit" class="btn btn-primary btn-sm">关注</button>
            </form>
            {nostrFollowList.length > 0 && (
              <ul class="nostr-follow-list">
                {nostrFollowList.map((f) => (
                  <li key={f.id} class="nostr-follow-item">
                    <span class="nostr-follow-name">
                      {f.targetDisplayName || (f.targetNpub ? f.targetNpub.slice(0, 16) + '...' : f.targetPubkey.slice(0, 12) + '...')}
                    </span>
                    <form action="/timeline/nostr-unfollow" method="POST" style="display:inline;">
                      <input type="hidden" name="pubkey" value={f.targetPubkey} />
                      <button type="submit" class="comment-action-btn" style="color:#c00;">取消</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </Layout>
  )
})

// 发布个人动态
timeline.post('/post', async (c) => {
  const db = c.get('db')
  const user = c.get('user')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const body = await c.req.parseBody()
  const content = (body.content as string || '').trim()

  if (!content) {
    return c.redirect('/timeline')
  }

  const topicId = generateId()
  const now = new Date()
  const htmlContent = `<p>${content.replace(/\n/g, '</p><p>')}</p>`

  await db.insert(topics).values({
    id: topicId,
    groupId: null,
    userId: user.id,
    title: '',
    content: htmlContent,
    type: 0,
    createdAt: now,
    updatedAt: now,
  })

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // AP: deliver to followers
  c.executionCtx.waitUntil(
    deliverTopicToFollowers(db, baseUrl, user.id, topicId, '', htmlContent)
  )

  // Nostr: broadcast Kind 1
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const textContent = stripHtml(htmlContent).trim()
        const noteContent = textContent
        const nostrTags: string[][] = [
          ['client', c.env.APP_NAME || 'NeoGroup'],
        ]

        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 1,
          content: noteContent,
          tags: nostrTags,
        })

        await db.update(topics).set({ nostrEventId: event.id }).where(eq(topics.id, topicId))
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[Nostr] Failed to publish personal post:', e)
      }
    })())
  }

  return c.redirect('/timeline')
})

// 关注 Nostr 用户
timeline.post('/nostr-follow', async (c) => {
  const db = c.get('db')
  const user = c.get('user')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const body = await c.req.parseBody()
  const target = (body.target as string || '').trim()

  if (!target) {
    return c.redirect('/timeline')
  }

  // Parse npub or hex pubkey
  let pubkey: string | null = null
  let npub: string | null = null

  if (target.startsWith('npub1')) {
    pubkey = npubToPubkey(target)
    npub = target
  } else if (/^[0-9a-f]{64}$/i.test(target)) {
    pubkey = target.toLowerCase()
    npub = pubkeyToNpub(pubkey)
  }

  if (!pubkey) {
    return c.redirect('/timeline')
  }

  // Check if already following
  const existing = await db
    .select({ id: nostrFollows.id })
    .from(nostrFollows)
    .where(and(eq(nostrFollows.userId, user.id), eq(nostrFollows.targetPubkey, pubkey)))
    .limit(1)

  if (existing.length > 0) {
    return c.redirect('/timeline')
  }

  // Insert nostr_follow record
  await db.insert(nostrFollows).values({
    id: generateId(),
    userId: user.id,
    targetPubkey: pubkey,
    targetNpub: npub,
    createdAt: new Date(),
  })

  // Create shadow user and user_follow so Timeline query picks up their posts
  try {
    const shadowUser = await getOrCreateNostrUser(db, pubkey)

    // Create user_follow if not exists
    const existingFollow = await db
      .select({ id: userFollows.id })
      .from(userFollows)
      .where(and(eq(userFollows.followerId, user.id), eq(userFollows.followeeId, shadowUser.id)))
      .limit(1)

    if (existingFollow.length === 0) {
      await db.insert(userFollows).values({
        id: generateId(),
        followerId: user.id,
        followeeId: shadowUser.id,
        createdAt: new Date(),
      })
    }
  } catch (e) {
    console.error('[Nostr Follow] Failed to create shadow user:', e)
  }

  // Publish NIP-02 Kind 3 contact list to relays
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(publishContactList(db, user, c.env))
  }

  return c.redirect('/timeline')
})

// 取消关注 Nostr 用户
timeline.post('/nostr-unfollow', async (c) => {
  const db = c.get('db')
  const user = c.get('user')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const body = await c.req.parseBody()
  const pubkey = (body.pubkey as string || '').trim()

  if (!pubkey) {
    return c.redirect('/timeline')
  }

  await db
    .delete(nostrFollows)
    .where(and(eq(nostrFollows.userId, user.id), eq(nostrFollows.targetPubkey, pubkey)))

  // Publish updated NIP-02 Kind 3 contact list to relays
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(publishContactList(db, user, c.env))
  }

  return c.redirect('/timeline')
})

// Publish NIP-02 Kind 3 contact list to Nostr relays (merge with relay first)
async function publishContactList(db: any, user: User, env: any) {
  try {
    const { syncAndPublishContactList } = await import('../services/nostr-community')
    await syncAndPublishContactList(db, env, user)
  } catch (e) {
    console.error('[Nostr] Failed to publish contact list:', e)
  }
}

export default timeline
