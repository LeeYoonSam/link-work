import type { Document, Project, Task } from '../types'
import { buildTaskTree } from './taskTree'

// 프로젝트 하나를 노션 문서로 내보내는 데 필요한 데이터 묶음.
export interface ProjectExportData {
  project: Project
  tasks: Task[]
  documents: Document[]
}

// 링크 슬롯이나 기타 불릿에 들어갈 링크 하나.
// documents와 description에서 뽑아낸 링크를 같은 형태로 모아 한 번에 배정한다.
interface LinkCandidate {
  label: string
  url: string
}

// 마커를 걷어낸 본문 라인과, 본문에서 분리해 낸 링크 후보.
interface NormalizedDescription {
  bodyLines: string[]
  links: LinkCandidate[]
}

const STATUS_LABEL: Record<Task['status'], string> = {
  pending: '대기',
  in_progress: '진행중',
  done: '완료'
}

// 링크 슬롯을 고르는 규칙. 배열 순서가 곧 매칭 우선순위다.
// host는 URL만으로 슬롯이 확정되는 규칙 — 이름 키워드보다 우선한다.
const LINK_SLOTS: { label: string; pattern: RegExp; host?: RegExp }[] = [
  { label: 'PRD', pattern: /prd|기획/i },
  {
    label: 'Ticket (Epic/상위 작업)',
    pattern: /ticket|티켓|epic|에픽|jira|지라/i,
    host: /atlassian\.net/i
  },
  { label: 'API Interface', pattern: /api|인터페이스|swagger/i },
  { label: 'Figma', pattern: /figma|피그마|디자인/i, host: /figma\.com/i },
  { label: 'WBS', pattern: /wbs/i }
]

// LinkWork에 대응 데이터가 없어 골격만 내보내는 섹션들 — 사용자가 노션에서 이어서 채운다.
const TICKET_SECTION = [
  '## 관련 구현 티켓',
  '',
  '> 작업 기간 동안 커밋에 포함된 ICA 티켓을 나열합니다.',
  '',
  '| 티켓 | 분류 | 내용 |',
  '| --- | --- | --- |',
  '| ICA-XXXX | 구현 | ... |'
]

const QA_SECTION = [
  '## QA',
  '',
  '- **QA 에픽**:',
  '- **QA 티켓 수**:',
  '- **QA 발생률**:',
  '- **주요 이슈 요약**:'
]

const RETROSPECTIVE_SECTION = [
  '## 회고',
  '',
  '- **잘된 점**:',
  '- **아쉬운 점 / 개선할 점**:',
  '- **다음에 시도할 것**:'
]

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/

// 'YYYY-MM-DD' → 'YYYY.MM.DD'. Date 객체를 거치지 않아 타임존 영향을 받지 않는다.
// 날짜 형식이 아니면(AI가 넣은 자유 문자열 등) 원문을 그대로 살린다.
function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  const trimmed = value.trim()
  const m = DATE_PATTERN.exec(trimmed)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : trimmed
}

// 날짜 문자열을 epoch day(UTC 자정 기준 일수)로. 날짜 형식이 아니면 null.
function toEpochDay(value: string | null | undefined): number | null {
  if (!value) return null
  const m = DATE_PATTERN.exec(value.trim())
  if (!m) return null
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000)
}

// 양끝을 포함한 일수. 날짜를 못 읽거나 순서가 뒤집혔으면 null(총 일수 표기를 생략).
function inclusiveDays(start: string | null, end: string | null): number | null {
  const from = toEpochDay(start)
  const to = toEpochDay(end)
  if (from == null || to == null || to < from) return null
  return to - from + 1
}

// 'YYYY.MM.DD ~ YYYY.MM.DD'. 한쪽만 있으면 그 쪽만, 둘 다 없으면 빈 문자열.
function formatRange(start: string | null, end: string | null): string {
  const from = formatDate(start)
  const to = formatDate(end)
  if (from && to) return `${from} ~ ${to}`
  if (from) return `${from} ~`
  if (to) return `~ ${to}`
  return ''
}

// 개행을 공백으로 접어 한 줄로. 마크다운 불릿/표 셀이 깨지지 않게 한다.
function toSingleLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

// 표 셀: 파이프를 이스케이프해 열이 밀리지 않게 한다.
function escapeCell(value: string): string {
  return toSingleLine(value).replace(/\|/g, '\\|')
}

// 링크 라벨: 대괄호가 링크 구문을 깨지 않게 한다.
function toLink(candidate: LinkCandidate): string {
  const label = toSingleLine(candidate.label).replace(/[[\]]/g, '\\$&')
  return `[${label}](${candidate.url})`
}

const HEADING_LINE = /^#/
const LIST_OR_QUOTE_MARKER = /^(?:[-*+]\s+|>\s?)/
const MARKDOWN_LINK = /\[([^\]]*)\]\((\S+?)\)/
const BARE_URL = /https?:\/\/\S+/
// 라벨 끝에 남는 구분 기호(`상위 에픽: ... —`)를 떼어낸다.
const TRAILING_PUNCTUATION = /[\s:;,·\-–—|]+$/

// 불릿(`- `, `* `)·인용(`> `) 마커를 벗긴다. `> - 내용`처럼 겹친 경우까지 반복해서 벗긴다.
function stripMarkers(line: string): string {
  let out = line.trim()
  let prev = ''
  while (out !== prev) {
    prev = out
    out = out.replace(LIST_OR_QUOTE_MARKER, '').trim()
  }
  return out
}

// 링크 라벨 정리. 중첩 대괄호(`[ICA-8672]`)는 링크 구문을 깨므로 제거하고,
// 라벨이 비면 URL 자체를 라벨로 쓴다.
function cleanLinkLabel(raw: string, fallbackUrl: string): string {
  const label = raw
    .replace(TRAILING_PUNCTUATION, '')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return label || fallbackUrl
}

// 한 줄에서 링크를 뽑는다. 마크다운 링크면 그 라벨을, bare URL이면 URL 앞 텍스트를 라벨로.
function extractLink(line: string): LinkCandidate | null {
  const markdown = MARKDOWN_LINK.exec(line)
  if (markdown) return { label: cleanLinkLabel(markdown[1], markdown[2]), url: markdown[2] }
  const bare = BARE_URL.exec(line)
  if (bare) return { label: cleanLinkLabel(line.slice(0, bare.index), bare[0]), url: bare[0] }
  return null
}

// description은 평문일 수도, 마크다운일 수도 있다(실데이터에 헤딩·불릿·링크가 섞여 들어온다).
// 마커를 걷어낸 본문 라인과 링크 후보로 분리한다.
function normalizeDescription(description: string | null): NormalizedDescription {
  const bodyLines: string[] = []
  const links: LinkCandidate[] = []
  for (const raw of (description ?? '').split('\n')) {
    const line = stripMarkers(raw)
    // 헤딩은 "개요/참조" 같은 섹션 라벨이라 본문이 아니다
    if (!line || HEADING_LINE.test(line)) continue
    const link = extractLink(line)
    if (link) links.push(link)
    else bodyLines.push(line.replace(/\s+/g, ' '))
  }
  return { bodyLines, links }
}

// 값이 비면 콜론까지만 남긴다 — 사용자가 노션에서 채우는 빈 슬롯.
function field(label: string, value: string): string {
  return value ? `- **${label}**: ${value}` : `- **${label}**:`
}

// 후보가 들어갈 수 있는 슬롯을 선호 순서대로 모은다. URL 호스트가 이름보다 확실한
// 신호라 앞세운다 — "PRD 티켓"(atlassian URL)은 PRD가 아니라 Ticket이다.
function preferredSlots(candidate: LinkCandidate): number[] {
  const byHost: number[] = []
  const byName: number[] = []
  LINK_SLOTS.forEach((slot, i) => {
    if (slot.host?.test(candidate.url)) byHost.push(i)
    else if (slot.pattern.test(candidate.label)) byName.push(i)
  })
  return [...byHost, ...byName]
}

// 후보마다 매칭 슬롯 중 아직 비어 있는 첫 슬롯을 차지한다.
// 매칭 슬롯이 전부 찼거나 어느 슬롯에도 안 걸리면 슬롯 아래 개별 불릿으로 밀어낸다.
function assignLinkSlots(candidates: LinkCandidate[]): {
  slotted: (LinkCandidate | null)[]
  leftovers: LinkCandidate[]
} {
  const slotted: (LinkCandidate | null)[] = LINK_SLOTS.map(() => null)
  const leftovers: LinkCandidate[] = []
  for (const candidate of candidates) {
    const target = preferredSlots(candidate).find((i) => slotted[i] == null)
    if (target === undefined) leftovers.push(candidate)
    else slotted[target] = candidate
  }
  return { slotted, leftovers }
}

function taskRow(task: Task, isChild: boolean): string {
  const name = `${isChild ? '└ ' : ''}${escapeCell(task.name)}`
  const status = STATUS_LABEL[task.status] ?? ''
  const period = formatRange(task.start_date, task.end_date)
  return `| ${name} | ${status} | ${period} |`
}

function buildProjectBlock({ project, tasks, documents }: ProjectExportData): string {
  const lines: string[] = [`# ${project.name}`]
  const description = normalizeDescription(project.description)

  // 인용구는 요약 역할이므로 본문 첫 줄만, 배경/목적은 본문 전체를 한 줄로 편다.
  if (description.bodyLines.length > 0) lines.push('', `> ${description.bodyLines[0]}`)

  const devRange = formatRange(project.dev_start_date, project.dev_end_date)
  const devDays = inclusiveDays(project.dev_start_date, project.dev_end_date)
  const deployDate = formatDate(project.deploy_date)
  const version = project.deploy_version?.trim() || 'TBD'

  lines.push(
    '',
    '## 배포 일정',
    '',
    field('개발 기간', devDays != null ? `${devRange} (총 ${devDays}일)` : devRange),
    field('QA 기간', formatRange(project.qa_start_date, project.qa_end_date)),
    field('배포 버전', deployDate ? `${version} (${deployDate})` : version),
    // LinkWork에는 분류 데이터가 없다.
    field('분류', 'TBD'),
    field('배경/목적', description.bodyLines.join(' / '))
  )

  // documents를 먼저 배정하고, 남은 슬롯을 description에서 뽑은 링크로 채운다.
  const { slotted, leftovers } = assignLinkSlots([
    ...documents.map((doc) => ({ label: doc.name ?? '', url: doc.url })),
    ...description.links
  ])
  lines.push('', '---', '', '## 링크', '')
  LINK_SLOTS.forEach((slot, i) => {
    const link = slotted[i]
    lines.push(field(slot.label, link ? toLink(link) : ''))
  })
  for (const link of leftovers) lines.push(`- ${toLink(link)}`)

  lines.push('', '---', '', '## 작업 범위', '')
  const tree = buildTaskTree(tasks)
  if (tree.length === 0) {
    lines.push('_등록된 작업 없음_')
  } else {
    lines.push('| 작업 | 비고 | 기간 |', '| --- | --- | --- |')
    for (const node of tree) {
      lines.push(taskRow(node.task, false))
      for (const child of node.children) lines.push(taskRow(child, true))
    }
  }

  lines.push('', '---', '', ...TICKET_SECTION)
  lines.push('', '---', '', ...QA_SECTION)
  lines.push('', '---', '', ...RETROSPECTIVE_SECTION)

  return lines.join('\n')
}

// 여러 프로젝트를 노션 "작업 로그 문서" 포맷의 마크다운 하나로 합친다.
// 각 프로젝트 블록은 `# {name}` 헤딩으로 시작하고 빈 줄로 이어진다.
export function buildNotionExportMarkdown(items: ProjectExportData[]): string {
  return items.map((item) => buildProjectBlock(item)).join('\n\n')
}
