// 메모 텍스트·시각 처리 순수 함수. React·store·window 에 의존하지 않는다.
import { format } from 'date-fns'

export const UNTITLED = '제목 없음'
const TITLE_MAX = 80

// 마크다운을 검색·발췌용 평문으로 바꾼다.
// 표 구분선과 코드펜스 줄은 지우고, 코드 내용은 남긴다(검색 대상이라서).
// 줄바꿈과 연속 공백은 공백 하나로 압축한다
export function toPlainText(markdown: string): string {
  const out: string[] = []
  for (const raw of markdown.split('\n')) {
    let line = raw
    if (/^\s*(```|~~~)/.test(line)) continue
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*(>\s?)+/, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
      .replace(/`+/g, '')
      .replace(/(\*\*|__|~~)/g, '')
      .replace(/\*/g, '')
      .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, '$1$2')
      .replace(/\|/g, ' ')
    out.push(line)
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

export interface ParsedMemoTitle {
  title: string
  // 제목 줄 다음부터의 마크다운 원문
  body: string
}

// 첫 비어 있지 않은 줄을 제목으로 쓴다. # 헤딩·목록 기호·인라인 서식을 떼고 80자로 자른다
export function parseMemoTitle(content: string): ParsedMemoTitle {
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i += 1
  const rawTitle = (lines[i] ?? '').trim()
  const title = toPlainText(rawTitle).slice(0, TITLE_MAX) || UNTITLED
  const body = lines.slice(i + 1).join('\n')
  return { title, body }
}

// DB 시각 문자열을 Date 로 바꾼다.
// SQLite datetime('now') 는 오프셋 없는 UTC 문자열('2026-11-18 10:33:10')을 저장한다.
// new Date() 는 이것을 로컬 시각으로 읽어 KST 에서 9시간 이르게 보이므로, 오프셋이 없으면 UTC 로 읽는다.
// 이미 Z 나 +09:00 같은 오프셋이 있으면 그대로 쓴다. 해석할 수 없으면 Invalid Date 다
export function parseDbTime(value: string | null | undefined): Date {
  if (!value) return new Date(NaN)
  const s = value.trim()
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(s)
  if (m) return new Date(`${m[1]}T${m[2]}Z`)
  return new Date(s)
}

export function isValidDate(d: Date): boolean {
  return !Number.isNaN(d.getTime())
}

// DB 시각을 로컬 시각으로 포맷한다. 해석할 수 없으면 원문을 돌려준다
export function formatDbTime(value: string, fmt: string): string {
  const d = parseDbTime(value)
  return isValidDate(d) ? format(d, fmt) : value
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const DAY_MS = 24 * 60 * 60 * 1000

// 목록 행의 상대 시각.
// 1분 미만 '방금', 1시간 미만 'n분 전', 같은 날 'n시간 전', 전날 '어제', 7일 이내 'n일 전',
// 같은 해 'M/d', 그 밖 'yy/M/d'. 미래 시각(시계 오차)은 '방금'으로 본다
export function formatRelative(date: Date, now: Date): string {
  if (!isValidDate(date)) return ''
  const diff = now.getTime() - date.getTime()
  if (diff < 60_000) return '방금'
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}분 전`
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS)
  if (days <= 0) return `${Math.floor(diff / (60 * 60_000))}시간 전`
  if (days === 1) return '어제'
  if (days <= 7) return `${days}일 전`
  if (date.getFullYear() === now.getFullYear()) return format(date, 'M/d')
  return format(date, 'yy/M/d')
}
