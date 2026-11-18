// Jira 설명(ADF, Atlassian Document Format) 해석 — 순수 함수만 둔다.
// 프로젝트 보드(jira-board.ts)가 설명 발췌(평문)에 쓴다.

interface AdfNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>
  content?: AdfNode[]
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === 'object' && value !== null
}

function attrString(node: AdfNode, key: string): string | null {
  const v = node.attrs?.[key]
  return typeof v === 'string' ? v : null
}

// 줄 단위로 끊기는 블록. 이 블록이 끝날 때 줄바꿈을 넣는다.
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'rule',
  'panel',
  'mediaSingle',
  'tableRow'
])

/** ADF를 사람이 읽을 평문으로 바꾼다. 내용이 없으면 null */
export function adfToPlainText(doc: unknown): string | null {
  if (typeof doc === 'string') return doc.trim() || null
  if (!isNode(doc)) return null

  const out: string[] = []
  const walk = (node: AdfNode, listDepth: number): void => {
    switch (node.type) {
      case 'text':
        out.push(node.text ?? '')
        return
      case 'hardBreak':
        out.push('\n')
        return
      case 'mention':
      case 'emoji':
        out.push(attrString(node, 'text') ?? attrString(node, 'shortName') ?? '')
        return
      case 'inlineCard':
      case 'blockCard':
      case 'embedCard':
        out.push(attrString(node, 'url') ?? '')
        if (node.type !== 'inlineCard') out.push('\n')
        return
      case 'listItem':
        out.push(`${'  '.repeat(Math.max(0, listDepth - 1))}- `)
        for (const child of node.content ?? []) walk(child, listDepth)
        return
      case 'bulletList':
      case 'orderedList':
        for (const child of node.content ?? []) walk(child, listDepth + 1)
        return
      case 'tableCell':
      case 'tableHeader':
        for (const child of node.content ?? []) walk(child, listDepth)
        out.push(' | ')
        return
    }
    for (const child of node.content ?? []) walk(child, listDepth)
    if (node.type && BLOCK_TYPES.has(node.type)) out.push('\n')
  }
  walk(doc, 0)

  const text = out
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    // 블록 사이 빈 줄은 하나까지만 남긴다
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text === '' ? null : text
}
