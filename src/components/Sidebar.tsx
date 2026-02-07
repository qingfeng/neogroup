import type { FC } from 'hono/jsx'
import type { Group, User } from '../db/schema'

interface SidebarProps {
  hotGroups: (Group & { memberCount: number })[]
  topTags?: string[]
  randomGroups?: Group[]
  newUsers: User[]
  userGroups?: Group[]
}

export const Sidebar: FC<SidebarProps> = ({ hotGroups, topTags, randomGroups, newUsers, userGroups }) => {
  return (
    <aside>
      {userGroups && userGroups.length > 0 && (
        <div class="sidebar">
          <h3 class="sidebar-title">我的小组</h3>
          <ul class="sidebar-list">
            {userGroups.map((group) => (
              <li>
                <a href={`/group/${group.id}`}>{group.name}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {topTags && topTags.length > 0 && (
        <div class="sidebar" style="margin-top: 1rem;">
          <h3 class="sidebar-title">小组标签</h3>
          <div class="sidebar-tags">
            {topTags.map((tag) => (
              <a href={`/group/tag/${encodeURIComponent(tag)}`} class="group-tag">{tag}</a>
            ))}
          </div>
        </div>
      )}

      <div class="sidebar" style="margin-top: 1rem;">
        <h3 class="sidebar-title">热门小组</h3>
        <ul class="sidebar-list">
          {hotGroups.map((group) => (
            <li>
              <a href={`/group/${group.id}`}>{group.name}</a>
              <span class="card-meta"> ({group.memberCount} 成员)</span>
            </li>
          ))}
        </ul>
      </div>

      {randomGroups && randomGroups.length > 0 && (
        <div class="sidebar" style="margin-top: 1rem;">
          <h3 class="sidebar-title">随机小组</h3>
          <ul class="sidebar-list">
            {randomGroups.map((group) => (
              <li>
                <a href={`/group/${group.id}`}>{group.name}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div class="sidebar" style="margin-top: 1rem;">
        <h3 class="sidebar-title">新用户</h3>
        <ul class="sidebar-list">
          {newUsers.map((user) => (
            <li>
              <a href={`/user/${user.username}`}>{user.displayName || user.username}</a>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}
