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

  // 查询提醒列表
  const notificationList = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      topicId: notifications.topicId,
      commentId: notifications.commentId,
      isRead: notifications.isRead,
      createdAt: notifications.createdAt,
      actor: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(notifications)
    .innerJoin(users, eq(notifications.actorId, users.id))
    .where(eq(notifications.userId, user.id))
    .orderBy(desc(notifications.createdAt))
    .limit(50)

  // 获取关联的话题标题
  const topicIds = [...new Set(notificationList.map(n => n.topicId).filter(Boolean))] as string[]
  const topicMap = new Map<string, string>()
  if (topicIds.length > 0) {
    const topicRows = await db
      .select({ id: topics.id, title: topics.title })
      .from(topics)
      .where(eq(topics.id, topicIds[0]))
    // 逐个查（D1 不支持 IN 子句的数组绑定）
    for (const tid of topicIds) {
      const row = await db
        .select({ id: topics.id, title: topics.title })
        .from(topics)
        .where(eq(topics.id, tid))
        .limit(1)
      if (row.length > 0) {
        topicMap.set(row[0].id, row[0].title)
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

  const getTypeText = (type: string, topicTitle: string) => {
    switch (type) {
      case 'reply': return `回复了你的话题「${topicTitle}」`
      case 'comment_reply': return `回复了你在「${topicTitle}」的评论`
      case 'topic_like': return `喜欢了你的话题「${topicTitle}」`
      case 'comment_like': return `赞了你在「${topicTitle}」的评论`
      default: return '与你互动了'
    }
  }

  const getLink = (n: typeof notificationList[0]) => {
    if (!n.topicId) return '#'
    if (n.commentId && (n.type === 'comment_reply' || n.type === 'comment_like')) {
      return `/topic/${n.topicId}#comment-${n.commentId}`
    }
    return `/topic/${n.topicId}`
  }

  const unreadCount = c.get('unreadNotificationCount') || 0

  return c.html(
    <Layout user={user} title="提醒" unreadCount={0}>
      <div class="notification-page">
        <h1>提醒</h1>

        {notificationList.length === 0 ? (
          <p class="no-content">暂无提醒</p>
        ) : (
          <div class="notification-list">
            {notificationList.map((n) => {
              const topicTitle = truncate(topicMap.get(n.topicId || '') || '已删除的话题', 20)
              return (
                <a href={getLink(n)} class={`notification-item ${n.isRead === 0 ? 'unread' : ''}`} key={n.id}>
                  <img
                    src={n.actor.avatarUrl || '/static/img/default-avatar.svg'}
                    alt=""
                    class="avatar-sm"
                  />
                  <div class="notification-body">
                    <span class="notification-text">
                      <strong>{n.actor.displayName || n.actor.username}</strong>
                      {' '}{getTypeText(n.type, topicTitle)}
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
