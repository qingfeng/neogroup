import type { FC } from 'hono/jsx'
import type { Group, User } from '../db/schema'

interface SidebarProps {
  hotGroups: (Group & { memberCount: number })[]
  newUsers: User[]
  userGroups?: Group[]
}

export const Sidebar: FC<SidebarProps> = ({ hotGroups, newUsers, userGroups }) => {
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

      <div class="sidebar" style="margin-top: 1rem;">
        <h3 class="sidebar-title">新用户</h3>
        <ul class="sidebar-list">
          {newUsers.map((user) => (
            <li>
              <a href={`/user/${user.id}`}>{user.displayName || user.username}</a>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}
