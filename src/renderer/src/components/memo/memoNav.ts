// 메모 화면 탐색 순수 함수: 최근 본 기록, 키보드 선택 이동, 레이아웃 판정, 저장소 읽기·쓰기.
// React·store 에 의존하지 않는다. 저장소는 인자로 받아 window 없이 테스트한다

const RECENT_MAX = 10

// 맨 앞에 넣고 중복을 빼고 상한을 지킨다
export function pushRecent(ids: number[], id: number, max = RECENT_MAX): number[] {
  return [id, ...ids.filter((x) => x !== id)].slice(0, max)
}

export type MoveKey = 'up' | 'down' | 'home' | 'end'

// 목록에서 선택을 옮긴다. 끝에서 멈추고(순환 없음), 현재 선택이 목록에 없으면 첫 항목(End 는 끝)이다
export function moveSelection(ids: number[], currentId: number | null, key: MoveKey): number | null {
  if (ids.length === 0) return null
  if (key === 'home') return ids[0]
  if (key === 'end') return ids[ids.length - 1]
  const i = currentId === null ? -1 : ids.indexOf(currentId)
  if (i < 0) return ids[0]
  if (key === 'up') return ids[Math.max(0, i - 1)]
  return ids[Math.min(ids.length - 1, i + 1)]
}

// 목록에서 id 가 빠질 때(보관·복원·삭제) 다음에 고를 항목: 바로 아래, 없으면 바로 위
export function neighborAfterRemoval(ids: number[], id: number): number | null {
  const i = ids.indexOf(id)
  if (i < 0) return ids[0] ?? null
  return ids[i + 1] ?? ids[i - 1] ?? null
}

type LayoutMode = 'three' | 'two' | 'one'

const LAYOUT_THREE_MIN = 880
const LAYOUT_TWO_MIN = 600

// 메모 화면 컨테이너 폭으로 단 수를 고른다(뷰포트가 아니라 컨테이너 기준)
export function layoutMode(width: number): LayoutMode {
  if (width >= LAYOUT_THREE_MIN) return 'three'
  if (width >= LAYOUT_TWO_MIN) return 'two'
  return 'one'
}

// 입력 중인 요소면 단축키를 가로채지 않는다
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as { tagName?: unknown; isContentEditable?: unknown }
  if (el.isContentEditable === true) return true
  return typeof el.tagName === 'string' && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName.toUpperCase())
}

// ---------- 저장소 ----------

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

// 저장소를 쓸 수 없거나(사생활 보호 창 등) 값이 깨져도 기본값으로 동작한다
export function readJson<T>(storage: KeyValueStorage | null, key: string, fallback: T): T {
  if (!storage) return fallback
  try {
    const raw = storage.getItem(key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(storage: KeyValueStorage | null, key: string, value: unknown): void {
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // 저장 실패는 무시한다. 기록이 남지 않을 뿐 기능은 그대로다
  }
}

// 최근 본 id 목록을 검증한다. 숫자가 아닌 값·중복은 버린다
export function sanitizeIds(value: unknown, max = RECENT_MAX): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const v of value) {
    if (typeof v === 'number' && Number.isInteger(v) && !out.includes(v)) out.push(v)
    if (out.length >= max) break
  }
  return out
}
