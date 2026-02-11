import type { FC } from 'hono/jsx'
import type { Topic, User, Group } from '../db/schema'
import { stripHtml, truncate } from '../lib/utils'

interface TopicCardProps {
  topic: Topic & { user: User; group: Group | null; replyCount: number }
}

export const TopicCard: FC<TopicCardProps> = ({ topic }) => {
  const date = new Date(topic.createdAt).toLocaleDateString('zh-CN')
  const preview = topic.content ? truncate(stripHtml(topic.content), 150) : null
  const isPersonalPost = !topic.title || topic.title === ''

  return (
    <div class="topic-card">
      <div class="topic-card-likes">
        <span class="topic-card-like-count">{topic.replyCount}</span>
        <span class="topic-card-like-label">回复</span>
      </div>
      <div class="topic-card-main">
        {isPersonalPost ? (
          <div class="topic-card-preview">
            <a href={`/topic/${topic.id}`}>{preview || '...'}</a>
          </div>
        ) : (
          <h3 class="topic-card-title">
            <a href={`/topic/${topic.id}`}>{topic.title}</a>
          </h3>
        )}
        {!isPersonalPost && preview && (
          <p class="topic-card-preview">{preview}</p>
        )}
        <div class="topic-card-meta">
          {topic.group ? (
            <>来自<a href={`/group/${topic.group.id}`}>{topic.group.name}</a></>
          ) : (
            <span>个人动态</span>
          )}
          <span class="topic-card-date">{date}</span>
        </div>
      </div>
    </div>
  )
}
