const DEFAULT_DESCRIPTION = 'NeoGroup 是一个去中心化小组讨论社区'

export function stripText(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildSeoDescription(input: string | null | undefined, fallback = DEFAULT_DESCRIPTION, maxLength = 160): string {
  const text = stripText(input || '') || fallback
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text
}

export function buildCanonicalUrl(rawUrl: string): string {
  const url = normalizeUrl(rawUrl)
  return `${url.origin}${url.pathname}`
}

export function normalizeSiteUrl(rawUrl: string): string {
  const url = normalizeUrl(rawUrl)
  return url.origin
}

function normalizeUrl(rawUrl: string): URL {
  const url = new URL(rawUrl)
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    url.protocol = 'https:'
  }
  return url
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildWebsiteJsonLd(siteName: string, baseUrl: string): Record<string, any> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName,
    url: baseUrl,
    description: DEFAULT_DESCRIPTION,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${baseUrl}/search?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  }
}

export function buildBreadcrumbJsonLd(items: Array<{ name: string; url: string }>): Record<string, any> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  }
}
