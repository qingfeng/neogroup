export interface MastodonContextTarget {
  domain: string
  statusId: string
  rootStatusId: string
  storesCanonicalUri: boolean
}

export function resolveMastodonContextTarget(
  mastodonDomain: string,
  mastodonStatusId: string,
): MastodonContextTarget {
  if (mastodonDomain === 'activitypub_origin' && looksLikeUrl(mastodonStatusId)) {
    const url = new URL(mastodonStatusId)
    const statusId = lastPathSegment(url.pathname) || mastodonStatusId
    return {
      domain: url.hostname,
      statusId,
      rootStatusId: statusId,
      storesCanonicalUri: true,
    }
  }

  return {
    domain: mastodonDomain,
    statusId: mastodonStatusId,
    rootStatusId: mastodonStatusId,
    storesCanonicalUri: false,
  }
}

function looksLikeUrl(value: string): boolean {
  return value.startsWith('https://') || value.startsWith('http://')
}

function lastPathSegment(pathname: string): string | null {
  return pathname.split('/').filter(Boolean).at(-1) || null
}
