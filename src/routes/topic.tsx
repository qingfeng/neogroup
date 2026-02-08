import { Hono } from 'hono'
import { eq, desc, and, sql, ne } from 'drizzle-orm'
import type { AppContext } from '../types'
import { topics, users, groups, comments, commentLikes, commentReposts, topicLikes, topicReposts, groupMembers, authProviders } from '../db/schema'
import { Layout } from '../components/Layout'
import { generateId, stripHtml, truncate, parseJson, resizeImage, processContentImages, isSuperAdmin } from '../lib/utils'
import { SafeHtml } from '../components/SafeHtml'
import { createNotification } from '../lib/notifications'
import { syncMastodonReplies, syncCommentReplies } from '../services/mastodon-sync'
import { postStatus, resolveStatusId, reblogStatus, resolveStatusByUrl, unreblogStatus } from '../services/mastodon'
import { deliverCommentToFollowers } from '../services/activitypub'

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
      mastodonStatusId: topics.mastodonStatusId,
      mastodonDomain: topics.mastodonDomain,
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
        description: groups.description,
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
  const groupId = topicData.groupId

  // Sync Mastodon replies if applicable
  if (topicData.mastodonStatusId && topicData.mastodonDomain) {
    try {
      await syncMastodonReplies(db, topicId, topicData.mastodonDomain, topicData.mastodonStatusId)
    } catch (e) {
      console.error('Failed to sync Mastodon replies:', e)
    }
  }

  // Sync replies to comments posted as independent Mastodon status
  const commentsWithMastodon = await db
    .select({ id: comments.id, mastodonStatusId: comments.mastodonStatusId, mastodonDomain: comments.mastodonDomain })
    .from(comments)
    .where(eq(comments.topicId, topicId))

  for (const comment of commentsWithMastodon) {
    if (comment.mastodonStatusId && comment.mastodonDomain) {
      try {
        await syncCommentReplies(db, topicId, comment.id, comment.mastodonDomain, comment.mastodonStatusId)
      } catch (e) {
        console.error('Failed to sync comment replies:', e)
      }
    }
  }

  // 获取小组成员数
  const memberCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))
  const memberCount = memberCountResult[0]?.count || 0

  // 检查当前用户是否是成员
  let isMember = false
  if (user) {
    const membership = await db
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
      .limit(1)
    isMember = membership.length > 0
  }

  // 获取话题喜欢数
  const topicLikeCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(topicLikes)
    .where(eq(topicLikes.topicId, topicId))
  const topicLikeCount = topicLikeCountResult[0]?.count || 0

  // 检查当前用户是否喜欢
  let isTopicLiked = false
  if (user) {
    const existingLike = await db
      .select()
      .from(topicLikes)
      .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))
      .limit(1)
    isTopicLiked = existingLike.length > 0
  }

  // 获取转发数
  const repostCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(topicReposts)
    .where(eq(topicReposts.topicId, topicId))
  const repostCount = repostCountResult[0]?.count || 0

  // 获取转发者列表
  const reposters = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(topicReposts)
    .innerJoin(users, eq(topicReposts.userId, users.id))
    .where(eq(topicReposts.topicId, topicId))
    .orderBy(desc(topicReposts.createdAt))

  // 检查当前用户是否已转发
  let isReposted = false
  if (user) {
    const existingRepost = await db
      .select()
      .from(topicReposts)
      .where(and(eq(topicReposts.topicId, topicId), eq(topicReposts.userId, user.id)))
      .limit(1)
    isReposted = existingRepost.length > 0
  }

  // 检查用户是否有 Mastodon 账号（用于评论同步）
  let hasMastodonAuth = false
  if (user) {
    const ap = await db.query.authProviders.findFirst({
      where: and(eq(authProviders.userId, user.id), eq(authProviders.providerType, 'mastodon')),
    })
    hasMastodonAuth = !!(ap?.accessToken)
  }

  // 获取小组最新话题（排除当前话题）
  const latestTopics = await db
    .select({
      id: topics.id,
      title: topics.title,
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      },
    })
    .from(topics)
    .innerJoin(users, eq(topics.userId, users.id))
    .where(and(eq(topics.groupId, groupId), ne(topics.id, topicId)))
    .orderBy(desc(topics.updatedAt))
    .limit(5)

  // 分页参数
  const PAGE_SIZE = 50
  const page = Math.max(1, parseInt(c.req.query('page') || '1') || 1)
  const authorOnly = c.req.query('author_only') === '1'

  // 评论查询条件
  const commentCondition = authorOnly
    ? and(eq(comments.topicId, topicId), eq(comments.userId, topicData.userId))
    : eq(comments.topicId, topicId)

  // 获取评论总数
  const totalResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(comments)
    .where(commentCondition)
  const totalComments = totalResult[0]?.count || 0
  const totalPages = Math.ceil(totalComments / PAGE_SIZE)

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
      repostCount: sql<number>`(SELECT COUNT(*) FROM comment_repost WHERE comment_repost.comment_id = ${comments.id})`.as('repost_count'),
      mastodonStatusId: comments.mastodonStatusId,
      mastodonDomain: comments.mastodonDomain,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(commentCondition)
    .orderBy(comments.createdAt)
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE)

  // 获取当前用户点赞的评论ID列表
  let userLikedCommentIds: Set<string> = new Set()
  if (user) {
    const userLikes = await db
      .select({ commentId: commentLikes.commentId })
      .from(commentLikes)
      .where(eq(commentLikes.userId, user.id))
    userLikedCommentIds = new Set(userLikes.map(l => l.commentId))
  }

  // 获取当前用户转发的评论ID列表
  let userRepostedCommentIds: Set<string> = new Set()
  if (user) {
    const userReposts = await db
      .select({ commentId: commentReposts.commentId })
      .from(commentReposts)
      .where(eq(commentReposts.userId, user.id))
    userRepostedCommentIds = new Set(userReposts.map(r => r.commentId))
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
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  // 优先使用帖子图片，否则使用小组图标
  const ogImage = images.length > 0
    ? images[0]
    : (topicData.group.iconUrl || `${baseUrl}/static/img/default-group.svg`)

  const topicUrl = `${baseUrl}/topic/${topicId}`

  // JSON-LD 结构化数据
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'DiscussionForumPosting',
    headline: topicData.title,
    url: topicUrl,
    datePublished: topicData.createdAt.toISOString(),
    dateModified: topicData.updatedAt.toISOString(),
    author: {
      '@type': 'Person',
      name: topicData.user.displayName || topicData.user.username,
      url: `${baseUrl}/user/${topicData.user.username}`,
    },
    interactionStatistic: {
      '@type': 'InteractionCounter',
      interactionType: 'https://schema.org/CommentAction',
      userInteractionCount: commentList.length,
    },
    isPartOf: {
      '@type': 'WebPage',
      name: topicData.group.name,
      url: `${baseUrl}/group/${topicData.group.id}`,
    },
    ...(description ? { description } : {}),
    ...(ogImage ? { image: ogImage } : {}),
  }

  return c.html(
    <Layout
      user={user}
      title={topicData.title}
      description={description}
      image={ogImage}
      url={topicUrl}
      ogType="article"
      jsonLd={jsonLd}
      unreadCount={c.get('unreadNotificationCount')}
    >
      <div class="topic-page-layout">
        <div class="topic-detail">
          <div class="topic-header">
            <a href={`/group/${topicData.group.id}`} class="topic-group">
              <img src={resizeImage(topicData.group.iconUrl, 40) || '/static/img/default-group.svg'} alt="" class="group-icon-sm" />
              <span>{topicData.group.name}</span>
            </a>
          </div>

          <h1 class="topic-title">{topicData.title}</h1>

          <div class="topic-meta">
            <a href={`/user/${topicData.user.username}`} class="topic-author">
              <img
                src={resizeImage(topicData.user.avatarUrl, 64) || '/static/img/default-avatar.svg'}
                alt=""
                class="avatar-sm"
              />
              <span>{topicData.user.displayName || topicData.user.username}</span>
            </a>
            <span class="topic-date">{formatDate(topicData.createdAt)}</span>
            {user && (user.id === topicData.userId || isSuperAdmin(user)) && (
              <span class="topic-actions-inline">
                {user.id === topicData.userId && (
                  <a href={`/topic/${topicId}/edit`} class="topic-edit-link">编辑</a>
                )}
                {isSuperAdmin(user) ? (
                  <form action={`/topic/${topicId}/delete`} method="POST" style="display: inline;" onsubmit={`return confirm('确定要删除这个话题吗？${commentList.length > 0 ? '将同时删除 ' + commentList.length + ' 条评论。' : ''}删除后无法恢复。')`}>
                    <button type="submit" class="topic-edit-link" style="border: none; background: none; cursor: pointer; color: #c00; padding: 0;">删除</button>
                  </form>
                ) : commentList.length > 0 ? (
                  <button type="button" class="topic-edit-link" style="border: none; background: none; cursor: pointer; color: #c00; padding: 0;" onclick="alert('该话题下还有评论，请先删除全部评论后再删除话题。')">删除</button>
                ) : (
                  <form action={`/topic/${topicId}/delete`} method="POST" style="display: inline;" onsubmit="return confirm('确定要删除这个话题吗？删除后无法恢复。')">
                    <button type="submit" class="topic-edit-link" style="border: none; background: none; cursor: pointer; color: #c00; padding: 0;">删除</button>
                  </form>
                )}
              </span>
            )}
          </div>

          {topicData.content && (
            <SafeHtml html={processContentImages(topicData.content)} className="topic-content" />
          )}

          <div class="topic-like-section">
            {user ? (
              <form action={`/topic/${topicId}/like`} method="POST" style="display: inline;">
                <button type="submit" class={`topic-like-btn ${isTopicLiked ? 'liked' : ''}`}>
                  {isTopicLiked ? '已喜欢' : '喜欢'}
                  {topicLikeCount > 0 ? ` (${topicLikeCount})` : ''}
                </button>
              </form>
            ) : (
              <span class="topic-like-btn disabled">
                喜欢{topicLikeCount > 0 ? ` (${topicLikeCount})` : ''}
              </span>
            )}
            {hasMastodonAuth && !isReposted && (
              <form action={`/topic/${topicId}/repost`} method="POST" style="display: inline;">
                <button type="submit" class={`topic-like-btn`} onclick="this.disabled=true;this.form.submit();">
                  转发{repostCount > 0 ? ` (${repostCount})` : ''}
                </button>
              </form>
            )}
            {hasMastodonAuth && isReposted && (
              <form action={`/topic/${topicId}/unrepost`} method="POST" style="display: inline;">
                <button type="submit" class="topic-like-btn reposted" onclick="this.disabled=true;this.form.submit();">
                  已转发（撤销）{repostCount > 0 ? ` (${repostCount})` : ''}
                </button>
              </form>
            )}
            {!hasMastodonAuth && repostCount > 0 && (
              <span class="topic-like-btn disabled">
                转发 ({repostCount})
              </span>
            )}
            {repostCount > 0 && (
              <button type="button" class="repost-count-link" onclick="document.getElementById('reposters-modal').style.display='flex'">
                {repostCount} 人转发
              </button>
            )}
          </div>

          {repostCount > 0 && (
            <div id="reposters-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)this.style.display='none'">
              <div class="modal-content">
                <div class="modal-header">
                  <span class="modal-title">转发者</span>
                  <button type="button" class="modal-close" onclick="document.getElementById('reposters-modal').style.display='none'">&times;</button>
                </div>
                <div class="modal-body">
                  {reposters.map((r) => (
                    <a href={`/user/${r.username}`} class="reposter-item" key={r.id}>
                      <img src={resizeImage(r.avatarUrl, 64) || '/static/img/default-avatar.svg'} alt="" class="avatar-sm" />
                      <span>{r.displayName || r.username}</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div class="comments-section">
            <div class="comments-header">
              <h2>评论 ({totalComments})</h2>
              {authorOnly ? (
                <a href={`/topic/${topicId}`} class="btn-text">查看全部</a>
              ) : (
                <a href={`/topic/${topicId}?author_only=1`} class="btn-text">只看楼主</a>
              )}
            </div>

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
                {hasMastodonAuth && (
                  <div class="form-option">
                    <label class="checkbox-label">
                      <input type="checkbox" name="syncMastodon" value="1" />
                      同步到 Mastodon
                    </label>
                  </div>
                )}
                <button type="submit" class="btn btn-primary">发表评论</button>
              </form>
            ) : (
              <p class="login-hint">
                <a href="/auth/login">登录</a> 后发表评论
              </p>
            )}

            <script dangerouslySetInnerHTML={{
              __html: `
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
            function showEditForm(commentId) {
              document.getElementById('edit-form-' + commentId).style.display = 'block';
            }
            function hideEditForm(commentId) {
              document.getElementById('edit-form-' + commentId).style.display = 'none';
            }
          ` }} />

            <div class="comment-list">
              {commentList.length === 0 ? (
                <p class="no-comments">暂无评论</p>
              ) : (
                commentList.map((comment, index) => {
                  const isAuthor = comment.user.id === topicData.userId
                  const isLiked = userLikedCommentIds.has(comment.id)
                  const isCommentReposted = userRepostedCommentIds.has(comment.id)
                  const replyTo = comment.replyToId ? commentMap.get(comment.replyToId) : null
                  return (
                    <div class="comment-item" key={comment.id} id={`comment-${comment.id}`}>
                      <div class="comment-avatar">
                        <a href={`/user/${comment.user.username}`}>
                          <img
                            src={resizeImage(comment.user.avatarUrl, 96) || '/static/img/default-avatar.svg'}
                            alt=""
                            class="avatar"
                          />
                        </a>
                      </div>
                      <div class="comment-body">
                        <div class="comment-header">
                          <a href={`/user/${comment.user.username}`} class="comment-author-name">
                            {comment.user.displayName || comment.user.username}
                          </a>
                          {isAuthor && <span class="author-badge">楼主</span>}
                          <span class="comment-date">{formatDate(comment.createdAt)}</span>
                        </div>
                        {replyTo && (
                          <div class="comment-quote">
                            <span class="quote-content" dangerouslySetInnerHTML={{ __html: truncate(stripHtml(replyTo.content), 50) }} />
                            <a href={`/user/${replyTo.user.username}`} class="quote-author">
                              {replyTo.user.displayName || replyTo.user.username}
                            </a>
                          </div>
                        )}
                        <SafeHtml html={comment.content} className="comment-content" />
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
                          {hasMastodonAuth && !isCommentReposted && (
                            <form action={`/topic/${topicId}/comment/${comment.id}/repost`} method="POST" style="display: inline;">
                              <button type="submit" class="comment-action-btn" onclick="this.disabled=true;this.form.submit();">
                                转发{comment.repostCount > 0 ? ` (${comment.repostCount})` : ''}
                              </button>
                            </form>
                          )}
                          {hasMastodonAuth && isCommentReposted && (
                            <form action={`/topic/${topicId}/comment/${comment.id}/unrepost`} method="POST" style="display: inline;">
                              <button type="submit" class="comment-action-btn reposted" onclick="this.disabled=true;this.form.submit();">
                                已转发（撤销）{comment.repostCount > 0 ? ` (${comment.repostCount})` : ''}
                              </button>
                            </form>
                          )}
                          {user && user.id === comment.user.id && (
                            <button
                              type="button"
                              class="comment-action-btn"
                              onclick={`showEditForm('${comment.id}')`}
                            >
                              编辑
                            </button>
                          )}
                          {user && (user.id === comment.user.id || isSuperAdmin(user)) && (
                            <form action={`/topic/${topicId}/comment/${comment.id}/delete`} method="POST" style="display: inline;" onsubmit="return confirm('确定要删除这条评论吗？')">
                              <button type="submit" class="comment-action-btn" style="color: #c00;">删除</button>
                            </form>
                          )}
                        </div>
                        {user && user.id === comment.user.id && (
                          <div class="comment-edit-form" id={`edit-form-${comment.id}`} style="display: none;">
                            <form action={`/topic/${topicId}/comment/${comment.id}/edit`} method="POST">
                              <textarea name="content" rows={3} class="comment-edit-textarea">{stripHtml(comment.content)}</textarea>
                              <div class="comment-edit-actions">
                                <button type="submit" class="btn btn-primary">保存</button>
                                <button type="button" class="btn" onclick={`hideEditForm('${comment.id}')`}>取消</button>
                              </div>
                            </form>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            {totalPages > 1 && (
              <div class="pagination">
                {page > 1 && (
                  <a href={`/topic/${topicId}?page=${page - 1}${authorOnly ? '&author_only=1' : ''}`} class="pagination-link">上一页</a>
                )}
                <span class="pagination-info">第 {page} / {totalPages} 页</span>
                {page < totalPages && (
                  <a href={`/topic/${topicId}?page=${page + 1}${authorOnly ? '&author_only=1' : ''}`} class="pagination-link">下一页</a>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 右侧边栏 */}
        <aside class="topic-sidebar">
          {/* 小组信息卡片 */}
          <div class="sidebar-group-card">
            <div class="sidebar-group-header">
              <img
                src={resizeImage(topicData.group.iconUrl, 160) || '/static/img/default-group.svg'}
                alt=""
                class="sidebar-group-icon"
              />
              <div class="sidebar-group-info">
                <a href={`/group/${groupId}`} class="sidebar-group-name">{topicData.group.name}</a>
                {topicData.group.description && (
                  <p class="sidebar-group-desc">{truncate(topicData.group.description, 50)}</p>
                )}
              </div>
            </div>
            <div class="sidebar-group-stats">
              <strong>{memberCount}</strong> 人聚集在这个小组
            </div>
            {user && !isMember && (
              <form action={`/group/${groupId}/join`} method="POST">
                <button type="submit" class="btn btn-primary sidebar-join-btn">加入小组</button>
              </form>
            )}
            {user && isMember && (
              <div class="sidebar-member-status">已加入</div>
            )}
          </div>

          {/* 最新讨论 */}
          {latestTopics.length > 0 && (
            <div class="sidebar-latest">
              <div class="sidebar-latest-header">
                <span>最新讨论</span>
                <a href={`/group/${groupId}`} class="sidebar-more">（更多）</a>
              </div>
              <ul class="sidebar-latest-list">
                {latestTopics.map((t) => (
                  <li key={t.id}>
                    <a href={`/topic/${t.id}`} class="sidebar-topic-title">{truncate(t.title, 25)}</a>
                    <span class="sidebar-topic-author">（{t.user.displayName || t.user.username}）</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
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
  const syncMastodon = body.syncMastodon as string

  if (!content || !content.trim()) {
    return c.redirect(`/topic/${topicId}`)
  }

  const now = new Date()
  const commentId = generateId()

  const htmlContent = `<p>${content.trim().replace(/\n/g, '</p><p>')}</p>`

  await db.insert(comments).values({
    id: commentId,
    topicId,
    userId: user.id,
    content: htmlContent,
    replyToId: replyToId || null,
    createdAt: now,
    updatedAt: now,
  })

  // 更新话题的 updatedAt
  await db
    .update(topics)
    .set({ updatedAt: now })
    .where(eq(topics.id, topicId))

  // 提醒话题作者
  await createNotification(db, {
    userId: topicResult[0].userId,
    actorId: user.id,
    type: 'reply',
    topicId,
  })

  // 如果是回复某条评论，提醒该评论作者
  if (replyToId) {
    const replyComment = await db.select({ userId: comments.userId }).from(comments).where(eq(comments.id, replyToId)).limit(1)
    if (replyComment.length > 0 && replyComment[0].userId !== topicResult[0].userId) {
      await createNotification(db, {
        userId: replyComment[0].userId,
        actorId: user.id,
        type: 'comment_reply',
        topicId,
        commentId: replyToId,
      })
    }
  }

  // AP: deliver Create(Note) to followers
  const baseUrlForAp = c.env.APP_URL || new URL(c.req.url).origin
  c.executionCtx.waitUntil(
    deliverCommentToFollowers(db, baseUrlForAp, user.id, commentId, topicId, htmlContent, replyToId || null)
  )

  // 同步评论到 Mastodon
  if (syncMastodon === '1') {
    try {
      const authProvider = await db.query.authProviders.findFirst({
        where: and(eq(authProviders.userId, user.id), eq(authProviders.providerType, 'mastodon')),
      })
      if (authProvider?.accessToken) {
        const userDomain = authProvider.providerId.split('@')[1]
        const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
        const plainText = stripHtml(content.trim())
        const link = `${baseUrl}/topic/${topicId}`

        let toot: { id: string }

        if (topicResult[0].mastodonStatusId && topicResult[0].mastodonDomain) {
          // 情况1: 帖子有 Mastodon status → 作为回复发送
          const replyToStatusId = await resolveStatusId(
            userDomain, authProvider.accessToken,
            topicResult[0].mastodonDomain, topicResult[0].mastodonStatusId
          )
          if (replyToStatusId) {
            const tootContent = plainText.length > 450 ? `${plainText.slice(0, 450)}...\n\n${link}` : `${plainText}\n\n${link}`
            toot = await postStatus(userDomain, authProvider.accessToken, tootContent, 'unlisted', replyToStatusId)
          } else {
            throw new Error('Could not resolve Mastodon status ID')
          }
        } else {
          // 情况2: 帖子没有 Mastodon status → 作为独立 status 发送
          const topicTitle = topicResult[0].title

          // 确定要 @的人：如果是回复评论，@评论作者；否则@帖子作者（不@自己）
          let mentionUserId = topicResult[0].userId
          if (replyToId) {
            const replyTarget = await db.select({ userId: comments.userId }).from(comments).where(eq(comments.id, replyToId)).limit(1)
            if (replyTarget.length > 0) {
              mentionUserId = replyTarget[0].userId
            }
          }

          let mention = ''
          if (mentionUserId !== user.id) {
            const mentionAuth = await db.query.authProviders.findFirst({
              where: and(
                eq(authProviders.userId, mentionUserId),
                eq(authProviders.providerType, 'mastodon')
              ),
            })
            if (mentionAuth?.metadata) {
              try {
                const meta = JSON.parse(mentionAuth.metadata) as { username?: string }
                const mentionDomain = mentionAuth.providerId.split('@')[1]
                if (meta.username && mentionDomain) {
                  mention = `@${meta.username}@${mentionDomain} `
                }
              } catch { /* ignore parse error */ }
            }
          }

          const tootContent = plainText.length > 380
            ? `${mention}${plainText.slice(0, 380)}...\n\n📝 ${topicTitle}\n${link}`
            : `${mention}${plainText}\n\n📝 ${topicTitle}\n${link}`
          toot = await postStatus(userDomain, authProvider.accessToken, tootContent, 'unlisted')
        }

        // 保存 mastodonStatusId 和 mastodonDomain 以便同步回复
        await db.update(comments).set({
          mastodonStatusId: toot.id,
          mastodonDomain: userDomain,
        }).where(eq(comments.id, commentId))
      }
    } catch (e) {
      console.error('Failed to sync comment to Mastodon:', e)
    }
  }

  return c.redirect(`/topic/${topicId}`)
})

// 转发话题到 Mastodon
topic.post('/:id/repost', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const authProvider = await db.query.authProviders.findFirst({
    where: and(eq(authProviders.userId, user.id), eq(authProviders.providerType, 'mastodon')),
  })

  if (!authProvider?.accessToken) {
    return c.redirect(`/topic/${topicId}`)
  }

  const userDomain = authProvider.providerId.split('@')[1]
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const noteUrl = `${baseUrl}/ap/notes/${topicId}`

  try {
    const localStatusId = await resolveStatusByUrl(userDomain, authProvider.accessToken, noteUrl)
    if (!localStatusId) {
      console.error('Failed to resolve AP Note for repost:', noteUrl)
      return c.redirect(`/topic/${topicId}`)
    }
    await reblogStatus(userDomain, authProvider.accessToken, localStatusId)

    // 记录转发（避免重复）
    const existingRepost = await db
      .select()
      .from(topicReposts)
      .where(and(eq(topicReposts.topicId, topicId), eq(topicReposts.userId, user.id)))
      .limit(1)
    if (existingRepost.length === 0) {
      await db.insert(topicReposts).values({
        id: generateId(),
        topicId,
        userId: user.id,
        createdAt: new Date(),
      })

      // 提醒话题作者
      const topicData = await db
        .select({ userId: topics.userId })
        .from(topics)
        .where(eq(topics.id, topicId))
        .limit(1)
      if (topicData.length > 0) {
        await createNotification(db, {
          userId: topicData[0].userId,
          actorId: user.id,
          type: 'topic_repost',
          topicId,
        })
      }
    }
  } catch (e) {
    console.error('Failed to repost topic to Mastodon:', e)
  }

  return c.redirect(`/topic/${topicId}`)
})

// 取消转发话题
topic.post('/:id/unrepost', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const authProvider = await db.query.authProviders.findFirst({
    where: and(eq(authProviders.userId, user.id), eq(authProviders.providerType, 'mastodon')),
  })

  if (!authProvider?.accessToken) {
    return c.redirect(`/topic/${topicId}`)
  }

  const userDomain = authProvider.providerId.split('@')[1]
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const noteUrl = `${baseUrl}/ap/notes/${topicId}`

  try {
    const localStatusId = await resolveStatusByUrl(userDomain, authProvider.accessToken, noteUrl)
    if (!localStatusId) {
      console.error('Failed to resolve AP Note for unrepost:', noteUrl)
      return c.redirect(`/topic/${topicId}`)
    }

    await unreblogStatus(userDomain, authProvider.accessToken, localStatusId)

    await db
      .delete(topicReposts)
      .where(and(eq(topicReposts.topicId, topicId), eq(topicReposts.userId, user.id)))
  } catch (e) {
    console.error('Failed to unrepost topic to Mastodon:', e)
  }

  return c.redirect(`/topic/${topicId}`)
})

// 喜欢话题
topic.post('/:id/like', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 检查是否已喜欢
  const existingLike = await db
    .select()
    .from(topicLikes)
    .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))
    .limit(1)

  if (existingLike.length > 0) {
    await db
      .delete(topicLikes)
      .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))
  } else {
    await db.insert(topicLikes).values({
      id: generateId(),
      topicId,
      userId: user.id,
      createdAt: new Date(),
    })

    // 提醒话题作者
    const topicData = await db.select({ userId: topics.userId }).from(topics).where(eq(topics.id, topicId)).limit(1)
    if (topicData.length > 0) {
      await createNotification(db, {
        userId: topicData[0].userId,
        actorId: user.id,
        type: 'topic_like',
        topicId,
      })
    }
  }

  return c.redirect(`/topic/${topicId}`)
})

// 转发评论到 Mastodon
topic.post('/:id/comment/:commentId/repost', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')
  const commentId = c.req.param('commentId')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const commentResult = await db
    .select({ mastodonStatusId: comments.mastodonStatusId, mastodonDomain: comments.mastodonDomain })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1)

  if (commentResult.length === 0) {
    return c.redirect(`/topic/${topicId}`)
  }

  const authProvider = await db.query.authProviders.findFirst({
    where: and(eq(authProviders.userId, user.id), eq(authProviders.providerType, 'mastodon')),
  })

  if (!authProvider?.accessToken) {
    return c.redirect(`/topic/${topicId}`)
  }

  const userDomain = authProvider.providerId.split('@')[1]
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  try {
    let localStatusId: string | null = null

    if (commentResult[0].mastodonStatusId && commentResult[0].mastodonDomain) {
      // 有 Mastodon status → 跨实例 resolve
      localStatusId = await resolveStatusId(
        userDomain, authProvider.accessToken,
        commentResult[0].mastodonDomain, commentResult[0].mastodonStatusId
      )
    }

    if (!localStatusId) {
      // Fallback: 用 AP URL resolve
      const apUrl = `${baseUrl}/ap/comments/${commentId}`
      localStatusId = await resolveStatusByUrl(userDomain, authProvider.accessToken, apUrl)
    }

    if (!localStatusId) {
      console.error('Failed to resolve comment for repost')
      return c.redirect(`/topic/${topicId}#comment-${commentId}`)
    }
    await reblogStatus(userDomain, authProvider.accessToken, localStatusId)

    // 记录转发（避免重复）
    const existingRepost = await db
      .select()
      .from(commentReposts)
      .where(and(eq(commentReposts.commentId, commentId), eq(commentReposts.userId, user.id)))
      .limit(1)
    if (existingRepost.length === 0) {
      await db.insert(commentReposts).values({
        id: generateId(),
        commentId,
        userId: user.id,
        createdAt: new Date(),
      })

      // 提醒评论作者
      const commentData = await db
        .select({ userId: comments.userId })
        .from(comments)
        .where(eq(comments.id, commentId))
        .limit(1)
      if (commentData.length > 0) {
        await createNotification(db, {
          userId: commentData[0].userId,
          actorId: user.id,
          type: 'comment_repost',
          topicId,
          commentId,
        })
      }
    }
  } catch (e) {
    console.error('Failed to repost comment to Mastodon:', e)
  }

  return c.redirect(`/topic/${topicId}#comment-${commentId}`)
})

// 取消转发评论到 Mastodon
topic.post('/:id/comment/:commentId/unrepost', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')
  const commentId = c.req.param('commentId')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const commentResult = await db
    .select({ mastodonStatusId: comments.mastodonStatusId, mastodonDomain: comments.mastodonDomain })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1)

  if (commentResult.length === 0) {
    return c.redirect(`/topic/${topicId}`)
  }

  const authProvider = await db.query.authProviders.findFirst({
    where: and(eq(authProviders.userId, user.id), eq(authProviders.providerType, 'mastodon')),
  })

  if (!authProvider?.accessToken) {
    return c.redirect(`/topic/${topicId}`)
  }

  const userDomain = authProvider.providerId.split('@')[1]
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  try {
    let localStatusId: string | null = null

    if (commentResult[0].mastodonStatusId && commentResult[0].mastodonDomain) {
      localStatusId = await resolveStatusId(
        userDomain, authProvider.accessToken,
        commentResult[0].mastodonDomain, commentResult[0].mastodonStatusId
      )
    }

    if (!localStatusId) {
      const apUrl = `${baseUrl}/ap/comments/${commentId}`
      localStatusId = await resolveStatusByUrl(userDomain, authProvider.accessToken, apUrl)
    }

    if (!localStatusId) {
      console.error('Failed to resolve comment for unrepost')
      return c.redirect(`/topic/${topicId}#comment-${commentId}`)
    }

    await unreblogStatus(userDomain, authProvider.accessToken, localStatusId)

    await db
      .delete(commentReposts)
      .where(and(eq(commentReposts.commentId, commentId), eq(commentReposts.userId, user.id)))
  } catch (e) {
    console.error('Failed to unrepost comment to Mastodon:', e)
  }

  return c.redirect(`/topic/${topicId}#comment-${commentId}`)
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

    // 提醒评论作者
    await createNotification(db, {
      userId: commentResult[0].userId,
      actorId: user.id,
      type: 'comment_like',
      topicId,
      commentId,
    })
  }

  return c.redirect(`/topic/${topicId}#comment-${commentId}`)
})

// 编辑评论
topic.post('/:id/comment/:commentId/edit', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')
  const commentId = c.req.param('commentId')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const commentResult = await db
    .select()
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1)

  if (commentResult.length === 0 || commentResult[0].userId !== user.id) {
    return c.redirect(`/topic/${topicId}`)
  }

  const body = await c.req.parseBody()
  const content = body.content as string

  if (!content || !content.trim()) {
    return c.redirect(`/topic/${topicId}`)
  }

  await db.update(comments)
    .set({
      content: `<p>${content.trim().replace(/\n/g, '</p><p>')}</p>`,
      updatedAt: new Date(),
    })
    .where(eq(comments.id, commentId))

  return c.redirect(`/topic/${topicId}#comment-${commentId}`)
})

// 删除评论
topic.post('/:id/comment/:commentId/delete', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')
  const commentId = c.req.param('commentId')

  if (!user) return c.redirect('/auth/login')

  const comment = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1)
  if (comment.length === 0 || (comment[0].userId !== user.id && !isSuperAdmin(user))) {
    return c.redirect(`/topic/${topicId}`)
  }

  // 删除评论的点赞、转发记录，再删除评论
  await db.delete(commentLikes).where(eq(commentLikes.commentId, commentId))
  await db.delete(commentReposts).where(eq(commentReposts.commentId, commentId))
  await db.delete(comments).where(eq(comments.id, commentId))

  return c.redirect(`/topic/${topicId}`)
})

// 删除话题
topic.post('/:id/delete', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) return c.redirect('/auth/login')

  const topicResult = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicResult.length === 0) return c.redirect(`/topic/${topicId}`)

  const isAdmin = isSuperAdmin(user)
  if (topicResult[0].userId !== user.id && !isAdmin) {
    return c.redirect(`/topic/${topicId}`)
  }

  const groupId = topicResult[0].groupId

  // 普通用户：有评论时不允许删除
  if (!isAdmin) {
    const commentCount = await db.select({ count: sql<number>`count(*)` }).from(comments).where(eq(comments.topicId, topicId))
    if (commentCount[0].count > 0) {
      return c.redirect(`/topic/${topicId}`)
    }
  }

  // 超级管理员：级联删除评论点赞 → 评论 → 话题点赞 → 话题
  const topicComments = await db.select({ id: comments.id }).from(comments).where(eq(comments.topicId, topicId))
  for (const comment of topicComments) {
    await db.delete(commentLikes).where(eq(commentLikes.commentId, comment.id))
    await db.delete(commentReposts).where(eq(commentReposts.commentId, comment.id))
  }
  await db.delete(comments).where(eq(comments.topicId, topicId))
  await db.delete(topicLikes).where(eq(topicLikes.topicId, topicId))
  await db.delete(topicReposts).where(eq(topicReposts.topicId, topicId))
  await db.delete(topics).where(eq(topics.id, topicId))

  return c.redirect(`/group/${groupId}`)
})

// 编辑话题页面
topic.get('/:id/edit', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const topicResult = await db
    .select({
      id: topics.id,
      groupId: topics.groupId,
      userId: topics.userId,
      title: topics.title,
      content: topics.content,
      group: {
        id: groups.id,
        name: groups.name,
      },
    })
    .from(topics)
    .innerJoin(groups, eq(topics.groupId, groups.id))
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicResult.length === 0) {
    return c.notFound()
  }

  const topicData = topicResult[0]

  if (topicData.userId !== user.id) {
    return c.redirect(`/topic/${topicId}`)
  }

  return c.html(
    <Layout user={user} title={`编辑话题 - ${topicData.title}`} unreadCount={c.get('unreadNotificationCount')}>
      <link href="https://cdn.jsdelivr.net/npm/quill@2.0.2/dist/quill.snow.css" rel="stylesheet" />
      <div class="new-topic-page">
        <div class="page-header">
          <h1>编辑话题</h1>
          <p class="page-subtitle">
            <a href={`/group/${topicData.groupId}`}>{topicData.group.name}</a>
            {' · '}
            <a href={`/topic/${topicId}`}>返回话题</a>
          </p>
        </div>

        <form action={`/topic/${topicId}/edit`} method="POST" class="topic-form" id="topic-form">
          <div class="form-group">
            <label for="title">标题</label>
            <input type="text" id="title" name="title" required value={topicData.title} />
          </div>

          <div class="form-group">
            <label>内容</label>
            <div id="editor"></div>
            <input type="hidden" id="content" name="content" />
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-primary">保存修改</button>
            <a href={`/topic/${topicId}`} class="btn">取消</a>
          </div>
        </form>
      </div>

      <script src="https://cdn.jsdelivr.net/npm/quill@2.0.2/dist/quill.js"></script>
      <script dangerouslySetInnerHTML={{
        __html: `
        // NeoDB 卡片内部 HTML
        function buildNeoDBCardInner(data) {
          var img = data.coverUrl ? '<img src="' + data.coverUrl + '" alt="" />' : '';
          var rating = data.rating ? '<span class="neodb-card-rating">\\u2b50 ' + data.rating + '</span>' : '';
          var meta = [];
          if (data.year) meta.push(data.year);
          if (data.genre && data.genre.length) meta.push(data.genre.slice(0, 3).join(', '));
          var metaHtml = meta.length ? '<span class="neodb-card-meta">' + meta.join(' / ') + '</span>' : '';
          var brief = data.brief ? '<span class="neodb-card-brief">' + data.brief.slice(0, 100) + (data.brief.length > 100 ? '...' : '') + '</span>' : '';
          return '<a href="' + data.url + '" target="_blank" rel="noopener">'
            + img
            + '<span class="neodb-card-info">'
            + '<span class="neodb-card-title">' + data.title + '</span>'
            + rating + metaHtml + brief
            + '</span></a>';
        }

        // Toot 卡片内部 HTML
        function buildTootCardInner(data) {
          var avatar = data.authorAvatar ? '<img src="' + data.authorAvatar + '" alt="" class="toot-card-avatar" />' : '<div class="toot-card-avatar-placeholder"></div>';
          var images = '';
          if (data.attachments && data.attachments.length > 0) {
            images = '<div class="toot-card-images">' + data.attachments.slice(0, 2).map(function(a) {
              return '<img src="' + a.url + '" alt="' + (a.description || '') + '" />';
            }).join('') + '</div>';
          }
          var content = data.content || '';
          if (content.length > 200) content = content.slice(0, 200) + '...';
          return '<a href="' + data.url + '" target="_blank" rel="noopener" class="toot-card-link">'
            + '<div class="toot-card-header">'
            + avatar
            + '<div class="toot-card-author">'
            + '<span class="toot-card-name">' + (data.authorName || '') + '</span>'
            + '<span class="toot-card-handle">' + (data.authorHandle || '') + '</span>'
            + '</div>'
            + '</div>'
            + '<div class="toot-card-content">' + content + '</div>'
            + images
            + '<div class="toot-card-footer">'
            + '<span class="toot-card-domain">' + (data.domain || '') + '</span>'
            + '</div>'
            + '</a>';
        }

        // 注册自定义 NeoDB 卡片 Blot
        var BlockEmbed = Quill.import('blots/block/embed');
        class NeoDBCardBlot extends BlockEmbed {
          static create(data) {
            var node = super.create();
            node.setAttribute('contenteditable', 'false');
            node.dataset.neodb = JSON.stringify(data);
            node.innerHTML = buildNeoDBCardInner(data);
            return node;
          }
          static value(node) {
            try { return JSON.parse(node.dataset.neodb); } catch(e) { return {}; }
          }
        }
        NeoDBCardBlot.blotName = 'neodb-card';
        NeoDBCardBlot.tagName = 'DIV';
        NeoDBCardBlot.className = 'neodb-card';
        Quill.register(NeoDBCardBlot);

        // 注册自定义 Toot 卡片 Blot
        class TootCardBlot extends BlockEmbed {
          static create(data) {
            var node = super.create();
            node.setAttribute('contenteditable', 'false');
            node.dataset.toot = JSON.stringify(data);
            node.innerHTML = buildTootCardInner(data);
            return node;
          }
          static value(node) {
            try { return JSON.parse(node.dataset.toot); } catch(e) { return {}; }
          }
        }
        TootCardBlot.blotName = 'toot-card';
        TootCardBlot.tagName = 'DIV';
        TootCardBlot.className = 'toot-card';
        Quill.register(TootCardBlot);

        const quill = new Quill('#editor', {
          theme: 'snow',
          placeholder: '话题内容（可选）...',
          modules: {
            toolbar: [
              ['bold', 'italic', 'underline', 'strike'],
              ['blockquote', 'code-block'],
              [{ 'list': 'ordered'}, { 'list': 'bullet' }],
              ['link', 'image'],
              ['clean']
            ]
          }
        });

        // 加载已有内容
        var existingContent = ${JSON.stringify(topicData.content || '')};
        if (existingContent) {
          quill.root.innerHTML = existingContent;
        }

        // 图片上传处理
        quill.getModule('toolbar').addHandler('image', function() {
          var input = document.createElement('input');
          input.setAttribute('type', 'file');
          input.setAttribute('accept', 'image/*');
          input.click();
          input.onchange = async function() {
            var file = input.files[0];
            if (file) await uploadImage(file);
          };
        });

        // 添加 NeoDB 工具栏按钮
        (function() {
          var toolbarEl = document.querySelector('.ql-toolbar');
          var grp = document.createElement('span');
          grp.className = 'ql-formats';
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ql-neodb';
          btn.title = '插入 NeoDB 书影音链接';
          btn.addEventListener('click', function() {
            var url = prompt('请输入 NeoDB 链接（书影音游戏等）\\nhttps://neodb.social/movie/...');
            if (!url || !url.trim()) return;
            url = url.trim();
            if (!/neodb\\.social\\/(movie|book|tv|music|game|podcast|album)\\//.test(url)) {
              alert('请输入有效的 NeoDB 链接');
              return;
            }
            insertNeoDBLink(url);
          });
          grp.appendChild(btn);
          toolbarEl.appendChild(grp);
        })();

        async function insertNeoDBLink(url) {
          var range = quill.getSelection(true);
          var loadingText = '加载中...';
          quill.insertText(range.index, loadingText, { color: '#999' });
          try {
            var res = await fetch('/api/neodb?url=' + encodeURIComponent(url));
            var data = await res.json();
            quill.deleteText(range.index, loadingText.length);
            if (data.title) {
              quill.insertEmbed(range.index, 'neodb-card', data, Quill.sources.USER);
              quill.setSelection(range.index + 1);
            } else {
              quill.insertText(range.index, url, { link: url });
            }
          } catch (err) {
            quill.deleteText(range.index, loadingText.length);
            quill.insertText(range.index, url, { link: url });
          }
        }

        // 检测是否是 Mastodon toot URL
        function isMastodonTootUrl(url) {
          return /^https?:\\/\\/[^\\/]+\\/@[^\\/]+\\/\\d+\\/?$/.test(url) ||
                 /^https?:\\/\\/[^\\/]+\\/users\\/[^\\/]+\\/statuses\\/\\d+\\/?$/.test(url);
        }

        async function insertTootLink(url) {
          var range = quill.getSelection(true);
          var loadingText = '加载嘟文...';
          quill.insertText(range.index, loadingText, { color: '#999' });
          try {
            var res = await fetch('/api/toot-preview?url=' + encodeURIComponent(url));
            var data = await res.json();
            quill.deleteText(range.index, loadingText.length);
            if (data.authorHandle) {
              quill.insertEmbed(range.index, 'toot-card', data, Quill.sources.USER);
              quill.setSelection(range.index + 1);
            } else {
              quill.insertText(range.index, url, { link: url });
            }
          } catch (err) {
            quill.deleteText(range.index, loadingText.length);
            quill.insertText(range.index, url, { link: url });
          }
        }

        // 粘贴处理（NeoDB 链接 + Toot 链接 + 图片）- capture 阶段拦截，在 Quill 之前处理
        document.querySelector('#editor').addEventListener('paste', async function(e) {
          var text = (e.clipboardData ? e.clipboardData.getData('text/plain') : '') || '';
          text = text.trim();
          
          // 检查 NeoDB 链接
          if (text && /neodb\\.social\\/(movie|book|tv|music|game|podcast|album)\\//.test(text)) {
            e.preventDefault();
            e.stopPropagation();
            insertNeoDBLink(text);
            return;
          }
          
          // 检查 Mastodon toot 链接
          if (text && isMastodonTootUrl(text)) {
            e.preventDefault();
            e.stopPropagation();
            insertTootLink(text);
            return;
          }
          
          // 检查粘贴图片
          var items = e.clipboardData && e.clipboardData.items;
          if (!items) return;
          for (var i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image/') === 0) {
              e.preventDefault();
              e.stopPropagation();
              var file = items[i].getAsFile();
              if (file) await uploadImage(file);
              break;
            }
          }
        }, true);

        async function uploadImage(file) {
          var formData = new FormData();
          formData.append('image', file);
          try {
            var res = await fetch('/api/upload', { method: 'POST', body: formData });
            var data = await res.json();
            if (data.url) {
              var range = quill.getSelection(true);
              quill.insertEmbed(range.index, 'image', data.url);
              quill.setSelection(range.index + 1);
            }
          } catch (err) {
            console.error('Upload failed:', err);
            alert('图片上传失败');
          }
        }

        document.getElementById('topic-form').addEventListener('submit', function(e) {
          var content = quill.root.innerHTML;
          document.getElementById('content').value = content === '<p><br></p>' ? '' : content;
        });
      ` }} />
    </Layout>
  )
})

// 保存编辑话题
topic.post('/:id/edit', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const topicResult = await db
    .select()
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicResult.length === 0) {
    return c.notFound()
  }

  if (topicResult[0].userId !== user.id) {
    return c.redirect(`/topic/${topicId}`)
  }

  const body = await c.req.parseBody()
  const title = body.title as string
  const content = body.content as string

  if (!title || !title.trim()) {
    return c.redirect(`/topic/${topicId}/edit`)
  }

  await db.update(topics)
    .set({
      title: title.trim(),
      content: content?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(topics.id, topicId))

  return c.redirect(`/topic/${topicId}`)
})

export default topic
