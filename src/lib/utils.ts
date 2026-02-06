import { nanoid } from 'nanoid'

export function generateId(): string {
  return nanoid(12)
}

export function isSuperAdmin(user: { role?: string | null } | null): boolean {
  return user?.role === 'admin'
}

// 统一的 Mastodon 用户名生成：qingfeng@douban.city → qingfeng_douban_city
export function mastodonUsername(username: string, domain: string): string {
  return `${username}_${domain.replace(/\./g, '_')}`
}

export function now(): Date {
  return new Date()
}

export function parseJson<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try {
    return JSON.parse(str) as T
  } catch {
    return fallback
  }
}

export function toJson(obj: unknown): string {
  return JSON.stringify(obj)
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Sanitize HTML to prevent XSS attacks.
 * Only allows safe tags: p, br, a, span
 * Only allows safe attributes: href (for a), class, rel
 * Removes all dangerous elements: script, style, form, input, etc.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return ''

  // Remove dangerous tags completely (including content)
  let sanitized = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>.*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>.*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')

  // Remove dangerous self-closing/void tags
  sanitized = sanitized
    .replace(/<(input|form|button|select|textarea|label|fieldset|meta|link|base)[^>]*\/?>/gi, '')
    .replace(/<\/(input|form|button|select|textarea|label|fieldset)>/gi, '')

  // Remove event handlers (onclick, onerror, etc.)
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '')

  // Remove javascript: and data: URLs
  sanitized = sanitized.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, '')
  sanitized = sanitized.replace(/href\s*=\s*["']data:[^"']*["']/gi, '')
  sanitized = sanitized.replace(/src\s*=\s*["']javascript:[^"']*["']/gi, '')
  sanitized = sanitized.replace(/src\s*=\s*["']data:[^"']*["']/gi, '')

  // Remove dangerous attributes (except href on a tags, class, rel, target)
  sanitized = sanitized.replace(/<a\b([^>]*)>/gi, (match, attrs) => {
    // Keep only safe attributes for <a> tags
    const safeAttrs: string[] = []
    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i)
    const relMatch = attrs.match(/rel\s*=\s*["']([^"']+)["']/i)
    const classMatch = attrs.match(/class\s*=\s*["']([^"']+)["']/i)

    if (hrefMatch && !hrefMatch[1].match(/^(javascript|data):/i)) {
      safeAttrs.push(`href="${hrefMatch[1]}"`)
      safeAttrs.push('target="_blank"')
      safeAttrs.push('rel="noopener nofollow"')
    }
    if (classMatch) {
      safeAttrs.push(`class="${classMatch[1]}"`)
    }

    return `<a ${safeAttrs.join(' ')}>`
  })

  // For span tags, only keep class attribute
  sanitized = sanitized.replace(/<span\b([^>]*)>/gi, (match, attrs) => {
    const classMatch = attrs.match(/class\s*=\s*["']([^"']+)["']/i)
    return classMatch ? `<span class="${classMatch[1]}">` : '<span>'
  })

  return sanitized
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength).trim() + '...'
}

// 生成带裁剪参数的图片 URL
export function resizeImage(url: string | null | undefined, size: number): string {
  if (!url) return ''
  // 只对 R2 图片添加裁剪参数
  if (url.includes('/r2/')) {
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}w=${size}&h=${size}`
  }
  return url
}

// 处理内容中的 R2 图片，添加裁剪参数
export function processContentImages(html: string, maxWidth: number = 800): string {
  if (!html) return html
  return html.replace(
    /(<img\s[^>]*src=["'])([^"']*\/r2\/[^"'?]*)([^"']*)(["'][^>]*>)/gi,
    (match, prefix, url, existingQuery, suffix) => {
      // 跳过已有裁剪参数的
      if (existingQuery.includes('w=')) return match
      const separator = existingQuery ? '&' : '?'
      return `${prefix}${url}${existingQuery}${separator}w=${maxWidth}${suffix}`
    }
  )
}

// 从 URL 获取文件扩展名
export function getExtensionFromUrl(url: string): string {
  const match = url.match(/\.(\w+)(\?|$)/)
  if (match) {
    const ext = match[1].toLowerCase()
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      return ext === 'jpg' ? 'jpeg' : ext
    }
  }
  return 'png'
}

// 获取 Content-Type
export function getContentType(ext: string): string {
  const types: Record<string, string> = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  }
  return types[ext] || 'image/png'
}

// 上传头像到 R2
export async function uploadAvatarToR2(
  r2: R2Bucket | undefined,
  userId: string,
  avatarUrl: string,
  siteUrl: string
): Promise<string> {
  if (!r2 || !avatarUrl) {
    return avatarUrl
  }

  // 跳过已经是本站 R2 的 URL
  if (avatarUrl.includes('/r2/avatars/')) {
    return avatarUrl
  }

  // 跳过默认头像
  if (avatarUrl.includes('default-avatar') || avatarUrl.includes('missing.png')) {
    return '/static/img/default-avatar.svg'
  }

  try {
    // 下载头像
    const response = await fetch(avatarUrl, {
      headers: { 'User-Agent': 'NeoGroup/1.0' },
    })

    if (!response.ok) {
      console.error(`Failed to download avatar: ${response.status}`)
      return '/static/img/default-avatar.svg'
    }

    const buffer = await response.arrayBuffer()
    const ext = getExtensionFromUrl(avatarUrl)
    const contentType = getContentType(ext)
    const key = `avatars/${userId}.${ext}`

    // 上传到 R2
    await r2.put(key, buffer, {
      httpMetadata: { contentType },
    })

    return `${siteUrl}/r2/${key}`
  } catch (error) {
    console.error('Failed to upload avatar to R2:', error)
    return avatarUrl // 失败时返回原 URL
  }
}
