import type { FC } from 'hono/jsx'
import type { Topic, User, Group } from '../db/schema'
import { stripHtml, truncate } from '../lib/utils'

interface TopicCardProps {
  topic: Topic & { user: User; group: Group; replyCount: number }
}

export const TopicCard: FC<TopicCardProps> = ({ topic }) => {
  const date = new Date(topic.createdAt).toLocaleDateString('zh-CN')
  const preview = topic.content ? truncate(stripHtml(topic.content), 150) : null

  return (
    <div class="topic-card">
      <div class="topic-card-likes">
        <span class="topic-card-like-count">{topic.replyCount}</span>
        <span class="topic-card-like-label">回复</span>
      </div>
      <div class="topic-card-main">
        <h3 class="topic-card-title">
          <a href={`/topic/${topic.id}`}>{topic.title}</a>
        </h3>
        {preview && (
          <p class="topic-card-preview">{preview}</p>
        )}
        <div class="topic-card-meta">
          来自<a href={`/group/${topic.group.id}`}>{topic.group.name}</a>
          <span class="topic-card-date">{date}</span>
        </div>
      </div>
    </div>
  )
}
