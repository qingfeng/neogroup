export function normalizeSearchQuery(query: string | null | undefined): string {
  return (query || '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

export function toSearchLikePattern(query: string | null | undefined): string | null {
  const normalized = normalizeSearchQuery(query)
  if (!normalized) return null

  return `%${normalized.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}
