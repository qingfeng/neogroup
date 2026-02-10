import { Hono } from 'hono'
import { eq, desc, sql, and } from 'drizzle-orm'
import type { AppContext } from '../types'
import { groups, groupMembers, topics, users, comments, authProviders, remoteGroups } from '../db/schema'
import { Layout } from '../components/Layout'
import { generateId, truncate, now, getExtensionFromUrl, getContentType, resizeImage, stripHtml } from '../lib/utils'
import { postStatus } from '../services/mastodon'
import { deliverTopicToFollowers, announceToGroupFollowers, getNoteJson, discoverRemoteGroup, ensureKeyPair, signAndDeliver, getApUsername } from '../services/activitypub'
import { buildSignedEvent } from '../services/nostr'

const group = new Hono<AppContext>()

// 按标签筛选小组
group.get('/tag/:tag', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const tag = decodeURIComponent(c.req.param('tag'))

  const allGroups = await db
    .select({
      id: groups.id,
      creatorId: groups.creatorId,
      name: groups.name,
      description: groups.description,
      tags: groups.tags,
      iconUrl: groups.iconUrl,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
      memberCount: sql<number>`(SELECT COUNT(*) FROM group_member WHERE group_member.group_id = ${groups.id})`.as('member_count'),
    })
    .from(groups)
    .where(sql`${groups.tags} IS NOT NULL AND ${groups.tags} != ''`)

  const matchedGroups = allGroups.filter(g =>
    g.tags!.split(/\s+/).some(t => t === tag)
  )

  return c.html(
    <Layout user={user} title={`标签: ${tag}`} unreadCount={c.get('unreadNotificationCount')}>
      <div class="group-detail">
        <div class="group-content">
          <div class="section-header">
            <h2>标签「{tag}」的小组</h2>
          </div>
          {matchedGroups.length === 0 ? (
            <p class="no-content">暂无小组</p>
          ) : (
            <div class="tag-group-list">
              {matchedGroups.map((g) => (
                <div class="tag-group-item">
                  <img src={g.iconUrl || '/static/img/default-group.svg'} alt="" class="tag-group-icon" />
                  <div class="tag-group-info">
                    <a href={`/group/${g.id}`} class="tag-group-name">{g.name}</a>
                    {g.description && <p class="tag-group-desc">{truncate(g.description, 80)}</p>}
                    <span class="card-meta">{g.memberCount} 成员</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  )
})

// 创建小组页面
group.get('/create', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/login')

  return c.html(
    <Layout user={user} title="创建小组" unreadCount={c.get('unreadNotificationCount')}>
      <div class="new-topic-page">
        <div class="page-header">
          <h1>创建小组</h1>
        </div>
        <form action="/group/create" method="POST" enctype="multipart/form-data" class="topic-form">
          <div class="form-group">
            <label for="name">小组名称</label>
            <input type="text" id="name" name="name" placeholder="给小组取个名字" required />
          </div>
          <div class="form-group">
            <label for="icon">小组 LOGO</label>
            <input type="file" id="icon" name="icon" accept="image/*" />
            <p style="color: #999; font-size: 12px; margin-top: 5px;">支持 JPG、PNG、GIF、WebP 格式</p>
          </div>
          <div class="form-group">
            <label for="description">小组简介</label>
            <textarea id="description" name="description" rows={3} placeholder="介绍一下这个小组..."></textarea>
          </div>
          <div class="form-group">
            <label for="tags">分类标签 <span style="color: #999; font-weight: normal;">(空格分隔)</span></label>
            <input type="text" id="tags" name="tags" placeholder="如：电影 读书 音乐" />
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">创建小组</button>
            <a href="/" class="btn">取消</a>
          </div>
        </form>
      </div>
    </Layout>
  )
})

// 创建小组处理
group.post('/create', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) return c.redirect('/auth/login')

  const body = await c.req.parseBody()
  const name = (body.name as string)?.trim()
  const description = (body.description as string)?.trim() || null
  const tags = (body.tags as string)?.trim() || null
  const iconFile = body.icon as File | undefined

  if (!name) return c.redirect('/group/create')

  const groupId = generateId()
  const timestamp = now()
  let iconUrl: string | null = null

  // 处理 LOGO 上传
  if (iconFile && iconFile.size > 0 && c.env.R2) {
    try {
      const buffer = await iconFile.arrayBuffer()
      const ext = getExtFromFile(iconFile.name, iconFile.type)
      const contentType = getContentType(ext)
      const key = `groups/${groupId}.${ext}`
      await c.env.R2.put(key, buffer, { httpMetadata: { contentType } })
      const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
      iconUrl = `${baseUrl}/r2/${key}`
    } catch (error) {
      console.error('Failed to upload group icon:', error)
    }
  }

  await db.insert(groups).values({
    id: groupId,
    creatorId: user.id,
    name,
    description,
    tags,
    iconUrl,
    createdAt: timestamp,
    updatedAt: timestamp,
  })

  // 创建者自动加入小组
  await db.insert(groupMembers).values({
    id: generateId(),
    groupId,
    userId: user.id,
    createdAt: timestamp,
  })

  return c.redirect(`/group/${groupId}`)
})

// 搜索远程社区
group.get('/search', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/login')

  const db = c.get('db')
  const query = c.req.query('q') || ''
  let result: Awaited<ReturnType<typeof discoverRemoteGroup>> = null
  let error: string | null = null
  let existingGroupId: string | null = null

  if (query) {
    result = await discoverRemoteGroup(query)
    if (!result) {
      error = '未找到远程社区，请检查地址格式（如 @board@kyoto.neogrp.club）'
    } else {
      // Check if already mirrored
      const existing = await db.select({ localGroupId: remoteGroups.localGroupId })
        .from(remoteGroups)
        .where(eq(remoteGroups.actorUri, result.actorUri))
        .limit(1)
      if (existing.length > 0) {
        existingGroupId = existing[0].localGroupId
      }
    }
  }

  // Fetch all existing remote groups
  const existingRemoteGroups = await db.select({
    localGroupId: remoteGroups.localGroupId,
    domain: remoteGroups.domain,
    actorUri: remoteGroups.actorUri,
    groupName: groups.name,
    groupIcon: groups.iconUrl,
    groupDescription: groups.description,
  })
    .from(remoteGroups)
    .innerJoin(groups, eq(remoteGroups.localGroupId, groups.id))
    .orderBy(desc(remoteGroups.createdAt))

  return c.html(
    <Layout user={user} title="搜索远程社区" unreadCount={c.get('unreadNotificationCount')}>
      <div class="new-topic-page">
        <div class="page-header">
          <h1>搜索远程社区</h1>
          <p class="page-subtitle">输入远程 NeoGroup 社区的联邦地址</p>
        </div>

        <form action="/group/search" method="get" class="topic-form" style="margin-bottom: 2rem;">
          <div class="form-group">
            <label for="q">社区地址</label>
            <input type="text" id="q" name="q" value={query} placeholder="@board@kyoto.neogrp.club" required />
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">搜索</button>
            <a href="/" class="btn">取消</a>
          </div>
        </form>

        {error && <p style="color: #c00; margin-bottom: 1rem;">{error}</p>}

        {result && (
          <div class="group-header" style="margin-bottom: 2rem;">
            <img src={result.iconUrl || '/static/img/default-group.svg'} alt="" class="group-icon" />
            <div class="group-info">
              <h2>{result.name}</h2>
              {result.description && <p class="group-description">{result.description}</p>}
              <div class="group-meta">
                <span style="background: #e8f0fe; padding: 2px 8px; border-radius: 4px; font-family: monospace; font-size: 13px;">
                  @{result.preferredUsername}@{result.domain}
                </span>
              </div>
            </div>
            <div class="group-actions">
              {existingGroupId ? (
                <a href={`/group/${existingGroupId}`} class="btn btn-primary">查看社区</a>
              ) : (
                <form action="/group/search" method="post">
                  <input type="hidden" name="handle" value={query} />
                  <button type="submit" class="btn btn-primary">关注</button>
                </form>
              )}
            </div>
          </div>
        )}

        {existingRemoteGroups.length > 0 && (
          <div style="margin-top: 2rem;">
            <h2 style="margin-bottom: 1rem;">已关注的远程社区</h2>
            <div class="group-list">
              {existingRemoteGroups.map(rg => (
                <a href={`/group/${rg.localGroupId}`} class="group-card" key={rg.localGroupId}>
                  <img src={rg.groupIcon || '/static/img/default-group.svg'} alt="" class="group-icon" />
                  <div class="group-info">
                    <h3>{rg.groupName}</h3>
                    {rg.groupDescription && <p class="group-description">{rg.groupDescription}</p>}
                    <span style="background: #e8f0fe; padding: 2px 8px; border-radius: 4px; font-family: monospace; font-size: 12px;">
                      {rg.domain}
                    </span>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
})

// 执行关注远程社区
group.post('/search', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/login')

  const db = c.get('db')
  const body = await c.req.parseBody()
  const handle = (body.handle as string)?.trim()

  if (!handle) return c.redirect('/group/search')

  const info = await discoverRemoteGroup(handle)
  if (!info) return c.redirect('/group/search?q=' + encodeURIComponent(handle))

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // Check if remote_group already exists
  const existing = await db.select({ localGroupId: remoteGroups.localGroupId })
    .from(remoteGroups)
    .where(eq(remoteGroups.actorUri, info.actorUri))
    .limit(1)

  let localGroupId: string

  if (existing.length > 0) {
    localGroupId = existing[0].localGroupId
  } else {
    // Create local mirror group
    localGroupId = generateId()
    const timestamp = now()

    await db.insert(groups).values({
      id: localGroupId,
      creatorId: user.id,
      name: `${info.name} (@${info.preferredUsername}@${info.domain})`,
      description: info.description,
      iconUrl: info.iconUrl,
      createdAt: timestamp,
      updatedAt: timestamp,
    })

    await db.insert(remoteGroups).values({
      id: generateId(),
      localGroupId,
      actorUri: info.actorUri,
      inboxUrl: info.inbox,
      sharedInboxUrl: info.sharedInbox,
      domain: info.domain,
      createdAt: timestamp,
    })
  }

  // Check if user is already a member
  const existingMember = await db.select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, localGroupId), eq(groupMembers.userId, user.id)))
    .limit(1)

  if (existingMember.length === 0) {
    await db.insert(groupMembers).values({
      id: generateId(),
      groupId: localGroupId,
      userId: user.id,
      followStatus: 'pending',
      createdAt: now(),
    })

    // Send AP Follow to remote group
    const apUsername = await getApUsername(db, user.id)
    if (apUsername) {
      const { privateKeyPem } = await ensureKeyPair(db, user.id)
      const actorUrl = `${baseUrl}/ap/users/${apUsername}`

      const followActivity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${actorUrl}#follow-${Date.now()}`,
        type: 'Follow',
        actor: actorUrl,
        object: info.actorUri,
      }

      c.executionCtx.waitUntil(
        signAndDeliver(actorUrl, privateKeyPem, info.inbox, followActivity)
          .catch(e => console.error('[Remote Group] Follow delivery failed:', e))
      )
    }
  }

  return c.redirect(`/group/${localGroupId}`)
})

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
      tags: groups.tags,
      actorName: groups.actorName,
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

  // 检查是否是镜像（远程）小组
  const remoteGroupResult = await db.select()
    .from(remoteGroups)
    .where(eq(remoteGroups.localGroupId, groupId))
    .limit(1)
  const isRemoteGroup = remoteGroupResult.length > 0
  const remoteGroupInfo = remoteGroupResult[0] || null

  // 检查当前用户是否是成员
  let isMember = false
  let memberFollowStatus: string | null = null
  if (user) {
    const membership = await db
      .select({ id: groupMembers.id, followStatus: groupMembers.followStatus })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
      .limit(1)
    isMember = membership.length > 0
    memberFollowStatus = membership.length > 0 ? membership[0].followStatus : null
  }

  // 检查当前用户是否是创建者（管理员）
  const isCreator = user && user.id === groupData.creatorId && !isRemoteGroup

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
      image={groupData.iconUrl || `${baseUrl}/static/img/default-group.svg`}
      url={groupUrl}
      unreadCount={c.get('unreadNotificationCount')}
    >
      <div class="group-detail">
        <div class="group-header">
          <img src={resizeImage(groupData.iconUrl, 160) || '/static/img/default-group.svg'} alt="" class="group-icon" />
          <div class="group-info">
            <h1>{groupData.name}</h1>
            {isRemoteGroup && remoteGroupInfo && (
              <div style="margin-bottom: 8px;">
                <span style="background: #e8f0fe; padding: 2px 8px; border-radius: 4px; font-size: 12px; color: #1a73e8;">
                  远程社区 from {remoteGroupInfo.domain}
                </span>
              </div>
            )}
            {groupData.description && (
              <p class="group-description">{groupData.description}</p>
            )}
            <div class="group-meta">
              <span>{memberCount} 成员</span>
              {!isRemoteGroup && (
                <span>创建者: {groupData.creator.displayName || groupData.creator.username}</span>
              )}
            </div>
            {groupData.tags && (
              <div class="group-tags">
                {groupData.tags.split(/\s+/).filter(Boolean).map(tag => (
                  <span class="group-tag">{tag}</span>
                ))}
              </div>
            )}
            {!isRemoteGroup && groupData.actorName && (
              <div class="group-federation" style="margin-top: 8px; color: #666; font-size: 13px;">
                <span style="background: #e8f4e8; padding: 2px 8px; border-radius: 4px; font-family: monospace;">
                  @{groupData.actorName}@neogrp.club
                </span>
                <span style="margin-left: 8px;">Mastodon 用户可以关注</span>
              </div>
            )}
          </div>
          <div class="group-actions">
            {user && !isMember && (
              <form action={`/group/${groupId}/join`} method="post">
                <button type="submit" class="btn btn-primary">{isRemoteGroup ? '关注' : '加入小组'}</button>
              </form>
            )}
            {user && isMember && isRemoteGroup && (
              <div>
                <span class="member-badge" style={memberFollowStatus === 'pending' ? 'background: #fff3cd; color: #856404;' : ''}>
                  {memberFollowStatus === 'pending' ? '等待确认' : '已关注'}
                </span>
                <form action={`/group/${groupId}/leave`} method="post" style="display: inline; margin-left: 8px;">
                  <button type="submit" class="btn" onclick="return confirm('确定要取消关注该远程社区吗？')">取消关注</button>
                </form>
              </div>
            )}
            {user && isMember && !isRemoteGroup && (
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
              {user && isMember && (!(isRemoteGroup && memberFollowStatus === 'pending')) && (
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
                        <a href={`/user/${topic.user.username}`}>
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
    // Check if this is a mirror group
    const remoteGroup = await db.select()
      .from(remoteGroups)
      .where(eq(remoteGroups.localGroupId, groupId))
      .limit(1)

    if (remoteGroup.length > 0) {
      // Mirror group: send AP Follow
      await db.insert(groupMembers).values({
        id: generateId(),
        groupId,
        userId: user.id,
        followStatus: 'pending',
        createdAt: new Date(),
      })

      const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
      const apUsername = await getApUsername(db, user.id)
      if (apUsername) {
        const { privateKeyPem } = await ensureKeyPair(db, user.id)
        const actorUrl = `${baseUrl}/ap/users/${apUsername}`

        const followActivity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${actorUrl}#follow-${Date.now()}`,
          type: 'Follow',
          actor: actorUrl,
          object: remoteGroup[0].actorUri,
        }

        c.executionCtx.waitUntil(
          signAndDeliver(actorUrl, privateKeyPem, remoteGroup[0].inboxUrl, followActivity)
            .catch(e => console.error('[Remote Group] Follow delivery failed:', e))
        )
      }
    } else {
      // Local group: instant join
      await db.insert(groupMembers).values({
        id: generateId(),
        groupId,
        userId: user.id,
        createdAt: new Date(),
      })
    }
  }

  return c.redirect(`/group/${groupId}`)
})

// 退出小组
group.post('/:id/leave', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) return c.redirect('/auth/login')

  // Check if it's a mirror group and send Undo(Follow)
  const remoteGroup = await db.select()
    .from(remoteGroups)
    .where(eq(remoteGroups.localGroupId, groupId))
    .limit(1)

  if (remoteGroup.length > 0) {
    const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
    const apUsername = await getApUsername(db, user.id)
    if (apUsername) {
      const { privateKeyPem } = await ensureKeyPair(db, user.id)
      const actorUrl = `${baseUrl}/ap/users/${apUsername}`

      const undoActivity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${actorUrl}#undo-follow-${Date.now()}`,
        type: 'Undo',
        actor: actorUrl,
        object: {
          type: 'Follow',
          actor: actorUrl,
          object: remoteGroup[0].actorUri,
        },
      }

      c.executionCtx.waitUntil(
        signAndDeliver(actorUrl, privateKeyPem, remoteGroup[0].inboxUrl, undoActivity)
          .catch(e => console.error('[Remote Group] Undo Follow delivery failed:', e))
      )
    }
  }

  await db.delete(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))

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

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  return c.html(
    <Layout user={user} title={`发布话题 - ${groupData.name}`} unreadCount={c.get('unreadNotificationCount')}>
      <link href="https://cdn.jsdelivr.net/npm/quill@2.0.2/dist/quill.snow.css" rel="stylesheet" />
      <div class="new-topic-page">
        <div class="page-header">
          <h1>发布新话题</h1>
          <p class="page-subtitle">发布到 <a href={`/group/${groupId}`}>{groupData.name}</a></p>
        </div>

        <form action={`/group/${groupId}/topic/new`} method="POST" class="topic-form" id="topic-form">
          <div class="form-group">
            <label for="title">标题</label>
            <input type="text" id="title" name="title" required placeholder="话题标题" />
          </div>

          <div class="form-group">
            <label>内容</label>
            <div id="editor"></div>
            <input type="hidden" id="content" name="content" />
          </div>

          <div class="form-option">
            <label class="checkbox-label">
              <input type="checkbox" name="syncMastodon" value="1" />
              同步发布到 Mastodon
            </label>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-primary">发布话题</button>
            <a href={`/group/${groupId}`} class="btn">取消</a>
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

        // 图片上传处理
        quill.getModule('toolbar').addHandler('image', function() {
          const input = document.createElement('input');
          input.setAttribute('type', 'file');
          input.setAttribute('accept', 'image/*');
          input.click();
          input.onchange = async () => {
            const file = input.files[0];
            if (file) {
              await uploadImage(file);
            }
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
          var text = e.clipboardData?.getData('text/plain') || '';
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
          var items = e.clipboardData?.items;
          if (!items) return;
          for (var i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
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

        // 表单提交前将内容写入隐藏字段（卡片 HTML 已在编辑器中）
        document.getElementById('topic-form').addEventListener('submit', function(e) {
          var content = quill.root.innerHTML;
          document.getElementById('content').value = content === '<p><br></p>' ? '' : content;
        });
      ` }} />
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
  const syncMastodon = body.syncMastodon as string

  if (!title || !title.trim()) {
    return c.redirect(`/group/${groupId}/topic/new`)
  }

  const topicId = generateId()
  const topicNow = new Date()

  await db.insert(topics).values({
    id: topicId,
    groupId,
    userId: user.id,
    title: title.trim(),
    content: content?.trim() || null,
    type: 0,
    createdAt: topicNow,
    updatedAt: topicNow,
  })

  // 同步发布到 Mastodon
  if (syncMastodon === '1') {
    try {
      const authProvider = await db.query.authProviders.findFirst({
        where: and(
          eq(authProviders.userId, user.id),
          eq(authProviders.providerType, 'mastodon')
        ),
      })

      if (authProvider?.accessToken) {
        const domain = authProvider.providerId.split('@')[1]
        const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
        const tootContent = `${title.trim()}\n\n${baseUrl}/topic/${topicId}`
        const toot = await postStatus(domain, authProvider.accessToken, tootContent)
        // Save Mastodon status ID for reply sync
        await db.update(topics)
          .set({ mastodonStatusId: toot.id, mastodonDomain: domain })
          .where(eq(topics.id, topicId))
      }
    } catch (e) {
      console.error('Failed to sync toot:', e)
    }
  }

  // AP: deliver Create(Note) to followers
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // Check if this is a mirror group → send Create(Note) to remote group inbox
  const remoteGroupData = await db.select()
    .from(remoteGroups)
    .where(eq(remoteGroups.localGroupId, groupId))
    .limit(1)

  if (remoteGroupData.length > 0) {
    // Mirror group: send to remote group inbox with @group mention
    const rg = remoteGroupData[0]
    const noteApUrl = `${baseUrl}/ap/notes/${topicId}`

    // Set mastodonStatusId to our AP Note URL for dedup when Announce echoes back
    await db.update(topics)
      .set({ mastodonStatusId: noteApUrl, mastodonDomain: rg.domain })
      .where(eq(topics.id, topicId))

    c.executionCtx.waitUntil((async () => {
      try {
        const apUsername = await getApUsername(db, user.id)
        if (!apUsername) return

        const { privateKeyPem } = await ensureKeyPair(db, user.id)
        const actorUrl = `${baseUrl}/ap/users/${apUsername}`
        const topicUrl = `${baseUrl}/topic/${topicId}`
        const published = new Date().toISOString()

        let noteContent = `<p><b>${title.trim()}</b></p>`
        if (content?.trim()) noteContent += content.trim()
        noteContent += `<p><a href="${topicUrl}">${topicUrl}</a></p>`

        const note = {
          id: noteApUrl,
          type: 'Note',
          attributedTo: actorUrl,
          content: noteContent,
          url: topicUrl,
          published,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [rg.actorUri, `${actorUrl}/followers`],
          tag: [{
            type: 'Mention',
            href: rg.actorUri,
            name: `@${rg.actorUri.split('/').pop()}@${rg.domain}`,
          }],
        }

        const activity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${noteApUrl}/activity`,
          type: 'Create',
          actor: actorUrl,
          published,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [rg.actorUri, `${actorUrl}/followers`],
          object: note,
        }

        await signAndDeliver(actorUrl, privateKeyPem, rg.inboxUrl, activity)
      } catch (e) {
        console.error('[Remote Group] Failed to deliver topic to remote group:', e)
      }
    })())
  } else {
    // Local group: existing behavior
    c.executionCtx.waitUntil(
      deliverTopicToFollowers(db, baseUrl, user.id, topicId, title.trim(), content?.trim() || null)
    )

    // AP: Announce to group followers if group has actorName
    c.executionCtx.waitUntil((async () => {
      const groupData = await db.select({ actorName: groups.actorName })
        .from(groups).where(eq(groups.id, groupId)).limit(1)
      if (groupData.length > 0 && groupData[0].actorName) {
        const noteUrl = `${baseUrl}/topic/${topicId}`
        const groupActorUrl = `${baseUrl}/ap/groups/${groupData[0].actorName}`
        const noteJson = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: noteUrl,
          type: 'Note',
          attributedTo: groupActorUrl,
          audience: groupActorUrl,
          content: `<p><strong>${title.trim()}</strong></p>${content?.trim() ? `<p>${content.trim()}</p>` : ''}<p><a href="${noteUrl}">${noteUrl}</a></p>`,
          url: noteUrl,
          published: new Date().toISOString(),
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [`${groupActorUrl}/followers`],
        }
        await announceToGroupFollowers(db, groupId, groupData[0].actorName, noteJson, baseUrl)
      }
    })())
  }

  // Nostr: broadcast topic as Kind 1 event
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
        const textContent = content?.trim() ? stripHtml(content.trim()) : ''
        const noteContent = textContent
          ? `${title.trim()}\n\n${textContent}\n\n🔗 ${baseUrl}/topic/${topicId}`
          : `${title.trim()}\n\n🔗 ${baseUrl}/topic/${topicId}`

        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 1,
          content: noteContent,
          tags: [
            ['r', `${baseUrl}/topic/${topicId}`],
            ['client', 'NeoGroup'],
          ],
        })

        await db.update(topics)
          .set({ nostrEventId: event.id })
          .where(eq(topics.id, topicId))

        await c.env.NOSTR_QUEUE.send({ events: [event] })
        console.log('[Nostr] Queued topic event:', event.id)
      } catch (e) {
        console.error('[Nostr] Failed to publish topic:', e)
      }
    })())
  }

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
    <Layout user={user} title={`小组设置 - ${groupData.name}`} unreadCount={c.get('unreadNotificationCount')}>
      <div class="new-topic-page">
        <div class="page-header">
          <h1>小组设置</h1>
          <p class="page-subtitle">管理 <a href={`/group/${groupId}`}>{groupData.name}</a></p>
        </div>

        <form action={`/group/${groupId}/settings`} method="POST" enctype="multipart/form-data" class="topic-form">
          <div class="form-group">
            <label>当前 LOGO</label>
            <div style="margin-bottom: 10px;">
              <img src={resizeImage(groupData.iconUrl, 160) || '/static/img/default-group.svg'} alt="" class="group-icon" style="width: 80px; height: 80px;" />
            </div>
            <label for="icon">更换 LOGO</label>
            <input type="file" id="icon" name="icon" accept="image/*" />
            <p style="color: #999; font-size: 12px; margin-top: 5px;">支持 JPG、PNG、GIF、WebP 格式</p>
          </div>

          <div class="form-group">
            <label for="description">小组简介</label>
            <textarea id="description" name="description" rows={5} placeholder="介绍一下这个小组...">{groupData.description || ''}</textarea>
          </div>

          <div class="form-group">
            <label for="tags">分类标签 <span style="color: #999; font-weight: normal;">(空格分隔)</span></label>
            <input type="text" id="tags" name="tags" value={groupData.tags || ''} placeholder="输入标签，空格分隔，如：电影 读书 音乐" />
          </div>

          <div class="form-group">
            <label for="actorName">联邦 ID <span style="color: #999; font-weight: normal;">(可选)</span></label>
            <input
              type="text"
              id="actorName"
              name="actorName"
              value={groupData.actorName || ''}
              placeholder="例如: board"
              pattern="^[a-z0-9_]{0,20}$"
              maxlength={20}
              style="max-width: 300px;"
            />
            <p style="color: #666; font-size: 13px; margin-top: 8px; line-height: 1.6;">
              设置后，Mastodon 用户可以通过 <strong>@{groupData.actorName || 'yourname'}@neogrp.club</strong> 关注本小组。
              <br />
              <span style="color: #999;">只能使用小写英文字母、数字和下划线，最多 20 个字符。设置后不建议更改。</span>
            </p>
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
  const tags = body.tags as string
  const iconFile = body.icon as File | undefined
  const actorNameInput = body.actorName as string | undefined

  // 验证 actorName: 只允许小写英文、数字、下划线，最多20字符
  let actorName = groupData.actorName
  if (actorNameInput !== undefined) {
    const trimmed = actorNameInput.trim().toLowerCase()
    if (trimmed === '') {
      // 允许清空
      actorName = null
    } else if (/^[a-z0-9_]{1,20}$/.test(trimmed)) {
      actorName = trimmed
    }
    // 格式不正确则保持原值
  }

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
      tags: tags?.trim() || null,
      actorName,
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
