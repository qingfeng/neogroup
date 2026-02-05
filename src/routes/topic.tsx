import { Hono } from 'hono'
import { eq, desc, and, sql } from 'drizzle-orm'
import type { AppContext } from '../types'
import { topics, users, groups, comments, commentLikes } from '../db/schema'
import { Layout } from '../components/Layout'
import { generateId, stripHtml, truncate, parseJson, resizeImage } from '../lib/utils'

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

  // 获取评论列表（包含点赞数）
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
      likeCount: sql<number>`(SELECT COUNT(*) FROM comment_like WHERE comment_like.comment_id = ${comments.id})`.as('like_count'),
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(eq(comments.topicId, topicId))
    .orderBy(comments.createdAt)

  // 获取当前用户点赞的评论ID列表
  let userLikedCommentIds: Set<string> = new Set()
  if (user) {
    const userLikes = await db
      .select({ commentId: commentLikes.commentId })
      .from(commentLikes)
      .where(eq(commentLikes.userId, user.id))
    userLikedCommentIds = new Set(userLikes.map(l => l.commentId))
  }

  // 构建评论ID到评论的映射（用于引用回复显示）
  const commentMap = new Map(commentList.map(c => [c.id, c]))

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
            <img src={resizeImage(topicData.group.iconUrl, 40) || '/static/img/default-group.svg'} alt="" class="group-icon-sm" />
            <span>{topicData.group.name}</span>
          </a>
        </div>

        <h1 class="topic-title">{topicData.title}</h1>

        <div class="topic-meta">
          <a href={`/user/${topicData.user.id}`} class="topic-author">
            <img
              src={resizeImage(topicData.user.avatarUrl, 64) || '/static/img/default-avatar.svg'}
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
            <form action={`/topic/${topicId}/comment`} method="POST" class="comment-form" id="comment-form">
              <input type="hidden" name="replyToId" id="replyToId" value="" />
              <div id="reply-hint" class="reply-hint" style="display: none;">
                <span>回复 <strong id="reply-to-name"></strong>: </span>
                <span id="reply-to-preview" class="reply-preview"></span>
                <button type="button" class="cancel-reply" onclick="cancelReply()">取消</button>
              </div>
              <textarea
                name="content"
                id="comment-textarea"
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

          <script dangerouslySetInnerHTML={{ __html: `
            function showReplyForm(commentId, authorName, preview) {
              document.getElementById('replyToId').value = commentId;
              document.getElementById('reply-to-name').textContent = authorName;
              document.getElementById('reply-to-preview').textContent = preview;
              document.getElementById('reply-hint').style.display = 'flex';
              document.getElementById('comment-textarea').focus();
              document.getElementById('comment-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            function cancelReply() {
              document.getElementById('replyToId').value = '';
              document.getElementById('reply-hint').style.display = 'none';
            }
          ` }} />

          <div class="comment-list">
            {commentList.length === 0 ? (
              <p class="no-comments">暂无评论</p>
            ) : (
              commentList.map((comment, index) => {
                const isAuthor = comment.user.id === topicData.userId
                const isLiked = userLikedCommentIds.has(comment.id)
                const replyTo = comment.replyToId ? commentMap.get(comment.replyToId) : null
                return (
                  <div class="comment-item" key={comment.id} id={`comment-${comment.id}`}>
                    <div class="comment-avatar">
                      <a href={`/user/${comment.user.id}`}>
                        <img
                          src={resizeImage(comment.user.avatarUrl, 96) || '/static/img/default-avatar.svg'}
                          alt=""
                          class="avatar"
                        />
                      </a>
                    </div>
                    <div class="comment-body">
                      <div class="comment-header">
                        <a href={`/user/${comment.user.id}`} class="comment-author-name">
                          {comment.user.displayName || comment.user.username}
                        </a>
                        {isAuthor && <span class="author-badge">楼主</span>}
                        <span class="comment-date">{formatDate(comment.createdAt)}</span>
                      </div>
                      {replyTo && (
                        <div class="comment-quote">
                          <span class="quote-content" dangerouslySetInnerHTML={{ __html: truncate(stripHtml(replyTo.content), 50) }} />
                          <a href={`/user/${replyTo.user.id}`} class="quote-author">
                            {replyTo.user.displayName || replyTo.user.username}
                          </a>
                        </div>
                      )}
                      <div class="comment-content" dangerouslySetInnerHTML={{ __html: comment.content }} />
                      <div class="comment-actions">
                        {user ? (
                          <form action={`/topic/${topicId}/comment/${comment.id}/like`} method="POST" style="display: inline;">
                            <button type="submit" class={`comment-action-btn ${isLiked ? 'liked' : ''}`}>
                              赞{comment.likeCount > 0 ? ` (${comment.likeCount})` : ''}
                            </button>
                          </form>
                        ) : (
                          <span class="comment-action-btn disabled">
                            赞{comment.likeCount > 0 ? ` (${comment.likeCount})` : ''}
                          </span>
                        )}
                        {user && (
                          <button
                            type="button"
                            class="comment-action-btn"
                            onclick={`showReplyForm('${comment.id}', '${(comment.user.displayName || comment.user.username).replace(/'/g, "\\'")}', '${truncate(stripHtml(comment.content), 30).replace(/'/g, "\\'")}')`}
                          >
                            回复
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
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
  const replyToId = body.replyToId as string | undefined

  if (!content || !content.trim()) {
    return c.redirect(`/topic/${topicId}`)
  }

  const now = new Date()

  await db.insert(comments).values({
    id: generateId(),
    topicId,
    userId: user.id,
    content: `<p>${content.trim().replace(/\n/g, '</p><p>')}</p>`,
    replyToId: replyToId || null,
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

// 点赞评论
topic.post('/:id/comment/:commentId/like', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')
  const commentId = c.req.param('commentId')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 检查评论是否存在
  const commentResult = await db
    .select()
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1)

  if (commentResult.length === 0) {
    return c.redirect(`/topic/${topicId}`)
  }

  // 检查是否已点赞
  const existingLike = await db
    .select()
    .from(commentLikes)
    .where(and(eq(commentLikes.commentId, commentId), eq(commentLikes.userId, user.id)))
    .limit(1)

  if (existingLike.length > 0) {
    // 已点赞则取消
    await db
      .delete(commentLikes)
      .where(and(eq(commentLikes.commentId, commentId), eq(commentLikes.userId, user.id)))
  } else {
    // 未点赞则添加
    await db.insert(commentLikes).values({
      id: generateId(),
      commentId,
      userId: user.id,
      createdAt: new Date(),
    })
  }

  return c.redirect(`/topic/${topicId}#comment-${commentId}`)
})

export default topic
