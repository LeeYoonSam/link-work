// 문서 링크 한 줄을 그리는 조각. 문서 탭과 상세 "관련 문서"가 같이 쓴다.
import { Badge, taskTag } from '../ui'
import { ExternalLinkIcon } from './BoardBits'
import { DOC_KIND_LABELS, formatSize, type DocEntry, type DocKind } from './docsModel'

// 출처별 첫 글자 칩. 색은 구분용 파스텔 하나씩이고 뜻을 싣지 않는다(라벨이 함께 나온다).
// 빨강은 마감 뜻만 가지므로 쓰지 않는다
const SOURCE_TONE: Record<string, string> = {
  Confluence: 'bg-sky-100 text-sky-700',
  Figma: 'bg-purple-100 text-purple-700',
  'Google 문서': 'bg-green-100 text-green-700',
  'Notion 문서': 'bg-gray-200 text-gray-700',
  Notion: 'bg-gray-200 text-gray-700',
  Jira: 'bg-indigo-100 text-indigo-700',
  첨부: 'bg-amber-100 text-amber-700'
}

function SourceMark({ source }: { source: string }): React.ReactNode {
  const tone = SOURCE_TONE[source] ?? 'bg-slate-100 text-slate-600'
  return (
    <span
      aria-hidden
      className={`inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[10px] font-semibold ${tone}`}
    >
      {source === '첨부' ? '⎙' : (source.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

// 종류 배지. 연결 이슈는 문서가 아니라 맥락이라 가장 옅게 둔다
const DOC_KIND_BADGE: Record<DocKind, string> = {
  web: 'bg-blue-50 text-blue-700',
  attachment: 'bg-amber-50 text-amber-700',
  description: 'bg-slate-100 text-slate-600',
  issue: 'bg-gray-100 text-gray-500'
}

/** 링크 한 줄: 출처 칩 · 제목(누르면 열기) · 종류 · 연결 이슈면 관계·상태 · 첨부면 크기 */
export function DocLinkLine({
  entry,
  onOpen,
  compact = false
}: {
  entry: DocEntry
  onOpen: (url: string) => void
  compact?: boolean
}): React.ReactNode {
  const l = entry.link
  const size = entry.kind === 'attachment' ? formatSize(l.size) : null
  return (
    <div className="flex min-w-0 items-start gap-2">
      <SourceMark source={entry.source} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onOpen(entry.url)}
          title={entry.url}
          className={`inline-flex max-w-full items-start gap-1 text-left text-gray-800 hover:text-blue-700 hover:underline ${
            compact ? 'text-sm' : 'text-sm font-medium'
          }`}
        >
          {entry.kind === 'issue' && l.issueKey ? (
            <span className={`mt-px flex-shrink-0 rounded px-1 text-[11px] ${taskTag.issue}`}>{l.issueKey}</span>
          ) : null}
          <span className="min-w-0 break-words">{entry.title}</span>
          <ExternalLinkIcon size={11} className="mt-1 flex-shrink-0 text-gray-300" />
        </button>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500">
          <Badge color={DOC_KIND_BADGE[entry.kind]} size="xs">
            {DOC_KIND_LABELS[entry.kind]}
          </Badge>
          {entry.kind !== 'issue' ? <span>{entry.source}</span> : null}
          {entry.kind === 'issue' && l.relation ? <span>{l.relation}</span> : null}
          {entry.kind === 'issue' && l.issueStatus ? <span className="text-gray-400">{l.issueStatus}</span> : null}
          {size ? <span className="text-gray-400">{size}</span> : null}
        </div>
      </div>
    </div>
  )
}
