import type { FC } from 'hono/jsx'
import { Layout } from './Layout'
import { TopicCard } from './TopicCard'
import { Sidebar } from './Sidebar'
import type { Topic, User, Group } from '../db/schema'

interface HomePageProps {
  user: User | null
  topics: (Topic & { user: User; group: Group; likeCount: number })[]
  hotGroups: (Group & { memberCount: number })[]
  randomGroups: Group[]
  newUsers: User[]
  userGroups: Group[]
  baseUrl: string
}

export const HomePage: FC<HomePageProps> = ({ user, topics, hotGroups, randomGroups, newUsers, userGroups, baseUrl }) => {
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
      url={baseUrl}
      jsonLd={jsonLd}
      user={user}
    >
      <div class="grid grid-3">
        <div>
          <h2 style="margin-bottom: 1rem;">最新话题</h2>
          {topics.length > 0 ? (
            topics.map((topic) => <TopicCard topic={topic} />)
          ) : (
            <p class="card">还没有话题，快去创建一个小组开始讨论吧！</p>
          )}
        </div>
        <Sidebar hotGroups={hotGroups} randomGroups={randomGroups} newUsers={newUsers} userGroups={user ? userGroups : undefined} />
      </div>
    </Layout>
  )
}
