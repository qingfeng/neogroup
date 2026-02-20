import { sanitizeHtml, linkifyMentions } from '../lib/utils'

interface SafeHtmlProps {
    html: string | null | undefined
    className?: string
    tag?: 'div' | 'span' | 'p'
}

/**
 * A component that safely renders HTML content with XSS protection.
 * Sanitizes the HTML to remove dangerous tags (script, style, form, input, etc.)
 * while preserving safe formatting tags (p, br, a, span).
 */
export function SafeHtml({ html, className, tag = 'div' }: SafeHtmlProps) {
    if (!html) return null

    const sanitized = linkifyMentions(sanitizeHtml(html))

    if (tag === 'span') {
        return <span class={className} dangerouslySetInnerHTML={{ __html: sanitized }} />
    }
    if (tag === 'p') {
        return <p class={className} dangerouslySetInnerHTML={{ __html: sanitized }} />
    }
    return <div class={className} dangerouslySetInnerHTML={{ __html: sanitized }} />
}
