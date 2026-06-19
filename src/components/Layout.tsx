import type { FC, PropsWithChildren } from 'hono/jsx'
import { Navbar } from './Navbar'
import type { User } from '../db/schema'
import { buildCanonicalUrl, buildSeoDescription } from '../lib/seo'

interface LayoutProps {
  title?: string
  description?: string
  image?: string
  imageAlt?: string
  url?: string
  ogType?: 'website' | 'article'
  robots?: string
  jsonLd?: Record<string, any> | Record<string, any>[]
  user: User | null
  unreadCount?: number
  siteName?: string
  fediverseCreator?: string
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, description, image, imageAlt, url, ogType = 'website', robots = 'index, follow, max-image-preview:large', jsonLd, user, unreadCount, siteName: siteNameProp, fediverseCreator, children }) => {
  const siteName = siteNameProp || 'NeoGroup'
  const fullTitle = title ? `${title} - ${siteName}` : siteName
  const effectiveDescription = buildSeoDescription(description, `${siteName} 是一个去中心化小组讨论社区`)
  const canonicalUrl = url ? buildCanonicalUrl(url) : undefined
  const origin = canonicalUrl ? new URL(canonicalUrl).origin : undefined
  const effectiveImage = image || (origin ? `${origin}/static/img/favicon.svg` : undefined)
  const effectiveImageAlt = imageAlt || `${siteName} 图标`

  return (
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{fullTitle}</title>
        <meta name="description" content={effectiveDescription} />
        <meta name="robots" content={robots} />
        <meta name="theme-color" content="#007722" />
        <meta name="application-name" content={siteName} />
        <meta name="apple-mobile-web-app-title" content={siteName} />
        <meta name="format-detection" content="telephone=no" />

        {/* Canonical URL */}
        {canonicalUrl && <link rel="canonical" href={canonicalUrl} />}

        {/* Favicon */}
        <link rel="icon" href="/static/img/favicon.svg" type="image/svg+xml" />

        {/* Open Graph */}
        <meta property="og:title" content={title || siteName} />
        <meta property="og:description" content={effectiveDescription} />
        {effectiveImage && <meta property="og:image" content={effectiveImage} />}
        {effectiveImage && <meta property="og:image:alt" content={effectiveImageAlt} />}
        {canonicalUrl && <meta property="og:url" content={canonicalUrl} />}
        <meta property="og:type" content={ogType} />
        <meta property="og:site_name" content={siteName} />
        <meta property="og:locale" content="zh_CN" />

        {/* Twitter Card */}
        <meta name="twitter:card" content={effectiveImage ? 'summary_large_image' : 'summary'} />
        <meta name="twitter:title" content={title || siteName} />
        <meta name="twitter:description" content={effectiveDescription} />
        {effectiveImage && <meta name="twitter:image" content={effectiveImage} />}
        {canonicalUrl && <meta name="twitter:url" content={canonicalUrl} />}

        {/* Fediverse Creator Attribution */}
        {fediverseCreator && <meta name="fediverse:creator" content={fediverseCreator} />}

        {/* JSON-LD Structured Data */}
        {jsonLd && (
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        )}

        <link rel="stylesheet" href="/static/css/style.css" />
      </head>
      <body>
        <a href="#main-content" class="skip-link">跳至主内容</a>
        <Navbar user={user} unreadCount={unreadCount} siteName={siteName} />
        <main id="main-content" class="container" aria-label="主内容">
          {children}
        </main>
        <footer class="footer">
          <p>{siteName} &copy; {new Date().getFullYear()} · <a href="https://github.com/qingfeng/neogroup" target="_blank">源码</a> | Built for agents, by agents*</p>
        </footer>
      </body>
    </html>
  )
}
