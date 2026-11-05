import { create } from 'zustand'
import type { MorningSyncPartName, MorningSyncStatus } from '../types'

// 아침 자동 동기화 상태 (docs/ASSISTANT.md A54, docs/PROJECT_SYNC.md R11).
// 사이드바 배지와 목록 화면 상태 줄이 읽는다. 이 스토어는 아무것도 쓰지 않는다.
// 타입은 types/index.ts 의 공유 타입을 쓴다. 기존 import 경로를 위해 부분 이름만 다시 내보낸다
export type { MorningSyncPartName }

type MorningStatusResult =
  | { success: true; status: MorningSyncStatus }
  | { success: false; error?: string }

// preload 의 projectSync.morningStatus 다. 이전 preload 에는 없을 수 있어 선택으로 읽는다
interface MorningStatusApi {
  morningStatus?: () => Promise<MorningStatusResult>
}

function morningStatusApi(): MorningStatusApi['morningStatus'] | undefined {
  const g = globalThis as unknown as { window?: { api?: { projectSync?: MorningStatusApi } } }
  const api = g.window?.api
  return api?.projectSync?.morningStatus
}

export type SeenMarks = Record<MorningSyncPartName, string | null>

const SEEN_KEY = 'linkwork.morningSync.seen'
const EMPTY_SEEN: SeenMarks = { release: null, project: null }

// 한 번의 실행을 가리키는 표식이다. 같은 실행의 새 항목은 한 번만 알린다
export function runMark(status: MorningSyncStatus | null, part: MorningSyncPartName): string | null {
  const p = status?.[part]
  if (!status?.date || !p) return null
  return `${status.date}|${p.finishedAt ?? ''}`
}

// 사용자가 아직 보지 않은 새 항목 수다. 성공한 실행만 센다
export function unseenOf(
  status: MorningSyncStatus | null,
  seen: SeenMarks,
  part: MorningSyncPartName
): number {
  const p = status?.[part]
  if (!p || p.status !== 'ok' || p.newCount <= 0) return 0
  const mark = runMark(status, part)
  if (mark === null || seen[part] === mark) return 0
  return p.newCount
}

// localStorage 는 미리보기·사생활 모드에서 throw 한다. 그래서 모든 접근을 try/catch 로 감싼다
function readSeen(): SeenMarks {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_KEY)
    if (!raw) return { ...EMPTY_SEEN }
    const v = JSON.parse(raw) as Partial<Record<string, unknown>>
    return {
      release: typeof v.release === 'string' ? v.release : null,
      project: typeof v.project === 'string' ? v.project : null
    }
  } catch {
    return { ...EMPTY_SEEN }
  }
}

function writeSeen(seen: SeenMarks): void {
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    // 저장하지 못해도 이번 세션 안에서는 메모리 값으로 동작한다
  }
}

interface MorningStoreState {
  status: MorningSyncStatus | null
  error: string
  seen: SeenMarks
  // 상태를 다시 읽는다. throw 하지 않는다
  load: () => Promise<void>
  unseenCount: (part: MorningSyncPartName) => number
  // 지금 실행의 새 항목을 본 것으로 표시한다
  markSeen: (part: MorningSyncPartName) => void
}

export const useMorningSyncStore = create<MorningStoreState>((set, get) => ({
  status: null,
  error: '',
  seen: readSeen(),

  load: async () => {
    const call = morningStatusApi()
    if (typeof call !== 'function') return
    try {
      const res = await call()
      if (res?.success) set({ status: res.status, error: '' })
      else set({ error: res?.error || '아침 동기화 상태를 불러오지 못했어요' })
    } catch (e) {
      set({ error: e instanceof Error && e.message ? e.message : '아침 동기화 상태를 불러오지 못했어요' })
    }
  },

  unseenCount: (part) => unseenOf(get().status, get().seen, part),

  markSeen: (part) => {
    const mark = runMark(get().status, part)
    if (mark === null || get().seen[part] === mark) return
    const seen = { ...get().seen, [part]: mark }
    set({ seen })
    writeSeen(seen)
  }
}))
