import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, topics, groups, comments, topicLikes, authProviders } from '../db/schema'
import { Layout } from '../components/Layout'
import { stripHtml, truncate, resizeImage } from '../lib/utils'

const user = new Hono<AppContext>()

user.get('/:id', async (c) => {
  const db = c.get('db')
  const currentUser = c.get('user')
  const userId = c.req.param('id')

  // 获取用户信息
  const userResult = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (userResult.length === 0) {
    return c.notFound()
  }

  const profileUser = userResult[0]

  // 获取 Mastodon 账号信息
  let mastodonHandle: string | null = null
  let mastodonUrl: string | null = null
  const authProvider = await db.query.authProviders.findFirst({
    where: eq(authProviders.userId, userId),
  })
  if (authProvider?.providerType === 'mastodon' && authProvider.metadata) {
    try {
      const meta = JSON.parse(authProvider.metadata) as { username: string; url: string }
      const domain = authProvider.providerId.split('@')[1]
      if (meta.username && domain) {
        mastodonHandle = `@${meta.username}@${domain}`
        mastodonUrl = meta.url || `https://${domain}/@${meta.username}`
      }
    } catch {}
  }

  // 获取用户发布的话题
  const userTopics = await db
    .select({
      id: topics.id,
      title: topics.title,
      createdAt: topics.createdAt,
      group: {
        id: groups.id,
        name: groups.name,
      },
    })
    .from(topics)
    .innerJoin(groups, eq(topics.groupId, groups.id))
    .where(eq(topics.userId, userId))
    .orderBy(desc(topics.createdAt))
    .limit(20)

  // 获取用户最近评论
  const userComments = await db
    .select({
      id: comments.id,
      content: comments.content,
      createdAt: comments.createdAt,
      topic: {
        id: topics.id,
        title: topics.title,
      },
    })
    .from(comments)
    .innerJoin(topics, eq(comments.topicId, topics.id))
    .where(eq(comments.userId, userId))
    .orderBy(desc(comments.createdAt))
    .limit(10)

  // 获取用户喜欢的话题
  const likedTopics = await db
    .select({
      id: topics.id,
      title: topics.title,
      likedAt: topicLikes.createdAt,
      group: {
        id: groups.id,
        name: groups.name,
      },
    })
    .from(topicLikes)
    .innerJoin(topics, eq(topicLikes.topicId, topics.id))
    .innerJoin(groups, eq(topics.groupId, groups.id))
    .where(eq(topicLikes.userId, userId))
    .orderBy(desc(topicLikes.createdAt))
    .limit(20)

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('zh-CN')
  }

  // 生成 metadata
  const displayName = profileUser.displayName || profileUser.username
  const description = profileUser.bio
    ? truncate(stripHtml(profileUser.bio), 160)
    : `${displayName} 的个人主页 - NeoGroup`
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const userUrl = `${baseUrl}/user/${userId}`

  return c.html(
    <Layout
      user={currentUser}
      title={displayName}
      description={description}
      image={profileUser.avatarUrl}
      url={userUrl}
    >
      <div class="user-profile">
        <div class="profile-header">
          <img
            src={resizeImage(profileUser.avatarUrl, 128) || '/static/img/default-avatar.svg'}
            alt=""
            class="avatar-lg"
          />
          <div class="profile-info">
            <h1>{profileUser.displayName || profileUser.username}</h1>
            {mastodonHandle && mastodonUrl ? (
              <div class="profile-username">
                <a href={mastodonUrl} target="_blank" rel="noopener">{mastodonHandle}</a>
              </div>
            ) : (
              <div class="profile-username">@{profileUser.username}</div>
            )}
            {profileUser.bio && (
              <div class="profile-bio" dangerouslySetInnerHTML={{ __html: profileUser.bio }} />
            )}
            <div class="profile-meta">
              加入于 {formatDate(profileUser.createdAt)}
            </div>
          </div>
        </div>

        <div class="profile-content">
          <div class="profile-section">
            <h2>发布的话题 ({userTopics.length})</h2>
            {userTopics.length === 0 ? (
              <p class="no-content">暂无话题</p>
            ) : (
              <ul class="topic-simple-list">
                {userTopics.map((topic) => (
                  <li key={topic.id}>
                    <a href={`/topic/${topic.id}`}>{topic.title}</a>
                    <span class="meta">
                      <a href={`/group/${topic.group.id}`}>{topic.group.name}</a>
                      · {formatDate(topic.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div class="profile-section">
            <h2>最近评论 ({userComments.length})</h2>
            {userComments.length === 0 ? (
              <p class="no-content">暂无评论</p>
            ) : (
              <ul class="comment-simple-list">
                {userComments.map((comment) => (
                  <li key={comment.id}>
                    <div class="comment-preview">{comment.content.replace(/<[^>]*>/g, '').slice(0, 100)}</div>
                    <span class="meta">
                      评论于 <a href={`/topic/${comment.topic.id}`}>{comment.topic.title}</a>
                      · {formatDate(comment.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div class="profile-section">
            <h2>喜欢的话题 ({likedTopics.length})</h2>
            {likedTopics.length === 0 ? (
              <p class="no-content">暂无喜欢</p>
            ) : (
              <ul class="topic-simple-list">
                {likedTopics.map((topic) => (
                  <li key={topic.id}>
                    <a href={`/topic/${topic.id}`}>{topic.title}</a>
                    <span class="meta">
                      <a href={`/group/${topic.group.id}`}>{topic.group.name}</a>
                      · {formatDate(topic.likedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
})

export default user
