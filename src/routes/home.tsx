import { Hono } from 'hono'
import { desc, eq, sql, notInArray, inArray } from 'drizzle-orm'
import type { AppContext } from '../types'
import { topics, users, groups, groupMembers, comments, remoteGroups } from '../db/schema'
import { HomePage } from '../components/HomePage'

const home = new Hono<AppContext>()

home.get('/', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const source = c.req.query('source') || 'local'

  // Get remote group IDs for filtering
  const remoteGroupIds = (await db.select({ localGroupId: remoteGroups.localGroupId }).from(remoteGroups)).map(r => r.localGroupId)

  // 最新话题（30条）- filtered by source
  const topicQuery = db
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
      replyCount: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = ${topics.id})`.as('reply_count'),
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        bio: users.bio,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      },
      group: {
        id: groups.id,
        creatorId: groups.creatorId,
        name: groups.name,
        description: groups.description,
        actorName: groups.actorName,
        iconUrl: groups.iconUrl,
        createdAt: groups.createdAt,
        updatedAt: groups.updatedAt,
      },
    })
    .from(topics)
    .innerJoin(users, eq(topics.userId, users.id))
    .leftJoin(groups, eq(topics.groupId, groups.id))

  let latestTopics: any[]
  if (source === 'random') {
    latestTopics = []
  } else if (source === 'remote' && remoteGroupIds.length > 0) {
    latestTopics = await topicQuery
      .where(inArray(topics.groupId, remoteGroupIds))
      .orderBy(desc(topics.updatedAt))
      .limit(30)
  } else if (source === 'remote') {
    latestTopics = []
  } else if (remoteGroupIds.length > 0) {
    latestTopics = await topicQuery
      .where(sql`(${topics.groupId} IS NULL OR ${topics.groupId} NOT IN (${sql.raw(remoteGroupIds.map(id => `'${id}'`).join(','))}))`)
      .orderBy(desc(topics.updatedAt))
      .limit(30)
  } else {
    latestTopics = await topicQuery
      .orderBy(desc(topics.updatedAt))
      .limit(30)
  }

  // 随机话题和回复（随便看看）
  const randomLimit = source === 'random' ? 20 : 5
  const randomTopics = await db
    .select({
      id: topics.id,
      title: topics.title,
      content: topics.content,
      createdAt: topics.createdAt,
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
      group: {
        id: groups.id,
        name: groups.name,
        actorName: groups.actorName,
      },
    })
    .from(topics)
    .innerJoin(users, eq(topics.userId, users.id))
    .leftJoin(groups, eq(topics.groupId, groups.id))
    .orderBy(sql`RANDOM()`)
    .limit(randomLimit)

  const randomComments = await db
    .select({
      id: comments.id,
      content: comments.content,
      createdAt: comments.createdAt,
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
      topic: {
        id: topics.id,
        title: topics.title,
      },
      group: {
        id: groups.id,
        name: groups.name,
        actorName: groups.actorName,
      },
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .innerJoin(topics, eq(comments.topicId, topics.id))
    .leftJoin(groups, eq(topics.groupId, groups.id))
    .orderBy(sql`RANDOM()`)
    .limit(randomLimit)

  // 混合并打乱顺序
  const feedItems = [
    ...randomTopics.map(t => ({ type: 'topic' as const, ...t })),
    ...randomComments.map(c => ({ type: 'comment' as const, ...c })),
  ].sort(() => Math.random() - 0.5)

  // 小组标签（聚合所有小组的 tags，取出现次数最多的10个）
  const allGroupTags = await db
    .select({ tags: groups.tags })
    .from(groups)
    .where(sql`${groups.tags} IS NOT NULL AND ${groups.tags} != ''`)

  const tagCounts = new Map<string, number>()
  for (const row of allGroupTags) {
    if (row.tags) {
      for (const tag of row.tags.split(/\s+/).filter(Boolean)) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
      }
    }
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag]) => tag)

  // 热门小组（10条，按成员数排序）
  const hotGroups = await db
    .select({
      id: groups.id,
      creatorId: groups.creatorId,
      name: groups.name,
      actorName: groups.actorName,
      description: groups.description,
      iconUrl: groups.iconUrl,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
      memberCount: sql<number>`count(${groupMembers.id})`.as('member_count'),
    })
    .from(groups)
    .leftJoin(groupMembers, eq(groups.id, groupMembers.groupId))
    .groupBy(groups.id)
    .orderBy(desc(sql`member_count`))
    .limit(10)

  // 随机小组（5条）
  const randomGroups = await db
    .select({
      id: groups.id,
      creatorId: groups.creatorId,
      name: groups.name,
      actorName: groups.actorName,
      description: groups.description,
      tags: groups.tags,
      iconUrl: groups.iconUrl,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
    })
    .from(groups)
    .orderBy(sql`RANDOM()`)
    .limit(5)

  // 新用户（10条）
  const newUsers = await db.query.users.findMany({
    orderBy: desc(users.createdAt),
    limit: 10,
  })

  // 用户加入的小组
  let userGroups: typeof groups.$inferSelect[] = []
  let remoteGroupDomains: Record<string, string> = {}
  if (user) {
    const memberships = await db
      .select({ group: groups })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(eq(groupMembers.userId, user.id))
      .limit(10)
    userGroups = memberships.map((m) => m.group)

    // Fetch remote group domains for sidebar indicators
    if (userGroups.length > 0) {
      const rgList = await db.select({ localGroupId: remoteGroups.localGroupId, domain: remoteGroups.domain })
        .from(remoteGroups)
      for (const rg of rgList) {
        remoteGroupDomains[rg.localGroupId] = rg.domain
      }
    }
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  return c.html(
    <HomePage
      user={user}
      feedItems={feedItems as any}
      topics={latestTopics as any}
      hotGroups={hotGroups as any}
      topTags={topTags}
      randomGroups={randomGroups as any}
      newUsers={newUsers}
      userGroups={userGroups}
      remoteGroupDomains={remoteGroupDomains}
      baseUrl={baseUrl}
      unreadCount={c.get('unreadNotificationCount')}
      siteName={c.env.APP_NAME}
      source={source}
      hasRemoteGroups={remoteGroupIds.length > 0}
    />
  )
})

export default home
