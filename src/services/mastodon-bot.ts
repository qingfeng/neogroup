import type { Database } from '../db'
import type { Bindings } from '../types'
import { groups, topics, groupMembers } from '../db/schema'
import { generateId } from '../lib/utils'
import { getOrCreateMastodonUser } from './mastodon-sync'
import { postStatus } from './mastodon'

const FALLBACK_GROUP_ID = 'AbjyyyMQgftC'
const TITLE_MAX_LENGTH = 50

interface MastodonNotification {
  id: string
  type: string
  status: {
    id: string
    content: string
    url: string
    account: {
      id: string
      username: string
      acct: string
      display_name: string
      avatar: string
      url: string
    }
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

function cleanMentionContent(content: string): string {
  // 去掉 @mention 标签和多余空白
  return stripHtml(content)
    .replace(/@\w+(@[\w.]+)?/g, '')
    .trim()
}

async function fetchNotifications(
  domain: string,
  token: string,
  sinceId?: string
): Promise<MastodonNotification[]> {
  let url = `https://${domain}/api/v1/notifications?types[]=mention&limit=20`
  if (sinceId) url += `&since_id=${sinceId}`

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    console.error(`Failed to fetch notifications: ${response.status}`)
    return []
  }
  return response.json() as Promise<MastodonNotification[]>
}

async function generateTitle(ai: Ai, content: string): Promise<string> {
  const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      {
        role: 'user',
        content: `用户发了一段内容，请生成一个简短的中文标题（15字以内）。只返回标题文字，不要加引号或其他内容。\n\n内容：${content}`,
      },
    ],
    max_tokens: 50,
  }) as { response: string }
  return response.response?.trim().replace(/^["「『]|["」』]$/g, '') || content.slice(0, 30)
}

async function selectGroup(ai: Ai, db: Database, content: string): Promise<string> {
  const allGroups = await db
    .select({
      id: groups.id,
      name: groups.name,
      tags: groups.tags,
      description: groups.description,
    })
    .from(groups)

  if (allGroups.length === 0) return FALLBACK_GROUP_ID

  const groupList = allGroups
    .map(g => `- ID: ${g.id}, 名称: ${g.name}${g.tags ? ', 标签: ' + g.tags : ''}${g.description ? ', 简介: ' + g.description.slice(0, 50) : ''}`)
    .join('\n')

  const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      {
        role: 'user',
        content: `根据以下内容，从小组列表中选择最合适的一个。只返回小组ID，不要返回其他任何内容。如果没有合适的，返回 "${FALLBACK_GROUP_ID}"。\n\n内容：${content}\n\n小组列表：\n${groupList}`,
      },
    ],
    max_tokens: 30,
  }) as { response: string }

  const selectedId = response.response?.trim()
  // 验证返回的 ID 是否真实存在
  const valid = allGroups.find(g => g.id === selectedId)
  return valid ? selectedId : FALLBACK_GROUP_ID
}

async function processMention(
  env: Bindings,
  db: Database,
  notification: MastodonNotification
): Promise<void> {
  const domain = env.MASTODON_BOT_DOMAIN!
  const token = env.MASTODON_BOT_TOKEN!
  const status = notification.status
  const content = cleanMentionContent(status.content)

  if (!content) return

  // 生成标题和正文
  let title: string
  let body: string | null = null

  if (content.length <= TITLE_MAX_LENGTH) {
    title = content
  } else {
    title = await generateTitle(env.AI!, content)
    body = `<p>${content.replace(/\n/g, '</p><p>')}</p>`
  }

  // AI 选择小组
  const groupId = await selectGroup(env.AI!, db, content)

  // 创建或关联用户
  const userId = await getOrCreateMastodonUser(db, status.account, domain)

  // 确保用户是小组成员
  const existingMember = await db.query.groupMembers.findFirst({
    where: (gm, { and, eq }) => and(eq(gm.groupId, groupId), eq(gm.userId, userId)),
  })
  if (!existingMember) {
    await db.insert(groupMembers).values({
      id: generateId(),
      groupId,
      userId,
      createdAt: new Date(),
    })
  }

  // 创建话题
  const topicId = generateId()
  const now = new Date()
  const baseUrl = env.APP_URL || 'https://neogrp.club'

  await db.insert(topics).values({
    id: topicId,
    groupId,
    userId,
    title,
    content: body,
    mastodonStatusId: status.id,
    mastodonDomain: domain,
    createdAt: now,
    updatedAt: now,
  })

  // 获取小组名称
  const groupData = await db.query.groups.findFirst({
    where: (g, { eq }) => eq(g.id, groupId),
  })
  const groupName = groupData?.name || '杂谈'

  // 回复用户确认消息
  const replyContent = `@${status.account.acct} 已发布到「${groupName}」小组 👉 ${baseUrl}/topic/${topicId}`
  try {
    await postStatus(domain, token, replyContent, 'unlisted', status.id)
  } catch (e) {
    console.error('Failed to reply confirmation:', e)
  }
}

export async function pollMentions(env: Bindings, db: Database): Promise<void> {
  const domain = env.MASTODON_BOT_DOMAIN
  const token = env.MASTODON_BOT_TOKEN
  if (!domain || !token) {
    console.error('Bot credentials not configured')
    return
  }

  // 读取上次处理的 notification ID
  const lastId = await env.KV.get('bot:last_notification_id')

  const notifications = await fetchNotifications(domain, token, lastId || undefined)
  if (notifications.length === 0) return

  // 按 ID 升序处理（旧的先处理）
  notifications.sort((a, b) => a.id.localeCompare(b.id))

  for (const notification of notifications) {
    try {
      await processMention(env, db, notification)
    } catch (e) {
      console.error(`Failed to process mention ${notification.id}:`, e)
    }
  }

  // 保存最新处理的 notification ID
  const latestId = notifications[notifications.length - 1].id
  await env.KV.put('bot:last_notification_id', latestId)
}
