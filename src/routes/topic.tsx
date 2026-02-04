import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import type { AppContext } from '../types'
import { topics, users, groups, comments } from '../db/schema'
import { Layout } from '../components/Layout'
import { generateId, stripHtml, truncate, parseJson } from '../lib/utils'

const topic = new Hono<AppContext>()

topic.get('/:id', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  // 获取话题详情
  const topicResult = await db
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
    .innerJoin(groups, eq(topics.groupId, groups.id))
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicResult.length === 0) {
    return c.notFound()
  }

  const topicData = topicResult[0]

  // 获取评论列表
  const commentList = await db
    .select({
      id: comments.id,
      content: comments.content,
      replyToId: comments.replyToId,
      createdAt: comments.createdAt,
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(eq(comments.topicId, topicId))
    .orderBy(desc(comments.createdAt))

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // 生成 metadata
  const description = topicData.content
    ? truncate(stripHtml(topicData.content), 160)
    : undefined

  const images = parseJson<string[]>(topicData.images, [])
  const ogImage = images.length > 0 ? images[0] : undefined

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const topicUrl = `${baseUrl}/topic/${topicId}`

  return c.html(
    <Layout
      user={user}
      title={topicData.title}
      description={description}
      image={ogImage}
      url={topicUrl}
      ogType="article"
    >
      <div class="topic-detail">
        <div class="topic-header">
          <a href={`/group/${topicData.group.id}`} class="topic-group">
            {topicData.group.iconUrl && (
              <img src={topicData.group.iconUrl} alt="" class="group-icon-sm" />
            )}
            <span>{topicData.group.name}</span>
          </a>
        </div>

        <h1 class="topic-title">{topicData.title}</h1>

        <div class="topic-meta">
          <a href={`/user/${topicData.user.id}`} class="topic-author">
            <img
              src={topicData.user.avatarUrl || '/static/img/default-avatar.svg'}
              alt=""
              class="avatar-sm"
            />
            <span>{topicData.user.displayName || topicData.user.username}</span>
          </a>
          <span class="topic-date">{formatDate(topicData.createdAt)}</span>
        </div>

        {topicData.content && (
          <div class="topic-content" dangerouslySetInnerHTML={{ __html: topicData.content }} />
        )}

        <div class="comments-section">
          <h2>评论 ({commentList.length})</h2>

          {user ? (
            <form action={`/topic/${topicId}/comment`} method="POST" class="comment-form">
              <textarea
                name="content"
                placeholder="写下你的评论..."
                rows={3}
                required
              ></textarea>
              <button type="submit" class="btn btn-primary">发表评论</button>
            </form>
          ) : (
            <p class="login-hint">
              <a href="/auth/login">登录</a> 后发表评论
            </p>
          )}

          <div class="comment-list">
            {commentList.length === 0 ? (
              <p class="no-comments">暂无评论</p>
            ) : (
              commentList.map((comment) => (
                <div class="comment-item" key={comment.id}>
                  <div class="comment-header">
                    <a href={`/user/${comment.user.id}`} class="comment-author">
                      <img
                        src={comment.user.avatarUrl || '/static/img/default-avatar.svg'}
                        alt=""
                        class="avatar-xs"
                      />
                      <span>{comment.user.displayName || comment.user.username}</span>
                    </a>
                    <span class="comment-date">{formatDate(comment.createdAt)}</span>
                  </div>
                  <div class="comment-content" dangerouslySetInnerHTML={{ __html: comment.content }} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
})

// 发表评论
topic.post('/:id/comment', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 检查话题是否存在
  const topicResult = await db
    .select()
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicResult.length === 0) {
    return c.notFound()
  }

  const body = await c.req.parseBody()
  const content = body.content as string

  if (!content || !content.trim()) {
    return c.redirect(`/topic/${topicId}`)
  }

  const now = new Date()

  await db.insert(comments).values({
    id: generateId(),
    topicId,
    userId: user.id,
    content: `<p>${content.trim().replace(/\n/g, '</p><p>')}</p>`,
    createdAt: now,
    updatedAt: now,
  })

  // 更新话题的 updatedAt
  await db
    .update(topics)
    .set({ updatedAt: now })
    .where(eq(topics.id, topicId))

  return c.redirect(`/topic/${topicId}`)
})

export default topic
