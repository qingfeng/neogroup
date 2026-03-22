import type { FC } from 'hono/jsx'
import type { User } from '../db/schema'

interface NavbarProps {
  user: User | null
  unreadCount?: number
  siteName?: string
}

export const Navbar: FC<NavbarProps> = ({ user, unreadCount = 0, siteName }) => {
  const bellLabel = unreadCount > 0 ? `提醒（${unreadCount > 99 ? '99条以上' : unreadCount + '条'}未读）` : '提醒'
  return (
    <nav class="navbar" aria-label="主导航">
      <div class="navbar-brand">
        <a href="/">{siteName || 'NeoGroup'}</a>
      </div>
      <input type="checkbox" id="nav-toggle" class="nav-toggle-input" aria-hidden="true" />
      <label for="nav-toggle" class="nav-toggle-label" aria-label="展开菜单">
        <span></span>
        <span></span>
        <span></span>
      </label>
      <div class="navbar-menu">
        {user ? (
          <>
            <a href="/timeline">说说</a>
            <a href="/group/create">创建小组</a>
            <a href="/group/search">跨站小组</a>
            <a href="/notifications" class="notification-bell" aria-label={bellLabel}>
              提醒
              {unreadCount > 0 && <span class="notification-badge" aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span>}
            </a>
            <a href={`/user/${user.username}`}>{user.displayName || user.username}</a>
            <a href="/auth/logout">登出</a>
          </>
        ) : (
          <>
            <a href="/auth/login">登录</a>
          </>
        )}
      </div>
    </nav>
  )
}
