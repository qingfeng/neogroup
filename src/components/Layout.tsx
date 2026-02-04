import type { FC, PropsWithChildren } from 'hono/jsx'
import { Navbar } from './Navbar'
import type { User } from '../db/schema'

interface LayoutProps {
  title?: string
  user: User | null
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, user, children }) => {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title ? `${title} - NeoGroup` : 'NeoGroup'}</title>
        <link rel="stylesheet" href="/static/css/style.css" />
      </head>
      <body>
        <Navbar user={user} />
        <main class="container">
          {children}
        </main>
        <footer class="footer">
          <p>NeoGroup &copy; 2024</p>
        </footer>
      </body>
    </html>
  )
}
