import { Hono } from 'hono'
import { desc, eq, sql } from 'drizzle-orm'
import type { AppContext } from '../types'
import { topics, users, groups, groupMembers } from '../db/schema'
import { HomePage } from '../components/HomePage'

const home = new Hono<AppContext>()

home.get('/', async (c) => {
  const db = c.get('db')
  const user = c.get('user')

  // 最新话题（30条）
  const latestTopics = await db
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
      likeCount: sql<number>`(SELECT COUNT(*) FROM topic_like WHERE topic_like.topic_id = ${topics.id})`.as('like_count'),
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
        iconUrl: groups.iconUrl,
        createdAt: groups.createdAt,
        updatedAt: groups.updatedAt,
      },
    })
    .from(topics)
    .innerJoin(users, eq(topics.userId, users.id))
    .innerJoin(groups, eq(topics.groupId, groups.id))
    .orderBy(desc(topics.updatedAt))
    .limit(30)

  // 热门小组（10条，按成员数排序）
  const hotGroups = await db
    .select({
      id: groups.id,
      creatorId: groups.creatorId,
      name: groups.name,
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

  // 新用户（10条）
  const newUsers = await db.query.users.findMany({
    orderBy: desc(users.createdAt),
    limit: 10,
  })

  // 用户加入的小组
  let userGroups: typeof groups.$inferSelect[] = []
  if (user) {
    const memberships = await db
      .select({ group: groups })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(eq(groupMembers.userId, user.id))
      .limit(10)
    userGroups = memberships.map((m) => m.group)
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  return c.html(
    <HomePage
      user={user}
      topics={latestTopics as any}
      hotGroups={hotGroups as any}
      newUsers={newUsers}
      userGroups={userGroups}
      baseUrl={baseUrl}
    />
  )
})

export default home
