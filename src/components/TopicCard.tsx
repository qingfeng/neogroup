import type { FC } from 'hono/jsx'
import type { Topic, User, Group } from '../db/schema'
import { resizeImage } from '../lib/utils'

interface TopicCardProps {
  topic: Topic & { user: User; group: Group }
}

export const TopicCard: FC<TopicCardProps> = ({ topic }) => {
  const date = new Date(topic.createdAt).toLocaleDateString('zh-CN')

  return (
    <div class="card">
      <div class="topic-header">
        <a href={`/user/${topic.user.id}`}>
          <img src={resizeImage(topic.user.avatarUrl, 64) || '/static/img/default-avatar.svg'} alt="" class="avatar-sm" />
        </a>
        <a href={`/user/${topic.user.id}`}>{topic.user.displayName || topic.user.username}</a>
        <span class="card-meta">发布于 <a href={`/group/${topic.group.id}`}>{topic.group.name}</a></span>
      </div>
      <h3 class="card-title">
        <a href={`/topic/${topic.id}`}>{topic.title}</a>
      </h3>
      <div class="card-meta">{date}</div>
    </div>
  )
}
