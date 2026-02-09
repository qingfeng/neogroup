import type { FC } from 'hono/jsx'
import { Layout } from './Layout'
import { TopicCard } from './TopicCard'
import { Sidebar } from './Sidebar'
import type { Topic, User, Group } from '../db/schema'
import { stripHtml, truncate } from '../lib/utils'

interface FeedItem {
  type: 'topic' | 'comment'
  id: string
  content: string | null
  title?: string
  createdAt: Date
  user: { id: string; username: string; displayName: string | null; avatarUrl: string | null }
  group: { id: string; name: string }
  topic?: { id: string; title: string }
}

interface HomePageProps {
  user: User | null
  feedItems: FeedItem[]
  topics: (Topic & { user: User; group: Group; likeCount: number })[]
  hotGroups: (Group & { memberCount: number })[]
  topTags: string[]
  randomGroups: Group[]
  newUsers: User[]
  userGroups: Group[]
  remoteGroupDomains?: Record<string, string>
  baseUrl: string
  unreadCount?: number
}

export const HomePage: FC<HomePageProps> = ({ user, feedItems, topics, hotGroups, topTags, randomGroups, newUsers, userGroups, remoteGroupDomains, baseUrl, unreadCount }) => {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'NeoGroup',
    url: baseUrl,
    description: 'NeoGroup 是一个基于 Mastodon 登录的去中心化小组讨论社区',
  }

  return (
    <Layout
      title="首页"
      description="NeoGroup 是一个基于 Mastodon 登录的去中心化小组讨论社区"
      image={`${baseUrl}/static/img/favicon.svg`}
      url={baseUrl}
      jsonLd={jsonLd}
      user={user}
      unreadCount={unreadCount}
    >
      <div class="grid grid-3">
        <div>
          <h2 style="margin-bottom: 1rem;">最新话题</h2>
          {topics.length > 0 ? (
            topics.map((topic) => <TopicCard topic={topic} />)
          ) : (
            <p class="card">还没有话题，快去创建一个小组开始讨论吧！</p>
          )}

          {feedItems.length > 0 && (
            <div class="feed-section">
              <h2 style="margin-bottom: 1rem;">随便看看</h2>
              {feedItems.map((item) => (
                <div class="feed-item">
                  <div class="feed-item-avatar">
                    <a href={`/user/${item.user.username}`}>
                      <img src={item.user.avatarUrl || '/static/img/default-avatar.svg'} alt="" />
                    </a>
                  </div>
                  <div class="feed-item-body">
                    <div class="feed-item-header">
                      <a href={`/user/${item.user.username}`} class="feed-item-user">{item.user.displayName || item.user.username}</a>
                      {item.type === 'topic' ? (
                        <span class="feed-item-action">发布了话题</span>
                      ) : (
                        <span class="feed-item-action">回复了 <a href={`/topic/${item.topic!.id}`}>{truncate(item.topic!.title, 20)}</a></span>
                      )}
                    </div>
                    {item.type === 'topic' ? (
                      <div class="feed-item-content">
                        <a href={`/topic/${item.id}`} class="feed-item-title">{item.title}</a>
                        {item.content && <p class="feed-item-preview">{truncate(stripHtml(item.content), 100)}</p>}
                      </div>
                    ) : (
                      <div class="feed-item-content">
                        {item.content && <p class="feed-item-preview">{truncate(stripHtml(item.content), 100)}</p>}
                      </div>
                    )}
                    <div class="feed-item-meta">
                      <a href={`/group/${item.group.id}`}>{item.group.name}</a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <Sidebar hotGroups={hotGroups} topTags={topTags} randomGroups={randomGroups} newUsers={newUsers} userGroups={user ? userGroups : undefined} remoteGroupDomains={remoteGroupDomains} />
      </div>
    </Layout>
  )
}
