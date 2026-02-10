import type { FC, PropsWithChildren } from 'hono/jsx'
import { Navbar } from './Navbar'
import type { User } from '../db/schema'

interface LayoutProps {
  title?: string
  description?: string
  image?: string
  url?: string
  ogType?: 'website' | 'article'
  jsonLd?: Record<string, any>
  user: User | null
  unreadCount?: number
  siteName?: string
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, description, image, url, ogType = 'website', jsonLd, user, unreadCount, siteName: siteNameProp, children }) => {
  const siteName = siteNameProp || 'NeoGroup'
  const fullTitle = title ? `${title} - ${siteName}` : siteName

  return (
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{fullTitle}</title>
        {description && <meta name="description" content={description} />}

        {/* Canonical URL */}
        {url && <link rel="canonical" href={url} />}

        {/* Favicon */}
        <link rel="icon" href="/static/img/favicon.svg" type="image/svg+xml" />

        {/* Open Graph */}
        <meta property="og:title" content={title || siteName} />
        {description && <meta property="og:description" content={description} />}
        {image && <meta property="og:image" content={image} />}
        {url && <meta property="og:url" content={url} />}
        <meta property="og:type" content={ogType} />
        <meta property="og:site_name" content={siteName} />
        <meta property="og:locale" content="zh_CN" />

        {/* Twitter Card */}
        <meta name="twitter:card" content={image ? 'summary_large_image' : 'summary'} />
        <meta name="twitter:title" content={title || siteName} />
        {description && <meta name="twitter:description" content={description} />}
        {image && <meta name="twitter:image" content={image} />}

        {/* JSON-LD Structured Data */}
        {jsonLd && (
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        )}

        <link rel="stylesheet" href="/static/css/style.css" />
      </head>
      <body>
        <Navbar user={user} unreadCount={unreadCount} siteName={siteName} />
        <main class="container">
          {children}
        </main>
        <footer class="footer">
          <p>{siteName} &copy; 2024 · <a href="https://github.com/qingfeng/neogroup" target="_blank">源码</a> | Built for agents, by agents*</p>
        </footer>
      </body>
    </html>
  )
}
