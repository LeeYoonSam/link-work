import { useEffect, useState } from 'react'
import type { AssistantNavigateEvent, PlanItem, TodayPayload } from '../../types'
import { useAssistantStore } from '../../stores/assistantStore'
import { Card, EmptyState, SectionTitle, button } from '../ui'
import DayHeader from './DayHeader'
import BriefingCard from './BriefingCard'
import RecoveryCard from './RecoveryCard'
import CheckinPanel, { pendingCheckin } from './CheckinPanel'
import InboxSection from './InboxSection'
import PlanItemRow, { freeTimeLabel, isActiveItem } from './PlanItemRow'
import Timeline from './Timeline'
import ChangeLog from './ChangeLog'
import CandidatePicker from './CandidatePicker'
import CommandInput from './CommandInput'
import AssistantSettingsModal from './AssistantSettingsModal'

// '오늘 할 일' 순서 목록. 제안·무시 항목은 뺀다.
// 활성 항목을 rank 순으로 먼저 두고, 완료·미룸·제외 항목을 rank 순으로 뒤에 둔다
export function orderPlanItems(items: PlanItem[]): PlanItem[] {
  const byRank = (a: PlanItem, b: PlanItem): number =>
    (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.id - b.id
  const planned = items.filter((i) => i.status !== 'suggested' && i.status !== 'dismissed')
  return [
    ...planned.filter(isActiveItem).sort(byRank),
    ...planned.filter((i) => !isActiveItem(i)).sort(byRank)
  ]
}

// 남은 빈 시간이 없어 배정하지 못한 마감 항목 (부록 B.3 규칙 7)
export function unplacedDeadlineItems(today: Pick<TodayPayload, 'items' | 'timeline'>): PlanItem[] {
  const ids = today.timeline?.unplacedDeadlineItemIds ?? []
  return ids
    .map((id) => today.items.find((i) => i.id === id))
    .filter((i): i is PlanItem => i !== undefined)
}

// 연결 상태와 수집 실패를 짧은 안내 문구로 만든다
export function todayNotices(today: TodayPayload): string[] {
  const notes: string[] = []
  if (!today.calendarConnected) notes.push('캘린더가 연결되지 않았습니다. 회의 일정 없이 빈 시간을 계산합니다.')
  if (!today.jiraConnected) notes.push('Jira 가 연결되지 않았습니다. Jira 이슈는 후보에 없습니다.')
  if (today.jiraTruncated) notes.push('Jira 이슈가 많습니다. 일부만 가져왔습니다.')
  for (const e of today.lastErrors ?? []) notes.push(e)
  return notes
}

// 알림 focus 를 스크롤 대상 요소 id 로 바꾼다
export function focusTargetId(focus: NonNullable<AssistantNavigateEvent['focus']>): string {
  switch (focus.kind) {
    case 'inbox':
      return 'today-inbox'
    case 'briefing':
      return 'today-briefing'
    case 'timeline':
      return 'today-timeline'
    case 'checkin':
      return 'today-checkin'
    default:
      return `plan-item-${focus.id ?? ''}`
  }
}

export default function TodayView(): React.ReactNode {
  const {
    today,
    loading,
    busy,
    error,
    candidates,
    candidatesLoading,
    candidatesError,
    skippedWrapupDate,
    focus,
    load,
    startDay,
    closeDay,
    reopenDay,
    saveWrapup,
    skipWrapup,
    refresh,
    refreshBriefing,
    generateRecovery,
    loadCandidates,
    addItem,
    acceptSuggestion,
    dismissSuggestion,
    setItemStatus,
    focusItem,
    completeOrigin,
    saveSettings,
    setFocus,
    clearError,
    respondCheckin,
    subscribe
  } = useAssistantStore()
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    void load()
    return subscribe()
  }, [])

  // 알림 클릭으로 열리면 해당 영역으로 스크롤한다
  useEffect(() => {
    if (!focus || !today) return
    const id = focusTargetId(focus)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setFocus(null)
  }, [focus, today])

  if (!today) {
    return (
      <div className="max-w-4xl mx-auto">
        {error ? (
          <Card>
            <p className="text-sm text-red-600 mb-3">{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className={`px-3 py-1.5 text-xs ${button.subtle}`}
            >
              다시 시도
            </button>
          </Card>
        ) : (
          <EmptyState>{loading ? '오늘 계획을 불러오는 중…' : '오늘 계획이 아직 없습니다.'}</EmptyState>
        )}
      </div>
    )
  }

  const { plan, items } = today
  const readOnly = plan?.status !== 'active'
  const ordered = orderPlanItems(items)
  const timeline = today.timeline
  const unplaced = unplacedDeadlineItems(today)
  const notices = todayNotices(today)
  const checkin = plan ? pendingCheckin(today.events, items) : null
  const wrapupPromptDate =
    today.missingWrapupDate && today.missingWrapupDate !== skippedWrapupDate
      ? today.missingWrapupDate
      : null
  const canRegenerate =
    plan?.status === 'active' && today.aiAvailable && today.settings.llmEnabled

  const rowProps = {
    readOnly,
    busy,
    onStatus: (id: number, status: PlanItem['status']) => void setItemStatus(id, status),
    logicalDate: today.logicalDate,
    focusItemId: timeline?.focusItemId ?? null,
    onFocus: (id: number) => void focusItem(id),
    onCompleteOrigin: completeOrigin
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle variant="page">오늘</SectionTitle>
        <span className="text-xs text-gray-400">{today.logicalDate}</span>
      </div>

      <DayHeader
        logicalDate={today.logicalDate}
        plan={plan}
        busy={busy}
        wrapupPromptDate={wrapupPromptDate}
        onStartDay={() => void startDay()}
        onRefresh={() => void refresh()}
        onCloseDay={(note) => void closeDay(note)}
        onReopenDay={() => void reopenDay()}
        onSaveWrapup={(note, date) => void saveWrapup(note, date)}
        onSkipWrapup={skipWrapup}
      />

      {error ? (
        <div className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <p className="text-xs text-red-700">{error}</p>
          <button type="button" onClick={clearError} className="text-xs text-red-500 hover:text-red-700">
            닫기
          </button>
        </div>
      ) : null}

      {notices.length > 0 ? (
        <ul className="space-y-0.5">
          {notices.map((n) => (
            <li key={n} className="text-[11px] text-gray-500">
              · {n}
            </li>
          ))}
        </ul>
      ) : null}

      {/* 명령 입력은 근무 중에만 보인다. 닫힌 날은 interpretCommand 가 거절한다 (부록 G.10.1) */}
      {plan?.status === 'active' ? (
        <Card padding="sm">
          <CommandInput />
        </Card>
      ) : null}

      {plan ? (
        <>
          {/* 시각에 묶인 질문이라 본문 맨 위에 둔다 (부록 H.8.1) */}
          {checkin ? (
            <CheckinPanel
              // 다른 체크인으로 바뀌면 메모 입력을 새로 시작한다
              key={checkin.event.id}
              pending={checkin}
              busy={busy}
              readOnly={readOnly}
              onRespond={(eventId, status, note) => respondCheckin(eventId, status, note)}
              onApplied={() => void load()}
            />
          ) : null}

          <RecoveryCard
            plan={plan}
            state={today.recovery ?? { inFlight: false, error: null }}
            busy={busy}
            canGenerate={today.settings.enabled}
            onGenerate={() => void generateRecovery()}
          />

          <BriefingCard
            plan={plan}
            canRegenerate={canRegenerate}
            busy={busy}
            onRegenerate={() => void refreshBriefing()}
          />

          <InboxSection
            items={items}
            busy={busy}
            readOnly={readOnly}
            onAccept={(id) => void acceptSuggestion(id)}
            onDismiss={(id) => void dismissSuggestion(id)}
          />

          <Card padding="none">
            <div id="today-timeline" className="flex items-center justify-between px-4 pt-4 pb-2">
              <SectionTitle>오늘 계획</SectionTitle>
              {timeline && !readOnly ? (
                <span className="text-xs text-gray-500 tabular-nums">
                  집중 가능 <span className="font-semibold text-gray-800">{freeTimeLabel(timeline.freeMinutesLeft)}</span>
                </span>
              ) : null}
            </div>
            {timeline && timeline.entries.length > 0 ? (
              <Timeline timeline={timeline} items={items} logicalDate={today.logicalDate} />
            ) : (
              <EmptyState compact>오늘 남은 시간 블록이 없습니다.</EmptyState>
            )}
            {unplaced.length > 0 ? (
              <div className="px-4 py-2 border-t border-amber-100 bg-amber-50">
                <p className="text-xs text-amber-800">오늘 남은 빈 시간이 없어 배정하지 못한 마감 항목</p>
                <ul className="mt-1 space-y-0.5">
                  {unplaced.map((i) => (
                    <li key={i.id} className="text-xs text-amber-900 truncate" title={i.title}>
                      · {i.title}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          <Card padding="none">
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <SectionTitle>오늘 할 일</SectionTitle>
              <span className="text-xs text-gray-400">{ordered.length}건</span>
            </div>
            {ordered.length === 0 ? (
              <EmptyState compact>계획 항목이 없습니다. 아래 후보에서 추가하세요.</EmptyState>
            ) : (
              <div className="border-t border-gray-100">
                {ordered.map((item) => (
                  <PlanItemRow key={item.id} item={item} {...rowProps} />
                ))}
              </div>
            )}
          </Card>

          <ChangeLog events={today.events} />

          {!readOnly ? (
            <CandidatePicker
              candidates={candidates}
              items={items}
              loading={candidatesLoading}
              error={candidatesError}
              busy={busy}
              onLoad={() => void loadCandidates()}
              onAdd={(id) => void addItem(id)}
            />
          ) : null}
        </>
      ) : null}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className={`px-3 py-1.5 text-xs ${button.ghost}`}
        >
          비서 설정
        </button>
      </div>

      {settingsOpen ? (
        <AssistantSettingsModal
          settings={today.settings}
          busy={busy}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
        />
      ) : null}
    </div>
  )
}
