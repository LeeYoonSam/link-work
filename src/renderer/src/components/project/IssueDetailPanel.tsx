import { useId } from 'react'
import type { JiraEpicAiSummary } from '../../types'
import { useAiChatStore } from '../../stores/aiChatStore'
import { ClampedText, button, taskTag, typo } from '../ui'
import {
  ExternalLinkIcon,
  FixVersionChips,
  IssueTypeIcon,
  JiraStatusBadge,
  PriorityMarks,
  SegmentedBar,
  rollupText
} from './BoardBits'
import { DocLinkLine } from './DocBits'
import { relatedDocs } from './docsModel'
import { isOverdue, shortDateTime, shortDate, statusVisual, type DetailTarget } from './boardModel'

export interface IssueDetailPanelProps {
  target: DetailTarget | null
  today: string
  aiSummary?: JiraEpicAiSummary
  aiLoading?: boolean
  aiError?: string
  onSummarize: (epicKey: string) => void
  onOpenJira: (key: string) => void
  /** fixVersion 칩 → 릴리스 탭 */
  onOpenRelease?: (versionId: string) => void
  /** 관련 문서 열기(jiraBoard.openLink) */
  onOpenLink?: (url: string) => void
  /** "문서 탭에서 모두 보기" — 검색어(에픽·이슈 키)로 문서 탭을 연다 */
  onShowAllDocs?: (query: string) => void
  /** [AI 대화로 열기] — 프롬프트로 새 AI 대화를 연다(aiChatStore.startChatWith) */
  onOpenChat?: (prompt: string) => void
}

/**
 * [AI 대화로 열기]의 기본 동작. 에픽·일반 모두 승인 후 쓰기(ask) 모드로 연다.
 * 화면 밖에서 시작한 대화는 쓰기 전에 승인 카드를 거친다
 */
export function openIssueChat(prompt: string): Promise<void> {
  return useAiChatStore.getState().startChatWith(prompt, { writeMode: 'ask' })
}

/**
 * [AI 대화로 열기]가 보내는 프롬프트. 티켓 키만 담는다.
 * 제목·설명 같은 Jira 텍스트는 넣지 않는다 — 외부 입력은 AI 가 도구로 읽게 한다(가드레일)
 */
export function aiChatPromptFor(key: string, isEpic: boolean): string {
  return isEpic
    ? `Jira 에픽 ${key} 와 하위 티켓의 현재 상태를 읽고, 내가 할 일의 일정 초안을 제안해줘. 할 일로 만들기 전에 먼저 초안을 보여줘.`
    : `Jira 티켓 ${key} 의 내용과 최근 진행 상황을 읽고 정리해줘.`
}

/** 상세에 바로 보이는 관련 문서 수. 나머지는 문서 탭에서 본다 */
const RELATED_LIMIT = 6

function MetaRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 text-sm">
      <dt className="text-gray-400">{label}</dt>
      <dd className="min-w-0 break-words text-gray-700">{children}</dd>
    </div>
  )
}

/** 선택한 행의 상세. 넓은 창에서는 오른쪽 패널, 좁은 창에서는 행 아래 인라인으로 같은 내용을 쓴다 */
export default function IssueDetailPanel({
  target,
  today,
  aiSummary,
  aiLoading = false,
  aiError,
  onSummarize,
  onOpenJira,
  onOpenRelease,
  onOpenLink,
  onShowAllDocs,
  onOpenChat
}: IssueDetailPanelProps): React.ReactNode {
  // 넓은 창 패널과 좁은 창 인라인이 함께 마운트될 수 있어 제목 id 를 고유하게 만든다
  const titleId = useId()
  if (!target) {
    return <p className={`${typo.metaFaint} py-6 text-center`}>행을 고르면 상세가 여기에 보여요</p>
  }
  const { issue, group } = target
  const jiraKey = issue?.key ?? group?.epicKey ?? null
  const title = issue?.summary ?? group?.title ?? ''
  const isEpic = issue?.level === 'epic'
  const related = relatedDocs(target, RELATED_LIMIT)
  const docsQuery = group?.epicKey ?? issue?.key ?? null
  const rollup = group?.rollup ?? (target.node && target.node.rollup.total > 0 ? target.node.rollup : null)

  return (
    <section aria-labelledby={titleId} className="space-y-4">
      <header className="space-y-1.5">
        <div className="flex items-center gap-2">
          {issue ? <IssueTypeIcon level={issue.level} typeName={issue.issueType} /> : null}
          {jiraKey ? (
            <span className={`rounded px-1.5 py-0.5 text-xs ${taskTag.issue}`}>{jiraKey}</span>
          ) : null}
          {group && !issue && group.kind === 'missingEpic' ? <span className={typo.metaFaint}>범위 밖 에픽</span> : null}
          {issue ? (
            <JiraStatusBadge status={issue.status} category={issue.statusCategory} dimmed={!issue.inScope} />
          ) : null}
        </div>
        <h2 id={titleId} className="text-base font-semibold text-gray-900 break-words">
          {title}
        </h2>
      </header>

      {issue ? (
        <dl className="space-y-1">
          <MetaRow label="유형">
            {issue.issueType}
            {issue.priority ? (
              <span className="ml-2 inline-flex items-center gap-1">
                <PriorityMarks priority={issue.priority} />
                <span className="text-gray-500">{issue.priority}</span>
              </span>
            ) : null}
          </MetaRow>
          <MetaRow label="담당">{issue.assigneeName ?? '없음'}</MetaRow>
          {issue.duedate ? (
            <MetaRow label="기한">
              <span className={isOverdue(issue, today) ? 'text-red-600 font-medium' : undefined}>
                {shortDate(issue.duedate)}
                {isOverdue(issue, today) ? ' (지남)' : ''}
              </span>
            </MetaRow>
          ) : null}
          {target.parentKey ? (
            <MetaRow label="상위">
              <span className="font-mono text-xs text-indigo-600">{target.parentKey}</span>{' '}
              {target.parentSummary ?? ''}
            </MetaRow>
          ) : null}
          <MetaRow label="업데이트">{shortDateTime(issue.updated)}</MetaRow>
          {issue.resolvedAt ? <MetaRow label="완료">{shortDateTime(issue.resolvedAt)}</MetaRow> : null}
          {issue.fixVersions?.length > 0 ? (
            <MetaRow label="릴리스">
              <span className="inline-flex flex-wrap gap-1">
                {onOpenRelease ? (
                  <FixVersionChips versions={issue.fixVersions} onOpen={onOpenRelease} />
                ) : (
                  issue.fixVersions.map((v) => v.name).join(', ')
                )}
              </span>
            </MetaRow>
          ) : null}
          {issue.labels.length > 0 ? <MetaRow label="레이블">{issue.labels.join(', ')}</MetaRow> : null}
          {!issue.inScope ? (
            <MetaRow label="범위">
              <span className="text-gray-500">조회 범위 밖(백로그) — 범위 안 하위 항목 때문에 보여요</span>
            </MetaRow>
          ) : null}
        </dl>
      ) : null}

      {isEpic && issue ? (
        <div className="rounded-md border border-gray-200 p-3 space-y-2" aria-live="polite">
          <div className="flex items-center justify-between gap-2">
            <p className={typo.microLabel}>AI 요약</p>
            <button
              type="button"
              onClick={() => onSummarize(issue.key)}
              disabled={aiLoading}
              className={`px-2.5 py-1 text-xs ${button.subtle} disabled:opacity-50`}
            >
              {aiLoading ? '요약 중…' : aiSummary ? '다시 요약' : 'AI 요약'}
            </button>
          </div>
          {aiError ? <p className="text-sm text-red-700" role="alert">{aiError}</p> : null}
          {aiSummary ? (
            <div className="space-y-1.5">
              <p className="text-sm text-gray-800">{aiSummary.headline}</p>
              <ul className="list-disc pl-5 space-y-0.5 text-sm text-gray-600">
                {aiSummary.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
              <p className={typo.metaFaint}>AI 요약 · {shortDateTime(aiSummary.generatedAt)}</p>
            </div>
          ) : !aiLoading && !aiError ? (
            <p className={typo.metaFaint}>버튼을 누르면 하위 티켓 상태로 진행 상황을 요약해요</p>
          ) : null}
        </div>
      ) : null}

      {issue?.excerpt ? (
        <div className="space-y-1">
          <p className={typo.microLabel}>설명</p>
          <ClampedText text={issue.excerpt} lines={3} className="text-sm text-gray-600 whitespace-pre-line" />
        </div>
      ) : null}

      {rollup ? (
        <div className="space-y-1">
          <p className={typo.microLabel}>진행</p>
          <div className="flex items-center gap-2">
            <SegmentedBar counts={rollup} />
            <span className={typo.meta}>{rollupText(rollup)}</span>
          </div>
        </div>
      ) : null}

      {target.children.length > 0 || target.hiddenBacklog + target.hiddenPastDone > 0 ? (
        <div className="space-y-1">
          <p className={typo.microLabel}>
            {group ? '하위 티켓' : '하위작업'} {target.children.length}
          </p>
          <ul className="space-y-1">
            {target.children.map((c) => (
              <li key={c.issue.key} className="flex items-start gap-1.5 text-sm">
                <span aria-label={statusVisual(c.issue.statusCategory).categoryLabel} className="text-gray-400">
                  {statusVisual(c.issue.statusCategory).shape}
                </span>
                <span className="font-mono text-xs text-indigo-600 pt-0.5">{c.issue.key}</span>
                <span className={`min-w-0 break-words ${c.issue.statusCategory === 'done' ? 'text-gray-400' : 'text-gray-700'}`}>
                  {c.issue.summary}
                </span>
              </li>
            ))}
          </ul>
          {target.hiddenBacklog + target.hiddenPastDone > 0 ? (
            <p className={typo.metaFaint}>
              {[
                target.hiddenBacklog > 0 ? `백로그 ${target.hiddenBacklog}건` : '',
                target.hiddenPastDone > 0 ? `이전 완료 ${target.hiddenPastDone}건` : ''
              ]
                .filter(Boolean)
                .join(' · ')}{' '}
              숨김
              {target.hiddenPastDone > 0 ? ' — 툴바의 "이전 완료 보기"로 펼쳐요' : ''}
            </p>
          ) : null}
        </div>
      ) : null}

      {related.total > 0 && onOpenLink ? (
        <div className="space-y-1.5">
          <p className={typo.microLabel}>
            관련 문서 {related.total}
            {group ? <span className="normal-case tracking-normal"> · 하위 티켓 포함</span> : null}
          </p>
          <ul className="space-y-2">
            {related.items.map((e) => (
              <li key={e.url}>
                <DocLinkLine entry={e} onOpen={onOpenLink} compact />
              </li>
            ))}
          </ul>
          {related.total > related.items.length && onShowAllDocs && docsQuery ? (
            <button type="button" onClick={() => onShowAllDocs(docsQuery)} className="text-xs text-blue-600 hover:text-blue-700">
              문서 탭에서 모두 보기 ({related.total})
            </button>
          ) : null}
        </div>
      ) : null}

      {jiraKey ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenJira(jiraKey)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm ${button.primary}`}
          >
            Jira에서 열기
            <ExternalLinkIcon size={12} />
          </button>
          {onOpenChat ? (
            <button
              type="button"
              onClick={() => onOpenChat(aiChatPromptFor(jiraKey, isEpic || (!issue && !!group)))}
              title="이 티켓을 AI 대화에서 이어서 봅니다. 티켓 키만 넘기고 내용은 AI 가 Jira 에서 읽습니다"
              className={`px-3 py-1.5 text-sm ${button.subtle}`}
            >
              AI 대화로 열기
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
