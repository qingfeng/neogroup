import { Hono } from 'hono'
import { eq, desc, and } from 'drizzle-orm'
import type { AppContext } from '../types'
import { notifications, users, topics } from '../db/schema'
import { Layout } from '../components/Layout'
import { stripHtml, truncate } from '../lib/utils'

const notification = new Hono<AppContext>()

notification.get('/', async (c) => {
  const db = c.get('db')
  const user = c.get('user')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 查询提醒列表（leftJoin 以支持远程 actor）
  const notificationList = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      topicId: notifications.topicId,
      commentId: notifications.commentId,
      isRead: notifications.isRead,
      createdAt: notifications.createdAt,
      actorName: notifications.actorName,
      actorUrl: notifications.actorUrl,
      actorAvatarUrl: notifications.actorAvatarUrl,
      metadata: notifications.metadata,
      actor: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(notifications)
    .leftJoin(users, eq(notifications.actorId, users.id))
    .where(eq(notifications.userId, user.id))
    .orderBy(desc(notifications.createdAt))
    .limit(50)

  // 获取关联的话题标题
  const topicIds = [...new Set(notificationList.map(n => n.topicId).filter(Boolean))] as string[]
  const topicMap = new Map<string, string>()
  if (topicIds.length > 0) {
    // 逐个查（D1 不支持 IN 子句的数组绑定）
    for (const tid of topicIds) {
      const row = await db
        .select({ id: topics.id, title: topics.title, content: topics.content, groupId: topics.groupId })
        .from(topics)
        .where(eq(topics.id, tid))
        .limit(1)
      if (row.length > 0) {
        // 说说（无 group、无 title）用 content 摘要代替
        const label = row[0].title || (row[0].content ? stripHtml(row[0].content) : '')
        topicMap.set(row[0].id, label)
      }
    }
  }

  // 标记全部已读
  await db
    .update(notifications)
    .set({ isRead: 1 })
    .where(and(eq(notifications.userId, user.id), eq(notifications.isRead, 0)))

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('zh-CN', {
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const getTypeText = (n: typeof notificationList[0], topicTitle: string) => {
    switch (n.type) {
      case 'reply': return `回复了你的话题「${topicTitle}」`
      case 'comment_reply': return `回复了你在「${topicTitle}」的评论`
      case 'topic_like': return `喜欢了你的话题「${topicTitle}」`
      case 'comment_like': return `赞了你在「${topicTitle}」的评论`
      case 'topic_repost': return `转发了你的话题「${topicTitle}」`
      case 'comment_repost': return `转发了你在「${topicTitle}」的评论`
      case 'follow': return '关注了你'
      case 'mention': {
        let meta: { content?: string } = {}
        try { if (n.metadata) meta = JSON.parse(n.metadata) } catch {}
        const summary = meta.content ? `：${truncate(meta.content, 80)}` : ''
        return `提到了你${summary}`
      }
      default: return '与你互动了'
    }
  }

  const getLink = (n: typeof notificationList[0]) => {
    if (n.type === 'follow') {
      if (n.actor?.id) return `/user/${n.actor.username}`
      return n.actorUrl || '#'
    }
    if (n.type === 'mention') {
      try {
        if (n.metadata) {
          const meta = JSON.parse(n.metadata) as { noteUrl?: string }
          if (meta.noteUrl) return meta.noteUrl
        }
      } catch {}
      return n.actorUrl || '#'
    }
    if (!n.topicId) return '#'
    if (n.commentId && (n.type === 'comment_reply' || n.type === 'comment_like' || n.type === 'comment_repost')) {
      return `/topic/${n.topicId}#comment-${n.commentId}`
    }
    return `/topic/${n.topicId}`
  }

  const unreadCount = c.get('unreadNotificationCount') || 0

  return c.html(
    <Layout user={user} title="提醒" unreadCount={0} siteName={c.env.APP_NAME}>
      <div class="notification-page">
        <h1>提醒</h1>

        {notificationList.length === 0 ? (
          <p class="no-content">暂无提醒</p>
        ) : (
          <div class="notification-list">
            {notificationList.map((n) => {
              const topicTitle = truncate(topicMap.get(n.topicId || '') || '已删除的话题', 20)
              const displayName = n.actor?.id
                ? (n.actor.displayName || n.actor.username)
                : (n.actorName || '远程用户')
              const avatarUrl = n.actor?.id
                ? (n.actor.avatarUrl || '/static/img/default-avatar.svg')
                : (n.actorAvatarUrl || '/static/img/default-avatar.svg')
              const isExternal = n.type === 'mention' && !n.actor?.id

              return (
                <a
                  href={getLink(n)}
                  class={`notification-item ${n.isRead === 0 ? 'unread' : ''}`}
                  key={n.id}
                  {...(isExternal ? { target: '_blank', rel: 'noopener' } : {})}
                >
                  <img
                    src={avatarUrl}
                    alt=""
                    class="avatar-sm"
                  />
                  <div class="notification-body">
                    <span class="notification-text">
                      <strong>{displayName}</strong>
                      {' '}{getTypeText(n, topicTitle)}
                    </span>
                    <span class="notification-time">{formatDate(n.createdAt)}</span>
                  </div>
                </a>
              )
            })}
          </div>
        )}
      </div>
    </Layout>
  )
})

export default notification
