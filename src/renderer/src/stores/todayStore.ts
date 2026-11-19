import { create } from 'zustand'
import type { CalendarEvent, TodayBriefing, TodayBriefingInput } from '../types'
import { useAssistantStore } from './assistantStore'
import { useTodoStore } from './todoStore'
import { useJiraBoardStore } from './jiraBoardStore'
import { useReleaseNoteStore } from './releaseNoteStore'

// 오늘 대시보드의 데이터 스토어. 화면 조립은 components/today/todayModel.ts 가 한다.
// 여기서는 기존 스토어(비서·할 일·Jira 보드·릴리스)를 한꺼번에 불러오고, 오늘 대시보드만 쓰는
// 캘린더 범위(오늘 0시 ~ +21일)와 오늘 브리핑을 들고 있다. 캘린더 스토어는 주 단위라 다음 주 배포를 못 본다.

/** 캘린더를 받는 기간(일). 다음 주 배포·QA 일정까지 본다 */
export const CALENDAR_RANGE_DAYS = 21

export interface TodayStore {
  events: CalendarEvent[]
  eventsError: string | null
  briefing: TodayBriefing | null
  briefingLoading: boolean
  loading: boolean
  /** 마지막으로 불러오기가 끝난 시각. ISO */
  lastSyncedAt: string | null
  /** 화면 진입: 캐시 허용 */
  load: () => Promise<void>
  /** ↻: 전부 강제 갱신 */
  refresh: () => Promise<void>
  /** 직렬화한 입력이 직전과 같으면 생략한다(force 면 늘 부른다) */
  requestBriefing: (input: TodayBriefingInput, force?: boolean) => Promise<void>
}

// 늦게 끝난 옛 요청이 새 결과를 덮지 않게 요청마다 번호를 붙인다
let loadSeq = 0
let rangeSeq = 0
let briefingSeq = 0
let lastBriefingKey: string | null = null
// 메인이 10분 제한으로 규칙 브리핑을 돌려주며 retryAfterMs 를 주면 그 뒤 같은 입력으로 다시 부른다. 타이머는 1개뿐이다
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryKey: string | null = null

function clearRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer)
  retryTimer = null
  retryKey = null
}

/** 테스트용: 모듈 상태(요청 번호·직전 브리핑 입력)를 비운다 */
export function resetTodayStoreInternals(): void {
  loadSeq = 0
  rangeSeq = 0
  briefingSeq = 0
  lastBriefingKey = null
  clearRetry()
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

export const useTodayStore = create<TodayStore>((set, get) => {
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
      fetchRange(force)
    ])
    if (seq !== loadSeq) return
    set({ loading: false, lastSyncedAt: new Date().toISOString() })
  }

  return {
    events: [],
    eventsError: null,
    briefing: null,
    briefingLoading: false,
    loading: false,
    lastSyncedAt: null,

    load: () => run(false),
    refresh: () => run(true),

    requestBriefing: async (input, force = false) => {
      const key = JSON.stringify(input)
      if (!force && key === lastBriefingKey) return
      // 같은 입력의 재시도가 이미 예약돼 있으면 그 타이머에 맡긴다
      if (!force && key === retryKey) return
      // 새 요청이 예약된 재시도를 대신한다
      clearRetry()
      lastBriefingKey = key
      const seq = ++briefingSeq
      set({ briefingLoading: true })
      try {
        const res = await window.api.today.getBriefing(input, force)
        if (seq !== briefingSeq) return
        if (res.success) {
          set({ briefing: res.briefing, briefingLoading: false })
          const wait = res.retryAfterMs
          if (typeof wait === 'number' && wait > 0) {
            // 제한에 걸린 규칙 브리핑이다. 이 입력은 아직 처리되지 않은 것으로 두고 그 뒤 다시 부른다
            lastBriefingKey = null
            retryKey = key
            retryTimer = setTimeout(() => {
              retryTimer = null
              retryKey = null
              void get().requestBriefing(input)
            }, wait)
          }
        } else {
          // 실패는 규칙 화면을 그대로 둔다. 같은 입력으로 다시 부를 수 있게 기억을 지운다
          lastBriefingKey = null
          set({ briefingLoading: false })
        }
      } catch {
        if (seq !== briefingSeq) return
        lastBriefingKey = null
        set({ briefingLoading: false })
      }
    }
  }
})
