// Notion API 응답(블록 트리) → 마크다운 변환 (순수 함수 — Electron 의존 없음, 단위 테스트 대상)
//
// Notion 블록 스키마는 방대하므로 실무에서 자주 쓰는 타입만 지원하고,
// 미지원 타입은 "[미지원 블록: type]"으로 표시해 내용 누락을 알 수 있게 한다.

interface NotionRichText {
  plain_text?: string
  href?: string | null
  annotations?: {
    bold?: boolean
    italic?: boolean
    strikethrough?: boolean
    code?: boolean
  }
}

export interface NotionBlock {
  id: string
  type: string
  has_children?: boolean
  children?: NotionBlock[]
  [key: string]: unknown
}

// Notion URL(notion.so / notion.site)에서 32자리 hex 페이지 ID를 추출한다.
// 예: https://www.notion.so/workspace/제목-0123456789abcdef0123456789abcdef?pvs=4
export function extractNotionPageId(input: string): string | null {
  const trimmed = input.trim()
  // 이미 ID 형태 (hex 32자리 또는 UUID)
  const bare = trimmed.replace(/-/g, '')
  if (/^[0-9a-f]{32}$/i.test(bare)) return formatNotionId(bare)

  let path: string
  try {
    const url = new URL(trimmed)
    if (!/(^|\.)notion\.(so|site)$/i.test(url.hostname)) return null
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  // 경로 마지막 세그먼트 끝의 32자리 hex가 페이지 ID
  const match = path.match(/([0-9a-f]{32})(?:[^0-9a-f]|$)/i)
  return match ? formatNotionId(match[1]) : null
}

// API는 UUID 형식(8-4-4-4-12)을 요구한다
function formatNotionId(hex32: string): string {
  const h = hex32.toLowerCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function richTextToMarkdown(richText: NotionRichText[] | undefined): string {
  if (!Array.isArray(richText)) return ''
  return richText
    .map((rt) => {
      let text = rt.plain_text ?? ''
      if (!text) return ''
      const a = rt.annotations ?? {}
      if (a.code) text = `\`${text}\``
      if (a.bold) text = `**${text}**`
      if (a.italic) text = `*${text}*`
      if (a.strikethrough) text = `~~${text}~~`
      if (rt.href) text = `[${text}](${rt.href})`
      return text
    })
    .join('')
}

function blockText(block: NotionBlock): string {
  const data = block[block.type] as { rich_text?: NotionRichText[] } | undefined
  return richTextToMarkdown(data?.rich_text)
}

function childrenToMarkdown(block: NotionBlock, indent: string): string {
  if (!block.children?.length) return ''
  const inner = blocksToMarkdown(block.children, indent)
  return inner ? `\n${inner}` : ''
}

// 블록 배열 → 마크다운. indent는 리스트 중첩용 접두어.
export function blocksToMarkdown(blocks: NotionBlock[], indent = ''): string {
  const lines: string[] = []
  let numberedIndex = 0

  for (const block of blocks) {
    if (block.type !== 'numbered_list_item') numberedIndex = 0

    switch (block.type) {
      case 'paragraph': {
        const text = blockText(block)
        if (text) lines.push(indent + text)
        if (block.children?.length) {
          const inner = blocksToMarkdown(block.children, indent + '  ')
          if (inner) lines.push(inner)
        }
        break
      }
      case 'heading_1':
        lines.push(`${indent}# ${blockText(block)}`)
        break
      case 'heading_2':
        lines.push(`${indent}## ${blockText(block)}`)
        break
      case 'heading_3':
        lines.push(`${indent}### ${blockText(block)}`)
        break
      case 'bulleted_list_item':
        lines.push(`${indent}- ${blockText(block)}${childrenToMarkdown(block, indent + '  ')}`)
        break
      case 'numbered_list_item':
        numberedIndex += 1
        lines.push(`${indent}${numberedIndex}. ${blockText(block)}${childrenToMarkdown(block, indent + '   ')}`)
        break
      case 'to_do': {
        const checked = (block.to_do as { checked?: boolean } | undefined)?.checked
        lines.push(`${indent}- [${checked ? 'x' : ' '}] ${blockText(block)}${childrenToMarkdown(block, indent + '  ')}`)
        break
      }
      case 'toggle':
        lines.push(`${indent}- ${blockText(block)}${childrenToMarkdown(block, indent + '  ')}`)
        break
      case 'quote':
        lines.push(`${indent}> ${blockText(block)}${childrenToMarkdown(block, indent)}`)
        break
      case 'callout': {
        const icon = (block.callout as { icon?: { emoji?: string } } | undefined)?.icon?.emoji ?? ''
        lines.push(`${indent}> ${icon ? `${icon} ` : ''}${blockText(block)}${childrenToMarkdown(block, indent)}`)
        break
      }
      case 'code': {
        const lang = (block.code as { language?: string } | undefined)?.language ?? ''
        lines.push(`${indent}\`\`\`${lang}\n${blockText(block)}\n${indent}\`\`\``)
        break
      }
      case 'divider':
        lines.push(`${indent}---`)
        break
      case 'table':
        // 행은 children(table_row)으로 내려온다
        if (block.children?.length) lines.push(tableToMarkdown(block, indent))
        break
      case 'child_page': {
        const title = (block.child_page as { title?: string } | undefined)?.title ?? '(제목 없음)'
        lines.push(`${indent}📄 하위 페이지: ${title} (id: ${block.id})`)
        break
      }
      case 'child_database': {
        const title = (block.child_database as { title?: string } | undefined)?.title ?? '(제목 없음)'
        lines.push(`${indent}🗃️ 하위 데이터베이스: ${title}`)
        break
      }
      case 'image': {
        const img = block.image as
          | { caption?: NotionRichText[]; external?: { url?: string }; file?: { url?: string } }
          | undefined
        const url = img?.external?.url ?? img?.file?.url ?? ''
        const caption = richTextToMarkdown(img?.caption) || '이미지'
        lines.push(`${indent}![${caption}](${url})`)
        break
      }
      case 'bookmark':
      case 'embed':
      case 'link_preview': {
        const data = block[block.type] as { url?: string; caption?: NotionRichText[] } | undefined
        const caption = richTextToMarkdown(data?.caption)
        if (data?.url) lines.push(`${indent}🔗 ${caption ? `${caption}: ` : ''}${data.url}`)
        break
      }
      case 'equation': {
        const expr = (block.equation as { expression?: string } | undefined)?.expression ?? ''
        lines.push(`${indent}$$${expr}$$`)
        break
      }
      case 'synced_block':
      case 'column_list':
      case 'column': {
        // 컨테이너 블록 — 자식만 평탄화해 출력
        const inner = block.children?.length ? blocksToMarkdown(block.children, indent) : ''
        if (inner) lines.push(inner)
        break
      }
      case 'table_of_contents':
      case 'breadcrumb':
        break // 내용 없는 표시용 블록은 생략
      default: {
        const text = blockText(block)
        lines.push(text ? `${indent}${text}` : `${indent}[미지원 블록: ${block.type}]`)
        break
      }
    }
  }

  return lines.filter((l) => l !== '').join('\n')
}

function tableToMarkdown(table: NotionBlock, indent: string): string {
  const rows = (table.children ?? []).filter((r) => r.type === 'table_row')
  const hasHeader = (table.table as { has_column_header?: boolean } | undefined)?.has_column_header
  const toCells = (row: NotionBlock): string[] => {
    const cells = (row.table_row as { cells?: NotionRichText[][] } | undefined)?.cells ?? []
    // 셀 안 개행/파이프는 표 구조를 깨므로 치환
    return cells.map((c) => richTextToMarkdown(c).replace(/\|/g, '\\|').replace(/\n/g, ' '))
  }
  const lines: string[] = []
  rows.forEach((row, i) => {
    const cells = toCells(row)
    lines.push(`${indent}| ${cells.join(' | ')} |`)
    if (i === 0) {
      lines.push(`${indent}| ${cells.map(() => '---').join(' | ')} |`)
    }
  })
  // 헤더가 없는 표도 마크다운 표 형식상 구분행이 필요하므로 첫 행 뒤에 넣는다
  void hasHeader
  return lines.join('\n')
}

// 페이지 properties에서 제목을 추출한다 (title 타입 프로퍼티)
export function extractPageTitle(properties: Record<string, unknown> | undefined): string {
  if (!properties) return '(제목 없음)'
  for (const value of Object.values(properties)) {
    const prop = value as { type?: string; title?: NotionRichText[] }
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      const title = prop.title.map((t) => t.plain_text ?? '').join('')
      return title || '(제목 없음)'
    }
  }
  return '(제목 없음)'
}
