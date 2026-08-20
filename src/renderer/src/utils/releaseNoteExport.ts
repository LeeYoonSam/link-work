import type { ReleaseNoteItem, ReleaseNoteWithItems } from '../types'

// 이슈 유형이 비어 있는 항목이 모이는 그룹 이름.
const FALLBACK_GROUP = '기타'

const EMPTY_MESSAGE = '_릴리스에 포함된 이슈가 없습니다._'

// 한 유형 그룹. items에는 최상위 항목만 담고, 하위 이슈는 렌더링할 때 부모 아래로 붙인다.
interface TypeGroup {
  type: string
  items: ReleaseNoteItem[]
}

// 개행을 공백으로 접어 한 줄로. 이슈 제목은 Jira에서 온 외부 입력이라
// 개행이 섞이면 불릿 구조가 깨질 수 있다.
function toSingleLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

// Jira가 준 순서(sort_order)를 그대로 따른다. 정렬은 안정 정렬이므로
// sort_order가 같으면 원래 배열 순서가 유지된다.
function sortByOrder(items: ReleaseNoteItem[]): ReleaseNoteItem[] {
  return [...items].sort((a, b) => a.sort_order - b.sort_order)
}

// 부모가 같은 릴리스 안에 있을 때만 하위로 취급한다. 상위 이슈가 이 릴리스에 포함되지
// 않은 하위 이슈(다른 릴리스에 붙은 에픽의 스토리 등)는 최상위로 올려야 아예 누락되지 않는다.
function isNested(item: ReleaseNoteItem, keys: Set<string>): boolean {
  const parent = item.parent_key
  return !!parent && parent !== item.issue_key && keys.has(parent)
}

function childrenByParent(
  items: ReleaseNoteItem[],
  keys: Set<string>
): Map<string, ReleaseNoteItem[]> {
  const map = new Map<string, ReleaseNoteItem[]>()
  for (const item of items) {
    const parent = item.parent_key
    if (!parent || !isNested(item, keys)) continue
    const siblings = map.get(parent)
    if (siblings) siblings.push(item)
    else map.set(parent, [item])
  }
  return map
}

// 유형별 그룹. 그룹 순서는 최상위 항목이 처음 등장한 순서를 따른다 —
// 하위 이슈는 부모 아래에 붙으므로 자기 유형으로 그룹을 새로 만들지 않는다.
function groupByType(topLevel: ReleaseNoteItem[]): TypeGroup[] {
  const groups: TypeGroup[] = []
  const byType = new Map<string, TypeGroup>()
  for (const item of topLevel) {
    const type = item.issue_type?.trim() || FALLBACK_GROUP
    const group = byType.get(type)
    if (group) {
      group.items.push(item)
    } else {
      const created = { type, items: [item] }
      byType.set(type, created)
      groups.push(created)
    }
  }
  return groups
}

// 항목 한 줄 + 하위 항목들. 부모-자식 순환이 섞여 들어와도 멈추도록 visited로 막는다.
function itemLines(
  item: ReleaseNoteItem,
  children: Map<string, ReleaseNoteItem[]>,
  visited: Set<string>,
  depth: number
): string[] {
  if (visited.has(item.issue_key)) return []
  visited.add(item.issue_key)
  const lines = [`${'  '.repeat(depth)}- [${item.issue_key}] ${toSingleLine(item.summary)}`]
  for (const child of sortByOrder(children.get(item.issue_key) ?? [])) {
    lines.push(...itemLines(child, children, visited, depth + 1))
  }
  return lines
}

/**
 * 릴리스 노트 하나를 마크다운으로. Jira 미러링이라 앱에서 문구를 편집하지 않으므로,
 * 내보낸 마크다운이 문구를 다듬는 유일한 경로다 (docs/RELEASE_NOTES.md §1).
 */
export function buildReleaseNoteMarkdown(
  note: ReleaseNoteWithItems,
  projectName: string
): string {
  const title = [projectName.trim(), note.version_name.trim()].filter(Boolean).join(' ')
  const lines: string[] = [`# ${title}`]

  const description = toSingleLine(note.description ?? '')
  if (description) lines.push('', `> ${description}`)

  lines.push('')
  if (note.release_date) lines.push(`- **릴리스일**: ${note.release_date}`)
  lines.push(
    `- **상태**: ${note.released ? '출시됨' : '미출시'}`,
    `- **Jira**: ${note.jira_project_key}`
  )

  const items = sortByOrder(note.items)
  if (items.length === 0) {
    lines.push('', EMPTY_MESSAGE)
    return lines.join('\n')
  }

  const keys = new Set(items.map((item) => item.issue_key))
  const children = childrenByParent(items, keys)
  const topLevel = items.filter((item) => !isNested(item, keys))
  const visited = new Set<string>()
  for (const group of groupByType(topLevel)) {
    lines.push('', `## ${group.type}`)
    for (const item of group.items) lines.push(...itemLines(item, children, visited, 0))
  }

  return lines.join('\n')
}
