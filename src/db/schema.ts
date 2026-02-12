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
  nostrPubkey: text('nostr_pubkey'),
  nostrPrivEncrypted: text('nostr_priv_encrypted'),
  nostrPrivIv: text('nostr_priv_iv'),
  nostrKeyVersion: integer('nostr_key_version').default(1),
  nostrSyncEnabled: integer('nostr_sync_enabled').default(0),
  balanceSats: integer('balance_sats').notNull().default(0),
  lightningAddress: text('lightning_address'),
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
  nostrPubkey: text('nostr_pubkey'),
  nostrPrivEncrypted: text('nostr_priv_encrypted'),
  nostrPrivIv: text('nostr_priv_iv'),
  nostrSyncEnabled: integer('nostr_sync_enabled').default(0),
  nostrCommunityEventId: text('nostr_community_event_id'),
  nostrLastPollAt: integer('nostr_last_poll_at'),
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
  groupId: text('group_id').references(() => groups.id),
  userId: text('user_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  content: text('content'),
  type: integer('type').default(0), // 0=话题 1=问题 2=投票
  images: text('images'), // JSON array
  mastodonStatusId: text('mastodon_status_id'),
  mastodonDomain: text('mastodon_domain'),
  mastodonSyncedAt: integer('mastodon_synced_at', { mode: 'timestamp' }),
  nostrEventId: text('nostr_event_id'),
  nostrAuthorPubkey: text('nostr_author_pubkey'),
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
  nostrEventId: text('nostr_event_id'),
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

// Nostr 关注表
export const nostrFollows = sqliteTable('nostr_follow', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  targetPubkey: text('target_pubkey').notNull(),
  targetNpub: text('target_npub'),
  targetDisplayName: text('target_display_name'),
  targetAvatarUrl: text('target_avatar_url'),
  lastPollAt: integer('last_poll_at'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Nostr 社区关注表
export const nostrCommunityFollows = sqliteTable('nostr_community_follow', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  communityPubkey: text('community_pubkey').notNull(),
  communityDTag: text('community_d_tag').notNull(),
  communityRelay: text('community_relay'),
  communityName: text('community_name'),
  localGroupId: text('local_group_id').references(() => groups.id),
  lastPollAt: integer('last_poll_at'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// DVM 任务表 (NIP-90)
export const dvmJobs = sqliteTable('dvm_job', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  role: text('role').notNull(), // 'customer' | 'provider'
  kind: integer('kind').notNull(), // Job Kind (5100, 5200, etc.)
  eventId: text('event_id'), // Nostr event ID (own event)
  status: text('status').notNull(), // open | processing | result_available | completed | cancelled | error
  input: text('input'),
  inputType: text('input_type'), // text | url | event | job
  output: text('output'), // 期望输出格式
  result: text('result'),
  bidMsats: integer('bid_msats'),
  priceMsats: integer('price_msats'),
  customerPubkey: text('customer_pubkey'),
  providerPubkey: text('provider_pubkey'),
  requestEventId: text('request_event_id'),
  resultEventId: text('result_event_id'),
  params: text('params'), // JSON
  bolt11: text('bolt11'), // Lightning invoice (from provider result)
  paymentHash: text('payment_hash'), // For matching LNbits webhook
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// DVM 服务注册表 (NIP-89)
export const dvmServices = sqliteTable('dvm_service', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  kinds: text('kinds').notNull(), // JSON array: [5200, 5201]
  description: text('description'),
  pricingMin: integer('pricing_min'), // msats
  pricingMax: integer('pricing_max'), // msats
  eventId: text('event_id'), // NIP-89 Kind 31990 event ID
  active: integer('active').default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// 账本表
export const ledgerEntries = sqliteTable('ledger_entry', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  type: text('type').notNull(), // escrow_freeze | escrow_release | escrow_refund | job_payment | transfer_out | transfer_in | airdrop
  amountSats: integer('amount_sats').notNull(),
  balanceAfter: integer('balance_after').notNull(),
  refId: text('ref_id'),
  refType: text('ref_type'), // dvm_job | transfer | airdrop
  memo: text('memo'),
  nostrEventId: text('nostr_event_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 充值发票表
export const deposits = sqliteTable('deposit', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  amountSats: integer('amount_sats').notNull(),
  paymentHash: text('payment_hash').notNull().unique(),
  paymentRequest: text('payment_request').notNull(),
  status: text('status').notNull().default('pending'), // pending | paid | expired
  paidAt: integer('paid_at', { mode: 'timestamp' }),
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
export type NostrFollow = typeof nostrFollows.$inferSelect
export type NostrCommunityFollow = typeof nostrCommunityFollows.$inferSelect
export type DvmJob = typeof dvmJobs.$inferSelect
export type DvmService = typeof dvmServices.$inferSelect
export type LedgerEntry = typeof ledgerEntries.$inferSelect
export type Deposit = typeof deposits.$inferSelect
