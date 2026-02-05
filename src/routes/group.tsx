import { Hono } from 'hono'
import { eq, desc, sql, and } from 'drizzle-orm'
import type { AppContext } from '../types'
import { groups, groupMembers, topics, users, comments } from '../db/schema'
import { Layout } from '../components/Layout'
import { generateId, truncate, now, getExtensionFromUrl, getContentType, resizeImage } from '../lib/utils'

const group = new Hono<AppContext>()

group.get('/:id', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  // 获取小组详情
  const groupResult = await db
    .select({
      id: groups.id,
      creatorId: groups.creatorId,
      name: groups.name,
      description: groups.description,
      iconUrl: groups.iconUrl,
      createdAt: groups.createdAt,
      creator: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(groups)
    .innerJoin(users, eq(groups.creatorId, users.id))
    .where(eq(groups.id, groupId))
    .limit(1)

  if (groupResult.length === 0) {
    return c.notFound()
  }

  const groupData = groupResult[0]

  // 获取成员数
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
      .where(eq(groupMembers.groupId, groupId))
      .where(eq(groupMembers.userId, user.id))
      .limit(1)
    isMember = membership.length > 0
  }

  // 检查当前用户是否是创建者（管理员）
  const isCreator = user && user.id === groupData.creatorId

  // 获取小组话题（包含评论数）
  const topicList = await db
    .select({
      id: topics.id,
      title: topics.title,
      createdAt: topics.createdAt,
      updatedAt: topics.updatedAt,
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      },
      commentCount: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = ${topics.id})`.as('comment_count'),
    })
    .from(topics)
    .innerJoin(users, eq(topics.userId, users.id))
    .where(eq(topics.groupId, groupId))
    .orderBy(desc(topics.updatedAt))
    .limit(50)

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('zh-CN')
  }

  // 生成 metadata
  const description = groupData.description
    ? truncate(groupData.description, 160)
    : `${groupData.name} - NeoGroup 小组`
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const groupUrl = `${baseUrl}/group/${groupId}`

  return c.html(
    <Layout
      user={user}
      title={groupData.name}
      description={description}
      image={groupData.iconUrl}
      url={groupUrl}
    >
      <div class="group-detail">
        <div class="group-header">
          <img src={resizeImage(groupData.iconUrl, 160) || '/static/img/default-group.svg'} alt="" class="group-icon" />
          <div class="group-info">
            <h1>{groupData.name}</h1>
            {groupData.description && (
              <p class="group-description">{groupData.description}</p>
            )}
            <div class="group-meta">
              <span>{memberCount} 成员</span>
              <span>创建者: {groupData.creator.displayName || groupData.creator.username}</span>
            </div>
          </div>
          <div class="group-actions">
            {user && !isMember && (
              <form action={`/group/${groupId}/join`} method="POST">
                <button type="submit" class="btn btn-primary">加入小组</button>
              </form>
            )}
            {user && isMember && (
              <span class="member-badge">已加入</span>
            )}
            {isCreator && (
              <a href={`/group/${groupId}/settings`} class="btn" style="margin-left: 10px;">小组设置</a>
            )}
          </div>
        </div>

        <div class="group-content">
          <div class="group-topics">
            <div class="section-header">
              <h2>话题</h2>
              {user && isMember && (
                <a href={`/group/${groupId}/topic/new`} class="btn btn-primary">发布话题</a>
              )}
            </div>

            {topicList.length === 0 ? (
              <p class="no-content">暂无话题</p>
            ) : (
              <table class="topic-table">
                <thead>
                  <tr>
                    <th class="topic-table-title">讨论</th>
                    <th class="topic-table-author">作者</th>
                    <th class="topic-table-count">回复</th>
                    <th class="topic-table-date">最后回复</th>
                  </tr>
                </thead>
                <tbody>
                  {topicList.map((topic) => (
                    <tr key={topic.id}>
                      <td class="topic-table-title">
                        <a href={`/topic/${topic.id}`}>{topic.title}</a>
                      </td>
                      <td class="topic-table-author">
                        <a href={`/user/${topic.user.id}`}>
                          {topic.user.displayName || topic.user.username}
                        </a>
                      </td>
                      <td class="topic-table-count">{topic.commentCount}</td>
                      <td class="topic-table-date">{formatDate(topic.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
})

// 加入小组
group.post('/:id/join', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 检查小组是否存在
  const groupResult = await db
    .select()
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)

  if (groupResult.length === 0) {
    return c.notFound()
  }

  // 检查是否已加入
  const existing = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1)

  if (existing.length === 0) {
    await db.insert(groupMembers).values({
      id: generateId(),
      groupId,
      userId: user.id,
      createdAt: new Date(),
    })
  }

  return c.redirect(`/group/${groupId}`)
})

// 发布话题页面
group.get('/:id/topic/new', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 获取小组信息
  const groupResult = await db
    .select()
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)

  if (groupResult.length === 0) {
    return c.notFound()
  }

  const groupData = groupResult[0]

  // 检查是否是成员
  const membership = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1)

  if (membership.length === 0) {
    return c.redirect(`/group/${groupId}`)
  }

  return c.html(
    <Layout user={user} title={`发布话题 - ${groupData.name}`}>
      <div class="new-topic-page">
        <div class="page-header">
          <h1>发布新话题</h1>
          <p class="page-subtitle">发布到 <a href={`/group/${groupId}`}>{groupData.name}</a></p>
        </div>

        <form action={`/group/${groupId}/topic/new`} method="POST" class="topic-form">
          <div class="form-group">
            <label for="title">标题</label>
            <input type="text" id="title" name="title" required placeholder="话题标题" />
          </div>

          <div class="form-group">
            <label for="content">内容</label>
            <textarea id="content" name="content" rows={10} placeholder="话题内容（可选）"></textarea>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-primary">发布话题</button>
            <a href={`/group/${groupId}`} class="btn">取消</a>
          </div>
        </form>
      </div>
    </Layout>
  )
})

// 发布话题处理
group.post('/:id/topic/new', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 检查是否是成员
  const membership = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1)

  if (membership.length === 0) {
    return c.redirect(`/group/${groupId}`)
  }

  const body = await c.req.parseBody()
  const title = body.title as string
  const content = body.content as string

  if (!title || !title.trim()) {
    return c.redirect(`/group/${groupId}/topic/new`)
  }

  const topicId = generateId()
  const now = new Date()

  await db.insert(topics).values({
    id: topicId,
    groupId,
    userId: user.id,
    title: title.trim(),
    content: content ? `<p>${content.trim().replace(/\n/g, '</p><p>')}</p>` : null,
    type: 0,
    createdAt: now,
    updatedAt: now,
  })

  return c.redirect(`/topic/${topicId}`)
})

// 小组设置页面
group.get('/:id/settings', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 获取小组信息
  const groupResult = await db
    .select()
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)

  if (groupResult.length === 0) {
    return c.notFound()
  }

  const groupData = groupResult[0]

  // 检查是否是创建者
  if (groupData.creatorId !== user.id) {
    return c.redirect(`/group/${groupId}`)
  }

  return c.html(
    <Layout user={user} title={`小组设置 - ${groupData.name}`}>
      <div class="new-topic-page">
        <div class="page-header">
          <h1>小组设置</h1>
          <p class="page-subtitle">管理 <a href={`/group/${groupId}`}>{groupData.name}</a></p>
        </div>

        <form action={`/group/${groupId}/settings`} method="POST" enctype="multipart/form-data" class="topic-form">
          <div class="form-group">
            <label>当前头像</label>
            <div style="margin-bottom: 10px;">
              <img src={resizeImage(groupData.iconUrl, 160) || '/static/img/default-group.svg'} alt="" class="group-icon" style="width: 80px; height: 80px;" />
            </div>
            <label for="icon">更换头像</label>
            <input type="file" id="icon" name="icon" accept="image/*" />
            <p style="color: #999; font-size: 12px; margin-top: 5px;">支持 JPG、PNG、GIF、WebP 格式</p>
          </div>

          <div class="form-group">
            <label for="description">小组简介</label>
            <textarea id="description" name="description" rows={5} placeholder="介绍一下这个小组...">{groupData.description || ''}</textarea>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-primary">保存设置</button>
            <a href={`/group/${groupId}`} class="btn">取消</a>
          </div>
        </form>
      </div>
    </Layout>
  )
})

// 处理小组设置
group.post('/:id/settings', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 获取小组信息
  const groupResult = await db
    .select()
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)

  if (groupResult.length === 0) {
    return c.notFound()
  }

  const groupData = groupResult[0]

  // 检查是否是创建者
  if (groupData.creatorId !== user.id) {
    return c.redirect(`/group/${groupId}`)
  }

  const body = await c.req.parseBody()
  const description = body.description as string
  const iconFile = body.icon as File | undefined

  let iconUrl = groupData.iconUrl

  // 处理头像上传
  if (iconFile && iconFile.size > 0 && c.env.R2) {
    try {
      const buffer = await iconFile.arrayBuffer()
      const ext = getExtFromFile(iconFile.name, iconFile.type)
      const contentType = getContentType(ext)
      const key = `groups/${groupId}.${ext}`

      await c.env.R2.put(key, buffer, {
        httpMetadata: { contentType },
      })

      const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
      iconUrl = `${baseUrl}/r2/${key}`
    } catch (error) {
      console.error('Failed to upload group icon:', error)
    }
  }

  // 更新小组信息
  await db.update(groups)
    .set({
      description: description?.trim() || null,
      iconUrl,
      updatedAt: now(),
    })
    .where(eq(groups.id, groupId))

  return c.redirect(`/group/${groupId}`)
})

// 从文件名或 MIME 类型获取扩展名
function getExtFromFile(filename: string, mimeType: string): string {
  // 先尝试从文件名获取
  const match = filename.match(/\.(\w+)$/)
  if (match) {
    const ext = match[1].toLowerCase()
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      return ext === 'jpg' ? 'jpeg' : ext
    }
  }
  // 从 MIME 类型获取
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
  }
  return mimeMap[mimeType] || 'png'
}

export default group
