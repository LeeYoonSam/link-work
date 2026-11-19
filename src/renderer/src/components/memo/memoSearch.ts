// 메모 검색·정렬·분류 레일 순수 함수. React·store·window 에 의존하지 않는다.
import type { Memo, MemoCategory } from '../../types'
import { parseDbTime, parseMemoTitle, toPlainText } from './memoText'

// ---------- 정규화와 일치 구간 ----------

export type Range = [start: number, end: number]

// 앞 글자에 붙는 코드 포인트: 결합 문자, 한글 자모 중성·종성(NFD 로 쪼개진 한글)
function isJoinerCodePoint(cp: number): boolean {
  if (cp >= 0x1160 && cp <= 0x11ff) return true
  if (cp >= 0xd7b0 && cp <= 0xd7ff) return true
  if (cp === 0x200d) return true
  return /\p{M}/u.test(String.fromCodePoint(cp))
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

// 검색어 정규화: NFKC(전각→반각, NFD 한글→완성형) + 소문자
export function normalizeSearch(s: string): string {
  return s.normalize('NFKC').toLowerCase()
}

interface NormalizedText {
  text: string
  // 정규화 문자열의 코드 유닛마다 원문 [시작, 끝) 인덱스
  starts: number[]
  ends: number[]
}

// 글자 묶음(기본 글자 + 결합 문자)마다 정규화해 원문 인덱스를 보존한다.
// NFKC 는 길이를 바꾸므로(예: 'ﬁ'→'fi', 자모 3개→음절 1개) 통째로 정규화하면 원문 위치를 잃는다
function normalizeWithMap(text: string): NormalizedText {
  let out = ''
  const starts: number[] = []
  const ends: number[] = []
  let i = 0
  while (i < text.length) {
    const start = i
    i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1
    while (i < text.length) {
      const cp = text.codePointAt(i) ?? 0
      if (!isJoinerCodePoint(cp)) break
      i += cp > 0xffff ? 2 : 1
    }
    const n = normalizeSearch(text.slice(start, i))
    out += n
    for (let k = 0; k < n.length; k += 1) {
      starts.push(start)
      ends.push(i)
    }
  }
  return { text: out, starts, ends }
}

// 검색어를 공백으로 나눈 토큰. 빈 토큰과 중복을 뺀다
export function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>()
  for (const t of normalizeSearch(query).split(/\s+/)) {
    if (t) seen.add(t)
  }
  return [...seen]
}

// 겹치거나 맞닿은 구간을 합친다
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const out: Range[] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

// 원문에서 토큰이 나오는 구간(원문 인덱스). 대소문자·전각·NFD 를 무시한다.
// indexOf 로 찾으므로 정규식 특수문자가 든 검색어도 문자 그대로 찾는다
export function findRanges(text: string, tokens: string[]): Range[] {
  if (!text || tokens.length === 0) return []
  const norm = normalizeWithMap(text)
  const ranges: Range[] = []
  for (const token of tokens) {
    if (!token) continue
    let from = 0
    for (;;) {
      const at = norm.text.indexOf(token, from)
      if (at < 0) break
      ranges.push([norm.starts[at], norm.ends[at + token.length - 1]])
      from = at + 1
    }
  }
  return mergeRanges(ranges)
}

function contains(text: string, token: string): boolean {
  return normalizeWithMap(text).text.includes(token)
}

// ---------- 발췌와 하이라이트 ----------

export interface Excerpt {
  text: string
  ranges: Range[]
}

function isJoinerAt(text: string, i: number): boolean {
  const cp = text.codePointAt(i)
  return cp !== undefined && isJoinerCodePoint(cp)
}

// 서로게이트 쌍이나 결합 문자 앞에서 자르지 않도록 시작을 앞으로 당긴다
function safeStart(text: string, i: number): number {
  let k = i
  while (k > 0 && (isLowSurrogate(text.charCodeAt(k)) || isJoinerAt(text, k))) k -= 1
  return k
}

// 끝(배타)이 쌍·결합 문자 가운데면 뒤로 민다
function safeEnd(text: string, i: number): number {
  let k = i
  while (k < text.length && (isLowSurrogate(text.charCodeAt(k)) || isJoinerAt(text, k))) k += 1
  return k
}

export const EXCERPT_RADIUS = 40
export const EXCERPT_LENGTH = 140

// 첫 일치 위치 주변을 자른 발췌. 앞뒤가 잘렸으면 '…'을 붙이고 구간을 발췌 기준으로 다시 계산한다.
// 일치가 없으면 앞부분(약 2줄 분량)을 쓴다
export function makeExcerpt(
  text: string,
  ranges: Range[],
  radius = EXCERPT_RADIUS,
  maxLength = EXCERPT_LENGTH
): Excerpt {
  if (!text) return { text: '', ranges: [] }
  const merged = mergeRanges(ranges)
  let start = 0
  if (merged.length > 0 && merged[0][0] - radius > 0) start = safeStart(text, merged[0][0] - radius)
  const wanted = merged.length > 0 ? Math.max(merged[0][1] + radius, start + maxLength) : maxLength
  const end = safeEnd(text, Math.min(text.length, wanted))
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const shift = prefix.length - start
  const out: Range[] = []
  for (const [a, b] of merged) {
    if (b <= start || a >= end) continue
    out.push([Math.max(a, start) + shift, Math.min(b, end) + shift])
  }
  return { text: prefix + text.slice(start, end) + suffix, ranges: out }
}

export interface Segment {
  text: string
  hit: boolean
}

// 하이라이트 구간으로 텍스트를 나눈다. 범위 밖 구간은 잘라 낸다
export function toSegments(text: string, ranges: Range[]): Segment[] {
  const segs: Segment[] = []
  let pos = 0
  for (const [a0, b0] of mergeRanges(ranges)) {
    const a = Math.max(a0, pos)
    const b = Math.min(b0, text.length)
    if (b <= a) continue
    if (a > pos) segs.push({ text: text.slice(pos, a), hit: false })
    segs.push({ text: text.slice(a, b), hit: true })
    pos = b
  }
  if (pos < text.length) segs.push({ text: text.slice(pos), hit: false })
  return segs
}

// ---------- 메모 매칭 ----------

export interface MemoTextIndex {
  title: string
  // 제목 줄을 뺀 본문 평문
  plain: string
}

export function indexMemoText(content: string): MemoTextIndex {
  const { title, body } = parseMemoTitle(content)
  return { title, plain: toPlainText(body) }
}

export interface MemoMatch {
  score: number
  titleRanges: Range[]
  bodyRanges: Range[]
  categoryHit: boolean
}

// 토큰마다 제목·분류명·본문 중 한 곳에는 있어야 한다(AND).
// 점수는 토큰마다 가장 강한 자리로 매긴다: 제목 100 > 분류명 10 > 본문 1.
// 토큰이 없으면 모두 일치(점수 0)다
export function matchMemo(
  entry: MemoTextIndex,
  categoryName: string | null,
  tokens: string[]
): MemoMatch | null {
  let score = 0
  let categoryHit = false
  for (const token of tokens) {
    if (contains(entry.title, token)) score += 100
    else if (categoryName && contains(categoryName, token)) {
      score += 10
      categoryHit = true
    } else if (contains(entry.plain, token)) score += 1
    else return null
  }
  return {
    score,
    titleRanges: findRanges(entry.title, tokens),
    bodyRanges: findRanges(entry.plain, tokens),
    categoryHit
  }
}

// ---------- 분류 ----------

// 분류 칩·레일의 분류 키. 지워진 분류를 가리키는 메모는 미분류로 본다
export type CategoryKey = number | 'uncategorized'

export function categoryKeyOf(memo: Memo, validIds: Set<number>): CategoryKey {
  return memo.category_id != null && validIds.has(memo.category_id) ? memo.category_id : 'uncategorized'
}

export function categoryIdSet(categories: MemoCategory[]): Set<number> {
  return new Set(categories.map((c) => c.id))
}

function sortedCategories(categories: MemoCategory[]): MemoCategory[] {
  return [...categories].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ko'))
}

// ---------- 정렬 ----------

export type MemoSortOrder = 'updated' | 'created' | 'oldest' | 'title'

export const SORT_LABELS: Record<MemoSortOrder, string> = {
  updated: '최근 수정순',
  created: '최근 작성순',
  oldest: '오래된순',
  title: '제목순'
}

// 예전 저장값('newest')을 새 값으로 옮긴다. 모르는 값이면 기본값
export function normalizeSortOrder(value: unknown): MemoSortOrder {
  if (value === 'newest') return 'created'
  if (value === 'updated' || value === 'created' || value === 'oldest' || value === 'title') return value
  return 'updated'
}

function timeOf(s: string): number {
  const t = parseDbTime(s).getTime()
  return Number.isNaN(t) ? 0 : t
}

// 동점이면 id 내림차순(나중에 만든 메모 먼저)으로 순서를 고정한다
export function sortMemos(memos: Memo[], order: MemoSortOrder): Memo[] {
  const titles = order === 'title' ? new Map(memos.map((m) => [m.id, parseMemoTitle(m.content).title])) : null
  return [...memos].sort((a, b) => {
    let d = 0
    if (order === 'updated') d = timeOf(b.updated_at) - timeOf(a.updated_at)
    else if (order === 'created') d = timeOf(b.created_at) - timeOf(a.created_at)
    else if (order === 'oldest') d = timeOf(a.created_at) - timeOf(b.created_at)
    else d = (titles!.get(a.id) ?? '').localeCompare(titles!.get(b.id) ?? '', 'ko')
    if (d !== 0) return d
    return order === 'oldest' ? a.id - b.id : b.id - a.id
  })
}

// ---------- 레일 ----------

export type RailKey = 'all' | 'important' | 'recent' | 'uncategorized' | 'archived' | number

export interface RailItem {
  key: RailKey
  label: string
  // null 이면 개수를 표시하지 않는다(최근 본)
  count: number | null
  color: string | null
  group: 'smart' | 'category' | 'archive'
}

// 레일 항목: 전체·중요·최근 본 / 분류들(sort_order 순, 0개 포함)·미분류 / 보관함
export function buildRailItems(memos: Memo[], archived: Memo[], categories: MemoCategory[]): RailItem[] {
  const valid = categoryIdSet(categories)
  const counts = new Map<CategoryKey, number>()
  for (const m of memos) {
    const k = categoryKeyOf(m, valid)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [
    { key: 'all', label: '전체', count: memos.length, color: null, group: 'smart' },
    {
      key: 'important',
      label: '중요',
      count: memos.filter((m) => m.is_important === 1).length,
      color: null,
      group: 'smart'
    },
    { key: 'recent', label: '최근 본', count: null, color: null, group: 'smart' },
    ...sortedCategories(categories).map<RailItem>((c) => ({
      key: c.id,
      label: c.name,
      count: counts.get(c.id) ?? 0,
      color: c.color,
      group: 'category'
    })),
    {
      key: 'uncategorized',
      label: '미분류',
      count: counts.get('uncategorized') ?? 0,
      color: null,
      group: 'category'
    },
    { key: 'archived', label: '보관함', count: archived.length, color: null, group: 'archive' }
  ]
}

// 레일이 고른 메모들. 최근 본은 기록 순서를 지키고 지워진 id 를 거른다(보관 메모도 포함)
export function selectByRail(
  memos: Memo[],
  archived: Memo[],
  rail: RailKey,
  recentIds: number[],
  categories: MemoCategory[]
): Memo[] {
  if (rail === 'all') return memos
  if (rail === 'important') return memos.filter((m) => m.is_important === 1)
  if (rail === 'archived') return archived
  if (rail === 'recent') {
    const byId = new Map<number, Memo>()
    for (const m of archived) byId.set(m.id, m)
    for (const m of memos) byId.set(m.id, m)
    return recentIds.map((id) => byId.get(id)).filter((m): m is Memo => m !== undefined)
  }
  const valid = categoryIdSet(categories)
  if (rail === 'uncategorized') return memos.filter((m) => categoryKeyOf(m, valid) === 'uncategorized')
  return memos.filter((m) => categoryKeyOf(m, valid) === rail)
}

export function groupImportantFirst(memos: Memo[]): { important: Memo[]; rest: Memo[] } {
  const important: Memo[] = []
  const rest: Memo[] = []
  for (const m of memos) (m.is_important === 1 ? important : rest).push(m)
  return { important, rest }
}

// ---------- 검색 ----------

export interface MemoListItem {
  memo: Memo
  title: string
  titleRanges: Range[]
  excerpt: Excerpt
}

export interface MemoSearchResult extends MemoListItem {
  score: number
  categoryHit: boolean
  categoryKey: CategoryKey
}

// 검색 없이 목록에 보일 행
export function toListItem(memo: Memo): MemoListItem {
  const { title, plain } = indexMemoText(memo.content)
  return { memo, title, titleRanges: [], excerpt: makeExcerpt(plain, []) }
}

// 메모를 검색한다. 순위는 점수 내림차순, 동점이면 updated_at 최신순.
// scope 를 주면 그 분류 결과만 남긴다(분류 칩)
export function searchMemos(
  memos: Memo[],
  categories: MemoCategory[],
  query: string,
  scope: CategoryKey | null = null
): MemoSearchResult[] {
  const tokens = tokenizeQuery(query)
  const valid = categoryIdSet(categories)
  const names = new Map(categories.map((c) => [c.id, c.name]))
  const results: MemoSearchResult[] = []
  for (const memo of memos) {
    const key = categoryKeyOf(memo, valid)
    if (scope !== null && key !== scope) continue
    const entry = indexMemoText(memo.content)
    const match = matchMemo(entry, typeof key === 'number' ? (names.get(key) ?? null) : null, tokens)
    if (!match) continue
    results.push({
      memo,
      title: entry.title,
      titleRanges: match.titleRanges,
      excerpt: makeExcerpt(entry.plain, match.bodyRanges),
      score: match.score,
      categoryHit: match.categoryHit,
      categoryKey: key
    })
  }
  return results.sort(
    (a, b) =>
      b.score - a.score || timeOf(b.memo.updated_at) - timeOf(a.memo.updated_at) || b.memo.id - a.memo.id
  )
}

// 메모 본문 전체에서 검색어가 나오는 곳 수(읽기 영역 머리 표시용)
export function countMatches(content: string, query: string): number {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return 0
  const norm = normalizeWithMap(content).text
  let n = 0
  for (const t of tokens) {
    let from = 0
    for (;;) {
      const at = norm.indexOf(t, from)
      if (at < 0) break
      n += 1
      from = at + t.length
    }
  }
  return n
}

export interface ScopeChip {
  key: CategoryKey
  label: string
  color: string | null
  count: number
}

// 검색 결과가 있는 분류만 칩으로 만든다. 분류 순서를 따르고 미분류는 끝이다
export function scopeChips(results: { categoryKey: CategoryKey }[], categories: MemoCategory[]): ScopeChip[] {
  const counts = new Map<CategoryKey, number>()
  for (const r of results) counts.set(r.categoryKey, (counts.get(r.categoryKey) ?? 0) + 1)
  const chips: ScopeChip[] = []
  for (const c of sortedCategories(categories)) {
    const n = counts.get(c.id)
    if (n) chips.push({ key: c.id, label: c.name, color: c.color, count: n })
  }
  const u = counts.get('uncategorized')
  if (u) chips.push({ key: 'uncategorized', label: '미분류', color: null, count: u })
  return chips
}

// ---------- 포커스 진입 ----------

// 앱 내 링크로 들어온 메모가 어느 레일에 있는지. 활성이면 '전체', 보관이면 '보관함'
export function resolveFocusTarget(
  id: number,
  memos: Memo[],
  archived: Memo[]
): { rail: 'all' | 'archived'; memo: Memo } | null {
  const active = memos.find((m) => m.id === id)
  if (active) return { rail: 'all', memo: active }
  const arch = archived.find((m) => m.id === id)
  if (arch) return { rail: 'archived', memo: arch }
  return null
}
