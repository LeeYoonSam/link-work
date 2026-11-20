// 오늘 대시보드 스냅샷 보관소. 데스크톱 렌더러가 조립해 올린 마지막 1개만 메모리에 둔다.
// 메인은 내용을 해석하지 않는다 — 객체인지, date 가 YYYY-MM-DD 인지, 직렬화 크기 ≤ 1MB 인지만 본다.
import type { MobilePublishResult, MobileTodaySnapshot } from './types'

export const MAX_SNAPSHOT_BYTES = 1024 * 1024

export function validateSnapshot(
  value: unknown
): { ok: true; snapshot: MobileTodaySnapshot } | { ok: false; error: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '스냅샷은 객체여야 합니다.' }
  }
  const date = (value as { date?: unknown }).date
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: '스냅샷 date 는 YYYY-MM-DD 문자열이어야 합니다.' }
  }
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    return { ok: false, error: '스냅샷을 직렬화할 수 없습니다.' }
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_SNAPSHOT_BYTES) {
    return { ok: false, error: '스냅샷이 1MB 를 넘습니다.' }
  }
  // 이후 렌더러 쪽 객체 변경과 분리되도록 직렬화본으로 보관한다
  return { ok: true, snapshot: JSON.parse(json) as MobileTodaySnapshot }
}

export interface SnapshotStore {
  get: () => MobileTodaySnapshot | null
  publish: (value: unknown) => MobilePublishResult
  clear: () => void
}

export function createSnapshotStore(): SnapshotStore {
  let current: MobileTodaySnapshot | null = null
  return {
    get: () => current,
    publish: (value) => {
      const r = validateSnapshot(value)
      if (!r.ok) return { success: false, error: r.error }
      current = r.snapshot
      return { success: true }
    },
    clear: () => {
      current = null
    }
  }
}
