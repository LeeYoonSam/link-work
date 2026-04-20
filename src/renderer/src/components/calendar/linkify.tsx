import React from 'react'

const URL_REGEX = /https?:\/\/[^\s<>"']+/gi
const ANCHOR_REGEX = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi

interface LinkPart {
  type: 'text' | 'link'
  content: string
  href?: string
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function splitTextWithUrls(text: string): LinkPart[] {
  const out: LinkPart[] = []
  let lastIdx = 0
  let m: RegExpExecArray | null
  const re = new RegExp(URL_REGEX.source, URL_REGEX.flags)
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) {
      out.push({ type: 'text', content: text.slice(lastIdx, m.index) })
    }
    const url = m[0].replace(/[.,;:)\]}'"]+$/, '')
    out.push({ type: 'link', content: url, href: url })
    lastIdx = m.index + url.length
  }
  if (lastIdx < text.length) {
    out.push({ type: 'text', content: text.slice(lastIdx) })
  }
  return out
}

export function parseDescriptionParts(description: string): LinkPart[] {
  const parts: LinkPart[] = []
  const segments: Array<{ start: number; end: number; href: string; text: string }> = []
  const re = new RegExp(ANCHOR_REGEX.source, ANCHOR_REGEX.flags)
  let match: RegExpExecArray | null
  while ((match = re.exec(description)) !== null) {
    const href = decodeHtmlEntities(match[1])
    const innerRaw = match[2].replace(/<[^>]+>/g, '')
    const innerText = decodeHtmlEntities(innerRaw).trim() || href
    segments.push({
      start: match.index,
      end: match.index + match[0].length,
      href,
      text: innerText
    })
  }

  let cursor = 0
  for (const seg of segments) {
    if (seg.start > cursor) {
      const chunk = decodeHtmlEntities(description.slice(cursor, seg.start))
      parts.push(...splitTextWithUrls(chunk))
    }
    parts.push({ type: 'link', content: seg.text, href: seg.href })
    cursor = seg.end
  }
  if (cursor < description.length) {
    const chunk = decodeHtmlEntities(description.slice(cursor))
    parts.push(...splitTextWithUrls(chunk))
  }

  return parts
}

interface RenderOptions {
  linkClassName?: string
  onLinkClick?: (href: string) => void
}

export function renderDescription(
  description: string,
  options: RenderOptions = {}
): React.ReactNode[] {
  const parts = parseDescriptionParts(description)
  const linkClass =
    options.linkClassName ?? 'text-blue-600 hover:text-blue-700 underline break-all'

  return parts.map((part, idx) => {
    if (part.type === 'link' && part.href) {
      const href = part.href
      return (
        <a
          key={idx}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (options.onLinkClick) {
              options.onLinkClick(href)
            } else {
              window.api.document.open(href, 'link')
            }
          }}
        >
          {part.content}
        </a>
      )
    }
    return <React.Fragment key={idx}>{part.content}</React.Fragment>
  })
}
