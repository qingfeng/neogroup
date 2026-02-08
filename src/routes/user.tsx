import { Hono } from 'hono'
import { eq, desc, sql, and, or, ne } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, topics, groups, comments, topicLikes, authProviders, userFollows, apFollowers } from '../db/schema'
import { Layout } from '../components/Layout'
import { stripHtml, truncate, resizeImage, getExtensionFromUrl, getContentType, escapeHtml, unescapeHtml, generateId } from '../lib/utils'
import { SafeHtml } from '../components/SafeHtml'
import { createNotification } from '../lib/notifications'

const user = new Hono<AppContext>()

function applyLimit<T>(query: T, n: number): any {
  // Defensive: avoid crashing if `.limit()` is missing due to runtime/bundler skew.
  const q: any = query as any
  return typeof q?.limit === 'function' ? q.limit(n) : q
}

function formatRemoteActor(actorUri: string): { handle: string; profileUrl: string | null } {
  try {
    const u = new URL(actorUri)
    const parts = u.pathname.split('/').filter(Boolean)
    const maybeUsername = parts[parts.length - 1]
    if (maybeUsername && maybeUsername !== 'users' && maybeUsername !== 'actors') {
      // Mastodon most commonly uses /users/:username as actor id, and /@:username as profile.
      return {
        handle: `@${maybeUsername}@${u.host}`,
        profileUrl: `https://${u.host}/@${maybeUsername}`,
      }
    }
    return { handle: actorUri, profileUrl: u.origin }
  } catch {
    return { handle: actorUri, profileUrl: null }
  }
}

async function getSelfRemoteActorUri(db: any, userId: string): Promise<string | null> {
  try {
    const ap = await db.query.authProviders.findFirst({
      where: and(eq(authProviders.userId, userId), eq(authProviders.providerType, 'mastodon')),
    })
    if (!ap?.metadata) return null
    const meta = JSON.parse(ap.metadata) as any
    return typeof meta?.uri === 'string' ? meta.uri : null
  } catch {
    return null
  }
}

// 关注
user.post('/:id/follow', async (c) => {
  const db = c.get('db')
  const currentUser = c.get('user')
  const rawId = c.req.param('id')

  if (!currentUser) return c.redirect('/auth/login')

  // 解析目标用户
  const target = await applyLimit(
    db.select().from(users).where(or(eq(users.username, rawId), eq(users.id, rawId))),
    1
  )
  if (target.length === 0 || target[0].id === currentUser.id) return c.redirect(`/user/${rawId}`)
  const followeeId = target[0].id

  // 已关注则忽略
  const exists = await applyLimit(
    db.select().from(userFollows)
      .where(and(eq(userFollows.followerId, currentUser.id), eq(userFollows.followeeId, followeeId))),
    1
  )
  if (exists.length === 0) {
    await db.insert(userFollows).values({
      id: generateId(),
      followerId: currentUser.id,
      followeeId,
      createdAt: new Date(),
    })
    try {
      await createNotification(db, {
        userId: followeeId,
        actorId: currentUser.id,
        type: 'follow',
      })
    } catch (e) {
      console.error('Failed to create follow notification:', e)
    }
  }

  return c.redirect(`/user/${target[0].username}`)
})

// 取消关注
user.post('/:id/unfollow', async (c) => {
  const db = c.get('db')
  const currentUser = c.get('user')
  const rawId = c.req.param('id')

  if (!currentUser) return c.redirect('/auth/login')

  const target = await applyLimit(
    db.select().from(users).where(or(eq(users.username, rawId), eq(users.id, rawId))),
    1
  )
  if (target.length === 0 || target[0].id === currentUser.id) return c.redirect(`/user/${rawId}`)
  const followeeId = target[0].id

  await db.delete(userFollows).where(and(eq(userFollows.followerId, currentUser.id), eq(userFollows.followeeId, followeeId)))

  return c.redirect(`/user/${target[0].username}`)
})

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
  let userResult = await applyLimit(
    db.select().from(users).where(eq(users.username, lookupName)),
    1
  )

  // If not found by username, try by ID
  if (userResult.length === 0) {
    userResult = await applyLimit(
      db.select().from(users).where(eq(users.id, rawId)),
      1
    )
  }

  if (userResult.length === 0) {
    return c.notFound()
  }

  const profileUser = userResult[0]
  const userId = profileUser.id
  const isOwnProfile = currentUser?.id === userId
  const isFollowing = currentUser
    ? (await applyLimit(
        db.select().from(userFollows)
          .where(and(eq(userFollows.followerId, currentUser.id), eq(userFollows.followeeId, userId))),
        1
      )).length > 0
    : false

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

  // 获取用户创建的小组
  const createdGroups = await applyLimit(
    db
      .select({
        id: groups.id,
        name: groups.name,
        iconUrl: groups.iconUrl,
        description: groups.description,
      })
      .from(groups)
      .where(eq(groups.creatorId, userId))
      .orderBy(desc(groups.createdAt)),
    10
  )

  // 获取用户发布的话题
  const userTopics = await applyLimit(
    db
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
      .orderBy(desc(topics.createdAt)),
    20
  )

  // 获取用户最近评论
  const userComments = await applyLimit(
    db
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
      .orderBy(desc(comments.createdAt)),
    10
  )

  // 获取用户喜欢的话题
  const likedTopics = await applyLimit(
    db
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
      .orderBy(desc(topicLikes.createdAt)),
    20
  )

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('zh-CN')
  }

  const selfRemoteActorUri = await getSelfRemoteActorUri(db, userId)

  // 关注 / 粉丝统计
  const followerLocal = await applyLimit(
    db
      .select({ count: sql<number>`count(*)` })
      .from(userFollows)
      .where(eq(userFollows.followeeId, userId)),
    1
  )
  const followerRemote = await applyLimit(
    db
      .select({ count: sql<number>`count(*)` })
      .from(apFollowers)
      .where(
        selfRemoteActorUri
          ? and(eq(apFollowers.userId, userId), ne(apFollowers.actorUri, selfRemoteActorUri))
          : eq(apFollowers.userId, userId)
      ),
    1
  )
  const followerCount = (followerLocal[0]?.count || 0) + (followerRemote[0]?.count || 0)

  const followingCountRow = await applyLimit(
    db
      .select({ count: sql<number>`count(*)` })
      .from(userFollows)
      .where(eq(userFollows.followerId, userId)),
    1
  )
  const followingCount = followingCountRow[0]?.count || 0

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
      image={profileUser.avatarUrl || `${baseUrl}/static/img/default-avatar.svg`}
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
            {!isOwnProfile && currentUser && (
              <form action={`/user/${profileUser.username}/${isFollowing ? 'unfollow' : 'follow'}`} method="POST" style="display:inline;margin-left:12px;">
                <button type="submit" class={`btn-secondary btn-sm ${isFollowing ? 'btn-muted' : ''}`}>
                  {isFollowing ? '已关注' : '关注'}
                </button>
              </form>
            )}
          </div>
        </div>
        </div>

        <div class="profile-content">
          <div class="profile-section">
            <h2>关注</h2>
            <a class="link" href={`/user/${profileUser.username}/following`}>查看关注 ({followingCount})</a>
            <span class="divider">·</span>
            <a class="link" href={`/user/${profileUser.username}/followers`}>查看被关注 ({followerCount})</a>
          </div>

          {createdGroups.length > 0 && (
            <div class="profile-section">
              <h2>创建的小组 ({createdGroups.length})</h2>
              <ul class="group-simple-list">
                {createdGroups.map((group) => (
                  <li key={group.id}>
                    <a href={`/group/${group.id}`} class="group-item">
                      <img src={group.iconUrl || '/static/img/default-group.svg'} alt="" class="group-icon-sm" />
                      <div>
                        <span class="group-name">{group.name}</span>
                        {group.description && <span class="group-desc">{group.description.slice(0, 50)}</span>}
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

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

// 关注列表
user.get('/:id/following', async (c) => {
  const db = c.get('db')
  const rawId = c.req.param('id')

  const target = await applyLimit(
    db.select().from(users).where(or(eq(users.username, rawId), eq(users.id, rawId))),
    1
  )
  if (target.length === 0) return c.notFound()
  const profileUser = target[0]

  const following = await applyLimit(
    db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(userFollows)
      .innerJoin(users, eq(userFollows.followeeId, users.id))
      .where(eq(userFollows.followerId, profileUser.id))
      .orderBy(desc(userFollows.createdAt)),
    200
  )

  return c.html(
    <Layout user={c.get('user')} title={`关注 - ${profileUser.username}`} unreadCount={c.get('unreadNotificationCount')}>
      <div class="profile-list-page">
        <h1>@{profileUser.username} 关注了 ({following.length})</h1>
        {following.length === 0 ? (
          <p class="no-content">还没有关注任何人</p>
        ) : (
          <ul class="people-grid">
            {following.map(u => (
              <li key={u.id}>
                <a href={`/user/${u.username}`} class="people-card">
                  <img src={u.avatarUrl || '/static/img/default-avatar.svg'} alt="" class="avatar-sm" />
                  <div class="person-meta">
                    <span class="person-name">{u.displayName || u.username}</span>
                    <span class="person-handle">@{u.username}</span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Layout>
  )
})

// 被关注列表（含远程）
user.get('/:id/followers', async (c) => {
  const db = c.get('db')
  const rawId = c.req.param('id')

  const target = await applyLimit(
    db.select().from(users).where(or(eq(users.username, rawId), eq(users.id, rawId))),
    1
  )
  if (target.length === 0) return c.notFound()
  const profileUser = target[0]

  // Exclude user's own remote actor from the list to avoid showing "yourself" as a follower.
  const selfRemoteActorUri = await getSelfRemoteActorUri(db, profileUser.id)

  const localFollowers = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      createdAt: userFollows.createdAt,
    })
    .from(userFollows)
    .innerJoin(users, eq(userFollows.followerId, users.id))
    .where(eq(userFollows.followeeId, profileUser.id))

  const remoteFollowers = await db
    .select({
      actorUri: apFollowers.actorUri,
      inboxUrl: apFollowers.inboxUrl,
      sharedInboxUrl: apFollowers.sharedInboxUrl,
      createdAt: apFollowers.createdAt,
    })
    .from(apFollowers)
    .where(eq(apFollowers.userId, profileUser.id))

  const remoteFollowersFiltered = selfRemoteActorUri
    ? remoteFollowers.filter(f => f.actorUri !== selfRemoteActorUri)
    : remoteFollowers

  // Merge lists, sort by createdAt desc
  const merged = [
    ...localFollowers.map(f => ({
      type: 'local' as const,
      createdAt: f.createdAt,
      id: f.id,
      username: f.username,
      displayName: f.displayName,
      avatarUrl: f.avatarUrl,
    })),
    ...remoteFollowersFiltered.map(f => {
      const formatted = formatRemoteActor(f.actorUri)
      return ({
      type: 'remote' as const,
      createdAt: f.createdAt,
      actorUri: f.actorUri,
      handle: formatted.handle,
      profileUrl: formatted.profileUrl,
      })
    }),
  ].sort((a, b) => (b.createdAt as any) - (a.createdAt as any))

  return c.html(
    <Layout user={c.get('user')} title={`被关注 - ${profileUser.username}`} unreadCount={c.get('unreadNotificationCount')}>
      <div class="profile-list-page">
        <h1>关注 @{profileUser.username} 的人 ({merged.length})</h1>
        {merged.length === 0 ? (
          <p class="no-content">还没有粉丝</p>
        ) : (
          <ul class="people-grid">
            {merged.map((f, idx) => (
              <li key={idx}>
                {f.type === 'local' ? (
                  <a href={`/user/${f.username}`} class="people-card">
                    <img src={f.avatarUrl || '/static/img/default-avatar.svg'} alt="" class="avatar-sm" />
                    <div class="person-meta">
                      <span class="person-name">{f.displayName || f.username}</span>
                      <span class="person-handle">@{f.username}</span>
                    </div>
                  </a>
                ) : (
                  <a
                    href={(f as any).profileUrl || (f as any).actorUri}
                    class="people-card"
                    target="_blank"
                    rel="noopener"
                  >
                    <img src={'/static/img/default-avatar.svg'} alt="" class="avatar-sm" />
                    <div class="person-meta">
                      <span class="person-name">远程用户</span>
                      <span class="person-handle">{(f as any).handle || (f as any).actorUri}</span>
                    </div>
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
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

  const userResultLimited = await applyLimit(
    db.select().from(users).where(eq(users.id, userId)),
    1
  )

  if (userResultLimited.length === 0) {
    return c.notFound()
  }

  const profileUser = userResultLimited[0]

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
