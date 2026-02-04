import type { FC } from 'hono/jsx'
import type { User } from '../db/schema'

interface NavbarProps {
  user: User | null
}

export const Navbar: FC<NavbarProps> = ({ user }) => {
  return (
    <nav class="navbar">
      <div class="navbar-brand">
        <a href="/">NeoGroup</a>
      </div>
      <div class="navbar-menu">
        {user ? (
          <>
            <a href="/group/create">创建小组</a>
            <a href={`/user/${user.username}`}>{user.displayName || user.username}</a>
            <a href="/auth/logout">登出</a>
          </>
        ) : (
          <a href="/auth/login">登录</a>
        )}
      </div>
    </nav>
  )
}
