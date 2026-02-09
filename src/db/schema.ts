import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// 用户表
export const users = sqliteTable('user', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  role: text('role'), // 'admin' = 超级管理员
  apPublicKey: text('ap_public_key'),
  apPrivateKey: text('ap_private_key'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// 认证方式表
export const authProviders = sqliteTable('auth_provider', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  providerType: text('provider_type').notNull(), // mastodon | wallet | agent
  providerId: text('provider_id').notNull(), // user@mastodon.social
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  metadata: text('metadata'), // JSON
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 小组表
export const groups = sqliteTable('group', {
  id: text('id').primaryKey(),
  creatorId: text('creator_id').notNull().references(() => users.id),
  name: text('name').notNull().unique(),
  actorName: text('actor_name').unique(), // ActivityPub actor name for federation
  description: text('description'),
  tags: text('tags'),
  iconUrl: text('icon_url'),
  apPublicKey: text('ap_public_key'),
  apPrivateKey: text('ap_private_key'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// 小组 AP 动态（用于 Group Outbox）
export const groupActivities = sqliteTable('group_activity', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull().references(() => groups.id),
  activityJson: text('activity_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 小组成员表
export const groupMembers = sqliteTable('group_member', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull().references(() => groups.id),
  userId: text('user_id').notNull().references(() => users.id),
  joinReason: text('join_reason'),
  followStatus: text('follow_status'), // NULL=local group, 'pending'=Follow sent, 'accepted'=confirmed
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 话题表
export const topics = sqliteTable('topic', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull().references(() => groups.id),
  userId: text('user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  content: text('content'),
  type: integer('type').default(0), // 0=话题 1=问题 2=投票
  images: text('images'), // JSON array
  mastodonStatusId: text('mastodon_status_id'),
  mastodonDomain: text('mastodon_domain'),
  mastodonSyncedAt: integer('mastodon_synced_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// 评论表
export const comments = sqliteTable('comment', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => topics.id),
  userId: text('user_id').notNull().references(() => users.id),
  content: text('content').notNull(),
  replyToId: text('reply_to_id'),
  mastodonStatusId: text('mastodon_status_id'),
  mastodonDomain: text('mastodon_domain'),
  mastodonSyncedAt: integer('mastodon_synced_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// 评论点赞表
export const commentLikes = sqliteTable('comment_like', {
  id: text('id').primaryKey(),
  commentId: text('comment_id').notNull().references(() => comments.id),
  userId: text('user_id').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 评论转发表
export const commentReposts = sqliteTable('comment_repost', {
  id: text('id').primaryKey(),
  commentId: text('comment_id').notNull().references(() => comments.id),
  userId: text('user_id').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 话题喜欢表
export const topicLikes = sqliteTable('topic_like', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => topics.id),
  userId: text('user_id').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 话题转发表
export const topicReposts = sqliteTable('topic_repost', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => topics.id),
  userId: text('user_id').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 举报表
export const reports = sqliteTable('report', {
  id: text('id').primaryKey(),
  reporterId: text('reporter_id').notNull().references(() => users.id),
  reportedUserId: text('reported_user_id').notNull().references(() => users.id),
  message: text('message'),
  imageUrl: text('image_url'),
  isRead: integer('is_read').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 站内提醒表
export const notifications = sqliteTable('notification', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  actorId: text('actor_id'),  // nullable for remote actors
  type: text('type').notNull(), // reply | comment_reply | topic_like | comment_like | mention
  topicId: text('topic_id'),
  commentId: text('comment_id'),
  isRead: integer('is_read').default(0).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  // 远程 actor 信息（用于 AP mention 等场景）
  actorName: text('actor_name'),
  actorUrl: text('actor_url'),
  actorAvatarUrl: text('actor_avatar_url'),
  actorUri: text('actor_uri'),  // AP actor URI (unique identifier for remote users)
  metadata: text('metadata'), // JSON: { content, noteUrl }
})

// 本地用户关注关系
export const userFollows = sqliteTable('user_follow', {
  id: text('id').primaryKey(),
  followerId: text('follower_id').notNull().references(() => users.id),
  followeeId: text('followee_id').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// ActivityPub Followers 表
export const apFollowers = sqliteTable('ap_follower', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  actorUri: text('actor_uri').notNull(),
  inboxUrl: text('inbox_url').notNull(),
  sharedInboxUrl: text('shared_inbox_url'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Mastodon 应用配置表
export const mastodonApps = sqliteTable('mastodon_app', {
  id: text('id').primaryKey(),
  domain: text('domain').notNull().unique(),
  clientId: text('client_id').notNull(),
  clientSecret: text('client_secret').notNull(),
  vapidKey: text('vapid_key'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 小组 followers (远程 AP actors)
export const groupFollowers = sqliteTable('group_follower', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull().references(() => groups.id),
  actorUri: text('actor_uri').notNull(),
  actorInbox: text('actor_inbox'),
  actorSharedInbox: text('actor_shared_inbox'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 远程镜像小组
export const remoteGroups = sqliteTable('remote_group', {
  id: text('id').primaryKey(),
  localGroupId: text('local_group_id').notNull().unique().references(() => groups.id),
  actorUri: text('actor_uri').notNull().unique(),
  inboxUrl: text('inbox_url').notNull(),
  sharedInboxUrl: text('shared_inbox_url'),
  domain: text('domain').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 类型导出
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type AuthProvider = typeof authProviders.$inferSelect
export type Group = typeof groups.$inferSelect
export type GroupMember = typeof groupMembers.$inferSelect
export type Topic = typeof topics.$inferSelect
export type Comment = typeof comments.$inferSelect
export type CommentLike = typeof commentLikes.$inferSelect
export type CommentRepost = typeof commentReposts.$inferSelect
export type TopicLike = typeof topicLikes.$inferSelect
export type Report = typeof reports.$inferSelect
export type Notification = typeof notifications.$inferSelect
export type MastodonApp = typeof mastodonApps.$inferSelect
export type TopicRepost = typeof topicReposts.$inferSelect
export type ApFollower = typeof apFollowers.$inferSelect
export type GroupFollower = typeof groupFollowers.$inferSelect
export type UserFollow = typeof userFollows.$inferSelect
export type RemoteGroup = typeof remoteGroups.$inferSelect
