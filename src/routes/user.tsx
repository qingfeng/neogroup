import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, topics, groups, comments, topicLikes, authProviders } from '../db/schema'
import { Layout } from '../components/Layout'
import { stripHtml, truncate, resizeImage, getExtensionFromUrl, getContentType, escapeHtml, unescapeHtml } from '../lib/utils'
import { SafeHtml } from '../components/SafeHtml'

const user = new Hono<AppContext>()

user.get('/:id', async (c) => {
  const db = c.get('db')
  const currentUser = c.get('user')
  const rawId = c.req.param('id')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const host = new URL(baseUrl).host

  // Support multiple lookup formats:
  // 1. User ID: /user/9hhVvIB2BRAR
  // 2. Username: /user/qingfeng
  // 3. AP handle: /user/@qingfeng@neogrp.club
  let lookupName = rawId

  // Check for @username@domain format
  const apHandleMatch = rawId.match(/^@?([^@]+)@(.+)$/)
  if (apHandleMatch) {
    const [, parsedUsername, domain] = apHandleMatch
    // Only accept handles for our own domain
    if (domain === host) {
      lookupName = parsedUsername
    } else {
      // External domain - not found
      return c.notFound()
    }
  } else if (rawId.startsWith('@')) {
    // @username format (without domain)
    lookupName = rawId.slice(1)
  }

  // Try to find by username first
  let userResult = await db
    .select()
    .from(users)
    .where(eq(users.username, lookupName))
    .limit(1)

  // If not found by username, try by ID
  if (userResult.length === 0) {
    userResult = await db
      .select()
      .from(users)
      .where(eq(users.id, rawId))
      .limit(1)
  }

  if (userResult.length === 0) {
    return c.notFound()
  }

  const profileUser = userResult[0]
  const userId = profileUser.id
  const isOwnProfile = currentUser?.id === userId

  // 获取 Mastodon 账号信息
  let mastodonHandle: string | null = null
  let mastodonUrl: string | null = null
  let apUsername: string | null = null
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
        apUsername = meta.username
      }
    } catch { }
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
  const userUrl = `${baseUrl}/user/${profileUser.username}`

  return c.html(
    <Layout
      user={currentUser}
      title={displayName}
      description={description}
      image={profileUser.avatarUrl || undefined}
      url={userUrl}
      unreadCount={c.get('unreadNotificationCount')}
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
            <div class="profile-username ap-handle">
              @{profileUser.username}@{new URL(baseUrl).host}
            </div>
            {profileUser.bio && (
              <SafeHtml html={profileUser.bio} className="profile-bio" />
            )}
            <div class="profile-meta">
              加入于 {formatDate(profileUser.createdAt)}
              {isOwnProfile && (
                <a href={`/user/${userId}/edit`} class="edit-profile-link">编辑资料</a>
              )}
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

// 编辑资料页面
user.get('/:id/edit', async (c) => {
  const db = c.get('db')
  const currentUser = c.get('user')
  const userId = c.req.param('id')

  // 必须登录且只能编辑自己的资料
  if (!currentUser || currentUser.id !== userId) {
    return c.redirect(`/user/${userId}`)
  }

  const userResult = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (userResult.length === 0) {
    return c.notFound()
  }

  const profileUser = userResult[0]

  return c.html(
    <Layout
      user={currentUser}
      title="编辑资料"
      unreadCount={c.get('unreadNotificationCount')}
    >
      <div class="edit-profile-page">
        <h1>编辑资料</h1>
        <form action={`/user/${userId}/edit`} method="post" enctype="multipart/form-data" class="edit-profile-form">
          <div class="form-group">
            <label>头像</label>
            <div class="avatar-upload">
              <img
                src={resizeImage(profileUser.avatarUrl, 128) || '/static/img/default-avatar.svg'}
                alt=""
                class="avatar-preview"
                id="avatarPreview"
              />
              <input type="file" name="avatar" accept="image/*" id="avatarInput" />
              <p class="form-hint">支持 JPG、PNG、GIF，最大 2MB</p>
            </div>
          </div>

          <div class="form-group">
            <label for="displayName">昵称</label>
            <input
              type="text"
              name="displayName"
              id="displayName"
              value={profileUser.displayName || ''}
              placeholder="显示的名称"
              maxLength={50}
            />
          </div>

          <div class="form-group">
            <label for="bio">简介</label>
            <textarea
              name="bio"
              id="bio"
              rows={4}
              placeholder="介绍一下自己..."
              maxLength={500}
            >{unescapeHtml(stripHtml(profileUser.bio || ''))}</textarea>
            <p class="form-hint">最多 500 字</p>
          </div>

          <div class="form-actions">
            <a href={`/user/${userId}`} class="btn-secondary">取消</a>
            <button type="submit" class="btn-primary">保存</button>
          </div>
        </form>
      </div>

      <script dangerouslySetInnerHTML={{
        __html: `
          document.getElementById('avatarInput').addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
              const reader = new FileReader();
              reader.onload = function(e) {
                document.getElementById('avatarPreview').src = e.target.result;
              };
              reader.readAsDataURL(file);
            }
          });
        `
      }} />
    </Layout>
  )
})

// 保存资料
user.post('/:id/edit', async (c) => {
  const db = c.get('db')
  const currentUser = c.get('user')
  const userId = c.req.param('id')
  const r2 = c.env.R2

  // 必须登录且只能编辑自己的资料
  if (!currentUser || currentUser.id !== userId) {
    return c.redirect(`/user/${userId}`)
  }

  const formData = await c.req.formData()
  const displayName = (formData.get('displayName') as string || '').trim().slice(0, 50)
  const bioText = (formData.get('bio') as string || '').trim().slice(0, 500)
  const avatarFile = formData.get('avatar') as File | null

  // 处理 bio：将纯文本转换为 HTML 段落（先转义特殊字符）
  const bio = bioText
    ? bioText.split('\n').filter(line => line.trim()).map(line => `<p>${escapeHtml(line)}</p>`).join('')
    : null

  let avatarUrl: string | undefined

  // 处理头像上传
  if (avatarFile && avatarFile.size > 0 && r2) {
    // 验证文件大小（2MB）
    if (avatarFile.size > 2 * 1024 * 1024) {
      return c.redirect(`/user/${userId}/edit?error=文件过大`)
    }

    // 验证文件类型
    const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    if (!validTypes.includes(avatarFile.type)) {
      return c.redirect(`/user/${userId}/edit?error=不支持的文件类型`)
    }

    try {
      const buffer = await avatarFile.arrayBuffer()
      const ext = getExtensionFromUrl(avatarFile.name) || 'png'
      const contentType = getContentType(ext)
      const key = `avatars/${userId}.${ext}`

      await r2.put(key, buffer, {
        httpMetadata: { contentType },
      })

      const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
      avatarUrl = `${baseUrl}/r2/${key}`
    } catch (error) {
      console.error('Failed to upload avatar:', error)
    }
  }

  // 更新用户信息
  const updateData: Record<string, unknown> = {
    displayName: displayName || null,
    bio,
    updatedAt: new Date(),
  }

  if (avatarUrl) {
    updateData.avatarUrl = avatarUrl
  }

  await db.update(users).set(updateData).where(eq(users.id, userId))

  return c.redirect(`/user/${userId}`)
})

export default user
