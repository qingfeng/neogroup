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
  group: { id: string; name: string } | null
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
  siteName?: string
  source?: string
  hasRemoteGroups?: boolean
}

export const HomePage: FC<HomePageProps> = ({ user, feedItems, topics, hotGroups, topTags, randomGroups, newUsers, userGroups, remoteGroupDomains, baseUrl, unreadCount, siteName, source, hasRemoteGroups }) => {
  const name = siteName || 'NeoGroup'
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name,
    url: baseUrl,
    description: `${name} 是一个基于 Mastodon 登录的去中心化小组讨论社区`,
  }

  return (
    <Layout
      title="首页"
      description={`${name} 是一个基于 Mastodon 登录的去中心化小组讨论社区`}
      siteName={name}
      image={`${baseUrl}/static/img/favicon.svg`}
      url={baseUrl}
      jsonLd={jsonLd}
      user={user}
      unreadCount={unreadCount}
    >
      <div class="grid grid-3">
        <div>
          <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 1rem;">
            <h2 style="margin: 0;">最新话题</h2>
            <div style="display: flex; gap: 8px; font-size: 14px;">
              {hasRemoteGroups && (
                <>
                  <a href="/" style={source === 'local' ? 'font-weight: bold; color: #333; text-decoration: none;' : 'color: #666; text-decoration: none;'}>本地小组</a>
                  <span style="color: #ccc;">|</span>
                  <a href="/?source=remote" style={source === 'remote' ? 'font-weight: bold; color: #333; text-decoration: none;' : 'color: #666; text-decoration: none;'}>跨站小组</a>
                  <span style="color: #ccc;">|</span>
                </>
              )}
              <a href="/?source=random" style={source === 'random' ? 'font-weight: bold; color: #333; text-decoration: none;' : 'color: #666; text-decoration: none;'}>随便看看</a>
            </div>
          </div>
          {source !== 'random' ? (
            topics.length > 0 ? (
              topics.map((topic) => <TopicCard topic={topic} />)
            ) : (
              <p class="card">还没有话题，快去创建一个小组开始讨论吧！</p>
            )
          ) : feedItems.length > 0 ? (
            <div class="feed-section">
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
                      {item.group ? (
                        <a href={`/group/${(item.group as any).actorName || item.group.id}`}>{item.group.name}</a>
                      ) : (
                        <span>个人动态</span>
                      )}
                      <span style="margin-left: 8px;">{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p class="card">暂无内容</p>
          )}
        </div>
        <Sidebar hotGroups={hotGroups} topTags={topTags} randomGroups={randomGroups} newUsers={newUsers} userGroups={user ? userGroups : undefined} remoteGroupDomains={remoteGroupDomains} />
      </div>
    </Layout>
  )
}
