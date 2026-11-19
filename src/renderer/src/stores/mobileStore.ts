import { create } from 'zustand'
import type { MobileServerStatus } from '../mobile/contract'

// 휴대폰 열람 서버 상태 (docs/MOBILE_VIEW.md).
// 설정 > 모바일 섹션과 오늘 대시보드 발행기(components/mobile/MobileTodayPublisher)가 함께 쓴다.
// 섹션에서 켜고 끄면 발행기가 즉시 따라 움직인다.

export interface MobileStore {
  status: MobileServerStatus | null
  /** getStatus 를 한 번이라도 받았는가 */
  loaded: boolean
  /** 켜기·끄기·재발급 처리 중 */
  busy: boolean
  /** IPC 자체가 실패한 경우의 문구(서버가 돌려준 status.error 와 별개) */
  error: string | null
  load: () => Promise<void>
  /** 화면이 보이는 동안의 조용한 재조회(Wi-Fi 가 바뀌면 QR·주소가 바뀐다). 처리 중이면 생략하고 실패는 무시한다 */
  refresh: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  regenerate: () => Promise<void>
}

function mobileApi(): Window['api']['mobile'] | null {
  if (typeof window === 'undefined') return null
  return window.api?.mobile ?? null
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

const UNAVAILABLE = '이 버전에서는 휴대폰 열람을 쓸 수 없습니다'

export const useMobileStore = create<MobileStore>((set, get) => {
  // 처리 중에는 새 요청을 받지 않는다. 결과 상태로 통째로 바꾼다
  const run = async (job: (api: NonNullable<ReturnType<typeof mobileApi>>) => Promise<MobileServerStatus>, fallback: string): Promise<void> => {
    if (get().busy) return
    const api = mobileApi()
    if (!api) {
      set({ error: UNAVAILABLE })
      return
    }
    set({ busy: true, error: null })
    try {
      const status = await job(api)
      set({ status, loaded: true, busy: false })
    } catch (e) {
      set({ busy: false, error: errorText(e, fallback) })
    }
  }

  return {
    status: null,
    loaded: false,
    busy: false,
    error: null,

    load: async () => {
      const api = mobileApi()
      if (!api) {
        set({ loaded: true, error: UNAVAILABLE })
        return
      }
      try {
        const status = await api.getStatus()
        set({ status, loaded: true })
      } catch (e) {
        set({ loaded: true, error: errorText(e, '휴대폰 열람 상태를 읽지 못했습니다') })
      }
    },

    refresh: async () => {
      if (get().busy) return
      const api = mobileApi()
      if (!api) return
      try {
        const status = await api.getStatus()
        // 기다리는 동안 켜기·끄기·재발급이 시작됐으면 그 결과가 이긴다
        if (get().busy) return
        set({ status, loaded: true })
      } catch {
        // 조용한 재조회다. 직전 상태를 그대로 둔다
      }
    },

    setEnabled: (enabled) => run((api) => api.setEnabled(enabled), enabled ? '켜지 못했습니다' : '끄지 못했습니다'),

    regenerate: () => run((api) => api.regenerateToken(), 'QR 을 다시 만들지 못했습니다')
  }
})
