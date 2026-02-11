import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import type { Database } from '../db'
import { users } from '../db/schema'

export function generateId(): string {
  return nanoid(12)
}

// API Key 生成：neogrp_ + 32位 hex（128 bit 熵）
export async function generateApiKey(): Promise<{ key: string; hash: string; keyId: string }> {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  const key = `neogrp_${hex}`
  const hash = await hashApiKey(key)
  const keyId = nanoid(12)
  return { key, hash, keyId }
}

// SHA-256 哈希（存储用，原始 key 不落盘）
export async function hashApiKey(key: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function isSuperAdmin(user: { role?: string | null } | null): boolean {
  return user?.role === 'admin'
}

// 统一的 Mastodon 用户名生成：返回原始用户名（冲突由后缀处理）
export function mastodonUsername(username: string, domain: string): string {
  void domain
  return username
}

const MAX_USERNAME_ATTEMPTS = 20

function random4Digits(): string {
  const n = Math.floor(Math.random() * 10000)
  return n.toString().padStart(4, '0')
}

export async function ensureUniqueUsername(db: Database, base: string): Promise<string> {
  let candidate = base
  for (let i = 0; i < MAX_USERNAME_ATTEMPTS; i++) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, candidate))
      .limit(1)

    if (existing.length === 0) return candidate
    candidate = `${base}${random4Digits()}`
  }

  throw new Error(`Failed to generate unique username for ${base}`)
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

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Sanitize HTML to prevent XSS attacks.
 * Uses strict whitelist approach:
 * - Allowed tags: p, br, a, span, strong, em, b, i, u, ul, ol, li, img, blockquote, pre, code, div, h1-h3
 * - Non-whitelisted tags are escaped (< > become &lt; &gt;)
 * - Allowed attributes are strictly filtered
 * - Event handlers and dangerous URLs are removed
 */
export function sanitizeHtml(html: string): string {
  if (!html) return ''

  // Whitelist of allowed tags
  const allowedTags = new Set([
    'p', 'br', 'a', 'span', 'strong', 'em', 'b', 'i', 'u',
    'ul', 'ol', 'li', 'img', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'div'
  ])

  // Process each tag in the HTML
  let result = html.replace(/<(\/?)([\w-]+)([^>]*)>/gi, (match, slash, tagName, attrs) => {
    const tag = tagName.toLowerCase()

    // If tag is not in whitelist, escape it
    if (!allowedTags.has(tag)) {
      return match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    // For closing tags, just return the clean version
    if (slash === '/') {
      return `</${tag}>`
    }

    // For opening tags, sanitize attributes
    let safeAttrs = ''

    // Remove all event handlers first
    attrs = attrs.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    attrs = attrs.replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '')

    if (tag === 'a') {
      // For <a> tags, only allow safe href
      const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i)
      if (hrefMatch && !hrefMatch[1].match(/^(javascript|data|vbscript):/i)) {
        safeAttrs = ` href="${escapeAttr(hrefMatch[1])}" target="_blank" rel="noopener nofollow"`
      }
    } else if (tag === 'img') {
      // For <img> tags, allow safe src, alt, and class
      const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i)
      const altMatch = attrs.match(/alt\s*=\s*["']([^"']*?)["']/i)
      const classMatch = attrs.match(/class\s*=\s*["']([^"']+)["']/i)
      if (srcMatch && !srcMatch[1].match(/^(javascript|data|vbscript):/i)) {
        safeAttrs = ` src="${escapeAttr(srcMatch[1])}"`
        if (altMatch) {
          safeAttrs += ` alt="${escapeAttr(altMatch[1])}"`
        }
        if (classMatch) {
          safeAttrs += ` class="${escapeAttr(classMatch[1])}"`
        }
      } else {
        // Invalid img, escape it
        return match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
      }
    } else if (tag === 'span' || tag === 'div') {
      // For <span> and <div> tags, allow class and data-neodb attributes
      const classMatch = attrs.match(/class\s*=\s*["']([^"']+)["']/i)
      const dataMatch = attrs.match(/data-neodb\s*=\s*["']([^"']+)["']/i)
      const editableMatch = attrs.match(/contenteditable\s*=\s*["']([^"']+)["']/i)
      if (classMatch) {
        safeAttrs += ` class="${escapeAttr(classMatch[1])}"`
      }
      if (dataMatch) {
        safeAttrs += ` data-neodb="${escapeAttr(dataMatch[1])}"`
      }
      if (editableMatch && editableMatch[1] === 'false') {
        safeAttrs += ' contenteditable="false"'
      }
    }
    // Other allowed tags: no attributes

    return `<${tag}${safeAttrs}>`
  })

  return result
}

// Helper: escape attribute values
function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
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
  siteUrl: string,
  appName?: string
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
      headers: { 'User-Agent': `${appName || 'NeoGroup'}/1.0` },
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
