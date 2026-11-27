import { create } from 'zustand'
import type { CalendarEvent, MeetingNoteItem } from '../types'
import { previousWorkRange } from '../components/today/yesterdayModel'
import { useAssistantStore } from './assistantStore'
import { useTodoStore } from './todoStore'
import { useJiraBoardStore } from './jiraBoardStore'
import { useReleaseNoteStore } from './releaseNoteStore'
import { useInboxStore } from './inboxStore'

// 오늘 대시보드의 데이터 스토어. 화면 조립은 components/today/todayModel.ts 가 한다.
// 여기서는 기존 스토어(비서·할 일·Jira 보드·릴리스·나에게 온 요청)를 한꺼번에 불러오고, 오늘 대시보드만 쓰는
// 캘린더 범위(오늘 0시 ~ +21일)를 들고 있다. 업무 공유 카드용으로 지난 근무일 일정(pastEvents)과 회의록 목록도 따로 받는다. 한 줄 브리핑·신호 문구는 규칙(todayModel)이 만든다. 캘린더 스토어는 주 단위라 다음 주 배포를 못 본다.

/** 캘린더를 받는 기간(일). 다음 주 배포·QA 일정까지 본다 */
export const CALENDAR_RANGE_DAYS = 21

export interface TodayStore {
  events: CalendarEvent[]
  eventsError: string | null
  /** 지난 근무일(previousWorkRange) 구간의 일정. 실패하면 직전 값을 둔다 */
  pastEvents: CalendarEvent[]
  /** 요약된 회의록 목록(meetingNotes.list). 실패하면 직전 값을 둔다 */
  meetingNotes: MeetingNoteItem[]
  loading: boolean
  /** 마지막으로 불러오기가 끝난 시각. ISO */
  lastSyncedAt: string | null
  /** 화면 진입: 캐시 허용 */
  load: () => Promise<void>
  /** ↻: 전부 강제 갱신 */
  refresh: () => Promise<void>
}

// 늦게 끝난 옛 요청이 새 결과를 덮지 않게 요청마다 번호를 붙인다
let loadSeq = 0
let rangeSeq = 0
let pastSeq = 0
let notesSeq = 0

/** 테스트용: 모듈 상태(요청 번호)를 비운다 */
export function resetTodayStoreInternals(): void {
  loadSeq = 0
  rangeSeq = 0
  pastSeq = 0
  notesSeq = 0
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

/** 오늘 로컬 0시와 그로부터 CALENDAR_RANGE_DAYS 일 뒤 */
export function calendarRange(now: Date): { from: string; to: string } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + CALENDAR_RANGE_DAYS)
  return { from: from.toISOString(), to: to.toISOString() }
}

export const useTodayStore = create<TodayStore>((set) => {
  const fetchRange = async (force: boolean): Promise<void> => {
    const seq = ++rangeSeq
    const { from, to } = calendarRange(new Date())
    try {
      const res = await window.api.calendar.range(from, to, force)
      if (seq !== rangeSeq) return
      if (res.success) set({ events: res.events, eventsError: null })
      // 실패하면 직전 일정을 그대로 두고 오류만 알린다
      else set({ eventsError: res.error || '일정을 불러오지 못했어요' })
    } catch (e) {
      if (seq !== rangeSeq) return
      set({ eventsError: errorText(e, '일정을 불러오지 못했어요') })
    }
  }

  // 지난 근무일 일정. 오늘 범위(events)와는 별개 요청이다. 실패는 조용히 넘긴다(직전 값 유지)
  const fetchPast = async (force: boolean): Promise<void> => {
    const seq = ++pastSeq
    const { from, to } = previousWorkRange(new Date())
    try {
      const res = await window.api.calendar.range(from.toISOString(), to.toISOString(), force)
      if (seq !== pastSeq) return
      if (res.success) set({ pastEvents: res.events })
    } catch {
      // 직전 값 유지
    }
  }

  const fetchNotes = async (): Promise<void> => {
    const seq = ++notesSeq
    try {
      const notes = await window.api.meetingNotes.list()
      if (seq !== notesSeq) return
      if (Array.isArray(notes)) set({ meetingNotes: notes })
    } catch {
      // 직전 값 유지
    }
  }

  // 하나가 실패해도 나머지는 반영한다. 각 스토어가 자기 오류 상태를 들고 있다
  const run = async (force: boolean): Promise<void> => {
    const seq = ++loadSeq
    set({ loading: true })
    const todo = useTodoStore.getState()
    const jira = useJiraBoardStore.getState()
    const release = useReleaseNoteStore.getState()
    await Promise.allSettled([
      useAssistantStore.getState().load(),
      // listActive 는 오늘 완료분도 돌려준다. 완료 목록은 그 밖의 경로로 완료한 항목까지 맞추려고 함께 읽는다
      todo.fetchActiveTodos(),
      todo.fetchCompletedTodos(),
      force ? jira.sync('incremental') : jira.load(),
      (async () => {
        await release.fetchAllReleaseNotes()
        await useReleaseNoteStore.getState().syncChanges(force)
      })(),
      // 나에게 온 요청. force 가 아니면 main 이 10분 간격으로 원본 호출을 거른다
      useInboxStore.getState().load(force),
      fetchRange(force),
      fetchPast(force),
      fetchNotes()
    ])
    if (seq !== loadSeq) return
    set({ loading: false, lastSyncedAt: new Date().toISOString() })
  }

  return {
    events: [],
    eventsError: null,
    pastEvents: [],
    meetingNotes: [],
    loading: false,
    lastSyncedAt: null,

    load: () => run(false),
    refresh: () => run(true)
  }
})
