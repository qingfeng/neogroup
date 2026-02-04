#!/usr/bin/env node

/**
 * 数据迁移脚本：从 Django SQLite 迁移到 Hono D1
 *
 * 使用方法：
 * 1. node scripts/migrate-data.js > migrate.sql
 * 2. wrangler d1 execute neogroup --remote --file=migrate.sql
 */

const Database = require('better-sqlite3')
const { nanoid } = require('nanoid')

// 修改为你的 Django SQLite 数据库路径
const LOCAL_DB_PATH = process.env.DJANGO_DB_PATH || './db.sqlite3'

// 打开本地数据库
const db = new Database(LOCAL_DB_PATH, { readonly: true })

// ID 映射表（旧 ID -> 新 nanoid）
const userIdMap = new Map()
const groupIdMap = new Map()
const topicIdMap = new Map()
const commentIdMap = new Map()

// 生成新 ID
function newId() {
  return nanoid(12)
}

// 转义 SQL 字符串
function escapeStr(str) {
  if (str === null || str === undefined) return 'NULL'
  return `'${String(str).replace(/'/g, "''")}'`
}

// 转换时间戳（Django datetime -> Unix timestamp）
function toTimestamp(dateStr) {
  if (!dateStr) return Math.floor(Date.now() / 1000)
  return Math.floor(new Date(dateStr).getTime() / 1000)
}

console.log('-- NeoGroup Data Migration')
console.log('-- Generated at:', new Date().toISOString())
console.log('')

// 清空所有表
console.log('-- Clear existing data')
console.log('DELETE FROM comment_like;')
console.log('DELETE FROM comment;')
console.log('DELETE FROM topic;')
console.log('DELETE FROM group_member;')
console.log('DELETE FROM "group";')
console.log('DELETE FROM auth_provider;')
console.log('DELETE FROM report;')
console.log('DELETE FROM mastodon_app;')
console.log('DELETE FROM user;')
console.log('')

// 迁移用户
console.log('-- Migrate users')
const users = db.prepare(`
  SELECT id, username, mastodon_id, mastodon_site, mastodon_token,
         mastodon_refresh_token, mastodon_account, date_joined
  FROM users_user
  WHERE mastodon_id != '' AND mastodon_site != ''
`).all()

for (const user of users) {
  const newUserId = newId()
  userIdMap.set(user.id, newUserId)

  // 解析 mastodon_account JSON 获取 display_name 和 avatar
  let displayName = user.username
  let avatarUrl = null
  let bio = null
  try {
    if (user.mastodon_account) {
      const account = JSON.parse(user.mastodon_account)
      displayName = account.display_name || account.username || user.username
      avatarUrl = account.avatar || null
      bio = account.note || null
    }
  } catch (e) {}

  const createdAt = toTimestamp(user.date_joined)

  // 生成唯一 username
  const uniqueUsername = `${user.username}_${user.mastodon_site.replace(/\./g, '_')}`

  console.log(`INSERT INTO user (id, username, display_name, avatar_url, bio, created_at, updated_at) VALUES (${escapeStr(newUserId)}, ${escapeStr(uniqueUsername)}, ${escapeStr(displayName)}, ${escapeStr(avatarUrl)}, ${escapeStr(bio)}, ${createdAt}, ${createdAt});`)

  // 创建 auth_provider
  const authProviderId = newId()
  const providerId = `${user.mastodon_id}@${user.mastodon_site}`
  console.log(`INSERT INTO auth_provider (id, user_id, provider_type, provider_id, access_token, refresh_token, metadata, created_at) VALUES (${escapeStr(authProviderId)}, ${escapeStr(newUserId)}, 'mastodon', ${escapeStr(providerId)}, ${escapeStr(user.mastodon_token)}, ${escapeStr(user.mastodon_refresh_token)}, ${escapeStr(user.mastodon_account)}, ${createdAt});`)
}
console.log('')

// 迁移小组
console.log('-- Migrate groups')
const groups = db.prepare(`
  SELECT id, user_id, name, description, icon_url, created_at, updated_at
  FROM group_group
`).all()

for (const group of groups) {
  const newGroupId = newId()
  groupIdMap.set(group.id, newGroupId)

  const creatorId = userIdMap.get(group.user_id)
  if (!creatorId) continue // 跳过没有有效创建者的小组

  const createdAt = toTimestamp(group.created_at)
  const updatedAt = toTimestamp(group.updated_at)

  console.log(`INSERT INTO "group" (id, creator_id, name, description, icon_url, created_at, updated_at) VALUES (${escapeStr(newGroupId)}, ${escapeStr(creatorId)}, ${escapeStr(group.name)}, ${escapeStr(group.description)}, ${escapeStr(group.icon_url)}, ${createdAt}, ${updatedAt});`)
}
console.log('')

// 迁移小组成员
console.log('-- Migrate group members')
const members = db.prepare(`
  SELECT id, group_id, user_id, join_reason, created_at
  FROM group_groupmember
`).all()

for (const member of members) {
  const groupId = groupIdMap.get(member.group_id)
  const userId = userIdMap.get(member.user_id)
  if (!groupId || !userId) continue

  const memberId = newId()
  const createdAt = toTimestamp(member.created_at)

  console.log(`INSERT INTO group_member (id, group_id, user_id, join_reason, created_at) VALUES (${escapeStr(memberId)}, ${escapeStr(groupId)}, ${escapeStr(userId)}, ${escapeStr(member.join_reason)}, ${createdAt});`)
}
console.log('')

// 迁移话题
console.log('-- Migrate topics')
const topics = db.prepare(`
  SELECT id, group_id, user_id, title, description, type, created_at, updated_at
  FROM group_topic
`).all()

for (const topic of topics) {
  const newTopicId = newId()
  topicIdMap.set(topic.id, newTopicId)

  const groupId = groupIdMap.get(topic.group_id)
  const userId = userIdMap.get(topic.user_id)
  if (!groupId || !userId) continue

  const createdAt = toTimestamp(topic.created_at)
  const updatedAt = toTimestamp(topic.updated_at)

  console.log(`INSERT INTO topic (id, group_id, user_id, title, content, type, images, created_at, updated_at) VALUES (${escapeStr(newTopicId)}, ${escapeStr(groupId)}, ${escapeStr(userId)}, ${escapeStr(topic.title)}, ${escapeStr(topic.description)}, ${topic.type || 0}, NULL, ${createdAt}, ${updatedAt});`)
}
console.log('')

// 迁移评论
console.log('-- Migrate comments')
const comments = db.prepare(`
  SELECT id, topic_id, user_id, content, comment_reply_id, created_at, updated_at
  FROM group_comment
`).all()

for (const comment of comments) {
  const newCommentId = newId()
  commentIdMap.set(comment.id, newCommentId)

  const topicId = topicIdMap.get(comment.topic_id)
  const userId = userIdMap.get(comment.user_id)
  if (!topicId || !userId) continue

  const replyToId = comment.comment_reply_id ? commentIdMap.get(comment.comment_reply_id) : null
  const createdAt = toTimestamp(comment.created_at)
  const updatedAt = toTimestamp(comment.updated_at)

  console.log(`INSERT INTO comment (id, topic_id, user_id, content, reply_to_id, created_at, updated_at) VALUES (${escapeStr(newCommentId)}, ${escapeStr(topicId)}, ${escapeStr(userId)}, ${escapeStr(comment.content)}, ${escapeStr(replyToId)}, ${createdAt}, ${updatedAt});`)
}
console.log('')

// 迁移点赞
console.log('-- Migrate comment likes')
const likes = db.prepare(`
  SELECT id, comment_id, user_id, created_at
  FROM group_likecomment
`).all()

for (const like of likes) {
  const commentId = commentIdMap.get(like.comment_id)
  const userId = userIdMap.get(like.user_id)
  if (!commentId || !userId) continue

  const likeId = newId()
  const createdAt = toTimestamp(like.created_at)

  console.log(`INSERT INTO comment_like (id, comment_id, user_id, created_at) VALUES (${escapeStr(likeId)}, ${escapeStr(commentId)}, ${escapeStr(userId)}, ${createdAt});`)
}
console.log('')

// 迁移 Mastodon 应用
console.log('-- Migrate mastodon apps')
const apps = db.prepare(`
  SELECT id, domain_name, client_id, client_secret, vapid_key
  FROM mastodon_mastodonapplication
`).all()

for (const app of apps) {
  const appId = newId()
  const createdAt = Math.floor(Date.now() / 1000)

  console.log(`INSERT INTO mastodon_app (id, domain, client_id, client_secret, vapid_key, created_at) VALUES (${escapeStr(appId)}, ${escapeStr(app.domain_name)}, ${escapeStr(app.client_id)}, ${escapeStr(app.client_secret)}, ${escapeStr(app.vapid_key)}, ${createdAt});`)
}
console.log('')

console.log('-- Migration complete')

db.close()
