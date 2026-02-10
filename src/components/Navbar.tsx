import type { FC } from 'hono/jsx'
import type { User } from '../db/schema'

interface NavbarProps {
  user: User | null
  unreadCount?: number
  siteName?: string
}

export const Navbar: FC<NavbarProps> = ({ user, unreadCount = 0, siteName }) => {
  return (
    <nav class="navbar">
      <div class="navbar-brand">
        <a href="/">{siteName || 'NeoGroup'}</a>
      </div>
      <div class="navbar-menu">
        {user ? (
          <>
            <a href="/group/create">创建小组</a>
            <a href="/group/search">远程社区</a>
            <a href="https://neodb.social/" target="_blank" rel="noopener">书影音</a>
            <a href="/notifications" class="notification-bell">
              提醒
              {unreadCount > 0 && <span class="notification-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
            </a>
            <a href={`/user/${user.username}`}>{user.displayName || user.username}</a>
            <a href="/auth/logout">登出</a>
          </>
        ) : (
          <a href="/auth/login">用 Mastodon 登录</a>
        )}
      </div>
    </nav>
  )
}
