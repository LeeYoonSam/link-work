import { useEffect, useState } from 'react'
import type { AssistantNavigateEvent, DailyPlan, PlanItem, RecoveryState, TodayPayload } from '../../types'
import { useAssistantStore } from '../../stores/assistantStore'
import { Card, EmptyState, SectionTitle, button } from '../ui'
import DayHeader from './DayHeader'
import BriefingCard, { briefingSummary } from './BriefingCard'
import RecoveryCard from './RecoveryCard'
import MeetingBriefingCard, {
  meetingBriefings,
  nearestUpcomingEventId,
  splitBriefingsByTimeline
} from './MeetingBriefingCard'
import CandidatesCard from './CandidatesCard'
import PlanItemRow, { isActiveItem, isItemExcluded, itemSlotLabel } from './PlanItemRow'
import SummaryTiles, { summaryTiles } from './SummaryTiles'
import Timeline from './Timeline'
import ChangeLog from './ChangeLog'
import { SUBSECTION_TITLE } from './todayTokens'
import CommandInput from './CommandInput'
import AssistantSettingsModal from './AssistantSettingsModal'
import MoreSection from './MoreSection'
import HomeSchedule from '../dashboard/HomeSchedule'
import { HomeMemos, HomeProjects } from '../dashboard/HomeOverview'

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
  if (!today.calendarConnected) notes.push('캘린더가 연결되지 않았어요. 회의 없이 빈 시간을 계산해요.')
  if (!today.jiraConnected) notes.push('Jira 가 연결되지 않았어요. Jira 이슈는 후보에 없어요.')
  if (today.jiraTruncated) notes.push('Jira 이슈가 많아 일부만 가져왔어요.')
  for (const e of today.lastErrors ?? []) notes.push(e)
  return notes
}

// 맥락 복구 카드를 본문 영역에 둘지 판정한다 (부록 J.8).
// 본문·진행 중·오류가 없으면 '더 보기' 안에 1줄로 간다
export function recoveryVisible(plan: Pick<DailyPlan, 'recovery_text'>, state: RecoveryState): boolean {
  return !!plan.recovery_text || state.inFlight || !!state.error
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
    // 회의 브리핑 알림 클릭 (부록 I.10.2). id 는 이벤트 id 다
    case 'meeting':
      return `meeting-briefing-${focus.id ?? ''}`
    default:
      return `plan-item-${focus.id ?? ''}`
  }
}

// 지금 로컬 시각을 'YYYY-MM-DD HH:mm:ss' 로 만든다
export function localNow(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const scrollToId = (id: string): boolean => {
  const el = document.getElementById(id)
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return el !== null
}

export default function TodayView({
  moreOpenInitial = false
}: {
  // 테스트가 '더 보기' 를 연 상태로 그릴 때 쓴다. 앱은 넘기지 않는다
  moreOpenInitial?: boolean
} = {}): React.ReactNode {
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
    excludeItem,
    removeExclusion,
    focusItem,
    completeOrigin,
    saveSettings,
    setFocus,
    clearError,
    regenerateMeetingBriefing,
    meetingRegeneratingIds
  } = useAssistantStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(moreOpenInitial)

  // assistant:changed 구독은 stores/dataSync.ts 가 앱 전체에 1번 둔다.
  // 여기서 또 구독하면 같은 이벤트로 load 가 2번 돈다
  useEffect(() => {
    void load()
  }, [])

  // 알림 클릭으로 열리면 해당 영역으로 스크롤한다
  useEffect(() => {
    if (!focus || !today) return
    const id = focusTargetId(focus)
    // 대상이 접힌 '더 보기' 안에 있으면 연 뒤 다음 그리기에서 스크롤한다
    if (!scrollToId(id)) {
      setMoreOpen(true)
      setTimeout(() => scrollToId(id), 0)
    }
    setFocus(null)
  }, [focus, today])

  // 오늘 계획을 못 읽어도 홈의 프로젝트·일정·메모는 보인다. 일정은 로컬 날짜 기준이다 (부록 M.11 Q4)
  if (!today) {
    return (
      <div className="max-w-6xl mx-auto space-y-5">
        {error ? (
          <Card>
            <p className="text-sm text-red-600 mb-3">{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className={`px-3 py-1.5 text-sm ${button.subtle}`}
            >
              다시 시도
            </button>
          </Card>
        ) : (
          <EmptyState>{loading ? '오늘 계획을 불러오는 중…' : '오늘 계획이 아직 없어요.'}</EmptyState>
        )}
        <HomeProjects />
        <HomeSchedule />
        <HomeMemos />
      </div>
    )
  }

  const { plan, items } = today
  const readOnly = plan?.status !== 'active'
  const ordered = orderPlanItems(items)
  const timeline = today.timeline
  const unplaced = unplacedDeadlineItems(today)
  const unplacedIds = new Set(unplaced.map((i) => i.id))
  const exclusions = today.exclusions ?? []
  // '오늘' 카드 머리의 건수. 할 일은 활성 항목, 회의는 시간표의 회의 행이다 (부록 M.3)
  const activeCount = items.filter(isActiveItem).length
  const meetingCount = timeline ? timeline.entries.filter((e) => e.kind === 'meeting').length : 0
  const notices = todayNotices(today)
  const wrapupPromptDate =
    today.missingWrapupDate && today.missingWrapupDate !== skippedWrapupDate
      ? today.missingWrapupDate
      : null
  const canRegenerate =
    plan?.status === 'active' && today.aiAvailable && today.settings.llmEnabled
  const meetingRows = meetingBriefings(today.events)
  const now = localNow()
  const regeneratingIds = meetingRegeneratingIds ?? []
  const canRegenerateMeeting = today.aiAvailable && today.settings.llmEnabled
  // 시간표의 회의 행과 짝이 맞는 브리핑은 그 행에 붙는다. 나머지만 따로 묶는다 (2차 개편 V3·V4).
  // 계획이 없으면 시간표가 없어 모든 행이 따로 보인다
  const unmatchedMeetingRows =
    plan && timeline ? splitBriefingsByTimeline(meetingRows, timeline.entries).unmatched : meetingRows
  // 요약이 비면 DayHeader 에 구분선도 그리지 않는다 (2차 개편 V1)
  const showBriefing = plan ? briefingSummary(plan.briefing_text ?? '') !== '' : false
  // 'YYYY-MM-DD HH:mm:ss' 의 'HH:mm'. 다음 회의 타일이 쓴다
  const tiles = plan ? summaryTiles(today, now.slice(11, 16)) : null

  const recoveryState = today.recovery ?? { inFlight: false, error: null }
  const showRecovery = plan ? recoveryVisible(plan, recoveryState) : false
  const recoveryCard = plan ? (
    <RecoveryCard
      plan={plan}
      state={recoveryState}
      busy={busy}
      canGenerate={today.settings.enabled}
      onGenerate={() => void generateRecovery()}
    />
  ) : null

  const rowProps = {
    readOnly,
    busy,
    items,
    onStatus: (id: number, status: PlanItem['status']) => void setItemStatus(id, status),
    // 켜져 있으면 행이 '완료' 때 원본 todo·task 도 완료한다 (D10). 기본은 false 다.
    // 비서 main 은 원본을 쓰지 않는다(A2). 그래서 행이 기존 API(completeOrigin)로 처리한다
    completeOriginOnDone: today.settings.completeOriginOnDone === true,
    logicalDate: today.logicalDate,
    focusItemId: timeline?.focusItemId ?? null,
    onFocus: (id: number) => void focusItem(id),
    onCompleteOrigin: completeOrigin,
    onExclude: (id: number) => void excludeItem(id),
    onRemoveExclusion: (candidateId: string) => void removeExclusion(candidateId)
  }

  const meetingBriefingCard = (title?: string, expandedEventId?: number | null): React.ReactNode => (
    <MeetingBriefingCard
      rows={unmatchedMeetingRows}
      now={now}
      regeneratingIds={regeneratingIds}
      canRegenerate={canRegenerateMeeting}
      onRegenerate={(eventId) => void regenerateMeetingBriefing(eventId)}
      title={title}
      expandedEventId={expandedEventId}
    />
  )

  // 순서: 헤더(하루 브리핑 요약 포함) → 오류 → 요약 타일 → 진행 중 프로젝트 → 오늘(할 일 → 회의) → 후보
  // → 기타 회의 브리핑 → 맥락 복구 → 중요 메모 → 더 보기 (부록 M.11 Q2, A60). 모든 카드는 가로 전체 폭을 쓴다.
  // 날짜는 DayHeader 1곳에만 보인다.
  // 계획이 없으면 진행 중 프로젝트 → 홈 일정 → 회의 브리핑 → 중요 메모 → 더 보기다 (Q3)
  return (
    <div className="max-w-6xl mx-auto space-y-5">
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
      >
        {plan && showBriefing ? (
          <BriefingCard
            plan={plan}
            canRegenerate={canRegenerate}
            busy={busy}
            onRegenerate={() => void refreshBriefing()}
          />
        ) : null}
      </DayHeader>

      {error ? (
        <div className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
          <p className="text-sm text-red-700">{error}</p>
          <button type="button" onClick={clearError} className="text-sm text-red-500 hover:text-red-700">
            닫기
          </button>
        </div>
      ) : null}

      {/* 건수·다음 항목만 요약한다. 계획이 있을 때만 보인다 */}
      {tiles ? (
        <div id="today-summary" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SummaryTiles tiles={tiles} />
        </div>
      ) : null}

      {/* 진행 중 프로젝트는 오늘 카드·홈 일정 위에 둔다. 계획 유무와 무관하다 (부록 M.11 Q2·Q3) */}
      <HomeProjects />

      {plan ? (
        <>
          {/* 할 일과 회의를 카드 1개로 본다 (부록 M7). 할 일이 행동 대상이라 먼저 온다 */}
          <div id="today-agenda">
            <Card padding="none">
              <div className="flex items-center justify-between px-5 pt-5 pb-3">
                <SectionTitle variant="page">오늘</SectionTitle>
                <span className="text-sm text-gray-500 tabular-nums">
                  {`할 일 ${activeCount} · 회의 ${meetingCount}`}
                </span>
              </div>

              {unplaced.length > 0 ? (
                <div className="px-5 py-3 border-t border-amber-100 bg-amber-50">
                  <p className="text-sm text-amber-800">오늘 남은 빈 시간이 없어 배정하지 못한 마감 항목</p>
                  <ul className="mt-1 space-y-0.5">
                    {unplaced.map((i) => (
                      <li key={i.id} className="text-sm text-amber-900 break-words">
                        · {i.title}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* 할 일 구역. 순위순 목록 1개다. 배정 시각은 행의 1열에 쓴다 (부록 M8) */}
              <div id="today-tasks" className="border-t border-gray-100">
                <h4 className={SUBSECTION_TITLE}>할 일</h4>
                {ordered.length === 0 ? (
                  <EmptyState compact>계획 항목이 없어요. 아래 후보에서 추가해 주세요.</EmptyState>
                ) : (
                  <div>
                    {ordered.map((item) => (
                      <PlanItemRow
                        key={item.id}
                        item={item}
                        {...rowProps}
                        slotLabel={timeline ? itemSlotLabel(item.id, timeline) : null}
                        unplaced={unplacedIds.has(item.id)}
                        excluded={isItemExcluded(item, exclusions)}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* 회의 구역. 시간표의 회의 행만 그린다 (부록 M9) */}
              <div id="today-timeline" className="border-t border-gray-100">
                <h4 className={SUBSECTION_TITLE}>회의</h4>
                {timeline && meetingCount > 0 ? (
                  <Timeline
                    timeline={timeline}
                    meetingBriefings={meetingRows}
                    now={now}
                    regeneratingIds={regeneratingIds}
                    canRegenerate={canRegenerateMeeting}
                    onRegenerate={(eventId) => void regenerateMeetingBriefing(eventId)}
                  />
                ) : (
                  <EmptyState compact>오늘 회의가 없어요.</EmptyState>
                )}
              </div>
            </Card>
          </div>

          {/* 새로 들어온 제안과 후보 더 보기·계속 제외 목록을 카드 1개로 둔다 (부록 M10) */}
          <CandidatesCard
            items={items}
            candidates={candidates}
            candidatesLoading={candidatesLoading}
            candidatesError={candidatesError}
            exclusions={exclusions}
            logicalDate={today.logicalDate}
            busy={busy}
            readOnly={readOnly}
            onAccept={(id) => void acceptSuggestion(id)}
            onDismiss={(id) => void dismissSuggestion(id)}
            onLoadCandidates={() => void loadCandidates()}
            onAdd={(id) => void addItem(id)}
            onRemoveExclusion={(id) => void removeExclusion(id)}
          />

          {/* 시간표에 짝이 없는 회의 브리핑만 따로 보인다 (2차 개편 V4) */}
          {/* 기본 펼침은 회의 구역과 합쳐 화면 전체에서 1건이다. Timeline 도 전체 행 기준이다 */}
          {meetingBriefingCard('기타 회의 브리핑', nearestUpcomingEventId(meetingRows, now))}
        </>
      ) : (
        <>
          {/* 계획이 없으면 오늘 일정을 1번만 그린다. 회의 브리핑은 계획이 없어도 보인다 (부록 I.10.1) */}
          <HomeSchedule logicalDate={today.logicalDate} />
          {meetingBriefingCard()}
        </>
      )}

      {plan && showRecovery ? recoveryCard : null}

      {/* 중요 메모. 0건이면 그리지 않는다 (메뉴 통합 D1, 부록 M.11 Q1) */}
      <HomeMemos />

      {/* 조작 UI 는 접힌 더 보기 안에 둔다 (부록 J.8, J-8) */}
      <MoreSection open={moreOpen} onToggle={() => setMoreOpen((o) => !o)}>
        {/* 명령 입력은 근무 중에만 보인다. 닫힌 날은 interpretCommand 가 거절한다 (부록 G.10.1) */}
        {plan?.status === 'active' ? (
          <Card padding="sm">
            <CommandInput />
          </Card>
        ) : null}

        <ChangeLog events={today.events} />

        {notices.length > 0 ? (
          <ul className="space-y-0.5">
            {notices.map((n) => (
              <li key={n} className="text-sm text-gray-500">
                · {n}
              </li>
            ))}
          </ul>
        ) : null}

        {plan && !showRecovery ? recoveryCard : null}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className={`px-3 py-1.5 text-sm ${button.ghost}`}
          >
            비서 설정
          </button>
        </div>
      </MoreSection>

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
