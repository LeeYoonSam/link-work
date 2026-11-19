import { describe, it, expect } from 'vitest'
import type { Memo, MemoCategory } from '../../types'
import {
  buildRailItems,
  countMatches,
  findRanges,
  groupImportantFirst,
  makeExcerpt,
  matchMemo,
  mergeRanges,
  normalizeSortOrder,
  resolveFocusTarget,
  scopeChips,
  searchMemos,
  selectByRail,
  sortMemos,
  toSegments,
  tokenizeQuery
} from './memoSearch'

let nextId = 1
function memo(content: string, over: Partial<Memo> = {}): Memo {
  const id = over.id ?? nextId++
  return {
    id,
    content,
    is_archived: 0,
    is_important: 0,
    color: 'default',
    category_id: null,
    created_at: '2026-11-01 00:00:00',
    updated_at: '2026-11-01 00:00:00',
    ...over
  }
}

const cat = (id: number, name: string, sort_order: number): MemoCategory => ({
  id,
  name,
  color: '#3B82F6',
  sort_order,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00'
})

describe('tokenizeQuery', () => {
  it('공백으로 나누고 빈 토큰·중복을 빼고 소문자로 바꾼다', () => {
    expect(tokenizeQuery('  Deploy  배포 deploy ')).toEqual(['deploy', '배포'])
    expect(tokenizeQuery('   ')).toEqual([])
  })
  it('전각 문자를 반각으로 정규화한다', () => {
    expect(tokenizeQuery('ＡＢＣ')).toEqual(['abc'])
  })
})

describe('findRanges', () => {
  it('대소문자를 무시하고 원문 인덱스를 돌려준다', () => {
    expect(findRanges('Hello WORLD hello', ['hello'])).toEqual([
      [0, 5],
      [12, 17]
    ])
  })

  it('한글을 찾는다', () => {
    expect(findRanges('오늘 회의 준비', ['회의'])).toEqual([[3, 5]])
  })

  it('NFD 로 쪼개진 한글 원문도 찾고 원문 인덱스로 돌려준다', () => {
    const nfd = '오늘 회의'.normalize('NFD')
    const [r] = findRanges(nfd, tokenizeQuery('회의'))
    expect(nfd.slice(r[0], r[1]).normalize('NFC')).toBe('회의')
  })

  it('여러 토큰의 겹치거나 맞닿은 구간을 합친다', () => {
    expect(findRanges('abcdef', ['abc', 'bcd'])).toEqual([[0, 4]])
    expect(findRanges('abcdef', ['ab', 'cd'])).toEqual([[0, 4]])
    expect(findRanges('abcdef', ['ab', 'ef'])).toEqual([
      [0, 2],
      [4, 6]
    ])
  })

  it('정규식 특수문자를 문자 그대로 찾는다', () => {
    expect(findRanges('비용 (a+b)*2 = c.d?', tokenizeQuery('(a+b)*2'))).toEqual([[3, 10]])
    expect(findRanges('a.b axb', tokenizeQuery('a.b'))).toEqual([[0, 3]])
    expect(findRanges('[x] \\d', tokenizeQuery('\\d'))).toEqual([[4, 6]])
  })

  it('빈 토큰 목록이면 구간이 없다', () => {
    expect(findRanges('abc', [])).toEqual([])
  })

  it('NFKC 로 길이가 바뀌는 글자(합자)도 원문 구간으로 돌려준다', () => {
    const text = 'oﬁce'
    expect(findRanges(text, ['fi'])).toEqual([[1, 2]])
  })
})

describe('mergeRanges / toSegments', () => {
  it('빈 구간을 버리고 겹침을 합친다', () => {
    expect(mergeRanges([[3, 3], [5, 8], [1, 4], [4, 5]])).toEqual([[1, 8]])
  })

  it('시작·끝 경계와 연속 구간', () => {
    expect(toSegments('abcdef', [[0, 2], [4, 6]])).toEqual([
      { text: 'ab', hit: true },
      { text: 'cd', hit: false },
      { text: 'ef', hit: true }
    ])
    expect(toSegments('abc', [])).toEqual([{ text: 'abc', hit: false }])
    expect(toSegments('abc', [[1, 99]])).toEqual([
      { text: 'a', hit: false },
      { text: 'bc', hit: true }
    ])
    expect(toSegments('', [])).toEqual([])
  })
})

describe('makeExcerpt', () => {
  const long = `${'가'.repeat(100)}배포절차${'나'.repeat(100)}`

  it('첫 일치 주변을 자르고 앞뒤에 … 을 붙이며 구간을 다시 계산한다', () => {
    const ranges = findRanges(long, ['배포'])
    const ex = makeExcerpt(long, ranges, 10, 30)
    expect(ex.text.startsWith('…')).toBe(true)
    expect(ex.text.endsWith('…')).toBe(true)
    expect(ex.ranges).toHaveLength(1)
    const [a, b] = ex.ranges[0]
    expect(ex.text.slice(a, b)).toBe('배포')
    expect(a).toBe(11) // '…' + 10자
  })

  it('일치가 없으면 앞부분을 쓴다', () => {
    const ex = makeExcerpt(long, [], 40, 20)
    expect(ex.text).toBe(`${'가'.repeat(20)}…`)
    expect(ex.ranges).toEqual([])
  })

  it('짧은 본문은 자르지 않는다', () => {
    expect(makeExcerpt('짧은 본문', [[3, 5]])).toEqual({ text: '짧은 본문', ranges: [[3, 5]] })
    expect(makeExcerpt('', [])).toEqual({ text: '', ranges: [] })
  })

  it('서로게이트 쌍과 결합 문자를 가운데서 자르지 않는다', () => {
    const emoji = `${'😀'.repeat(30)}키워드`
    const at = emoji.indexOf('키워드')
    const ex = makeExcerpt(emoji, [[at, at + 3]], 5, 10)
    // 깨진 서로게이트가 없다
    expect(ex.text).toBe(ex.text.normalize())
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(ex.text)).toBe(false)
    const nfd = `${'한'.repeat(5).normalize('NFD')}키`
    const at2 = nfd.indexOf('키')
    const ex2 = makeExcerpt(nfd, [[at2, at2 + 1]], 2, 3)
    // 결합 자모(중성·종성)로 시작하지 않는다
    expect(/^…[ᅠ-ᇿ]/.test(ex2.text)).toBe(false)
  })
})

describe('matchMemo', () => {
  const entry = { title: '배포 절차', plain: '빌드 후 Applications 에 복사한다' }
  it('토큰이 없으면 전체 일치(점수 0)', () => {
    expect(matchMemo(entry, null, [])).toEqual({ score: 0, titleRanges: [], bodyRanges: [], categoryHit: false })
  })
  it('모든 토큰이 어딘가에 있어야 한다(AND)', () => {
    expect(matchMemo(entry, '개발', ['배포', '빌드'])).not.toBeNull()
    expect(matchMemo(entry, '개발', ['배포', '없는말'])).toBeNull()
  })
  it('제목 > 분류명 > 본문 가중치', () => {
    const t = matchMemo(entry, '개발', ['배포'])!.score
    const c = matchMemo(entry, '개발', ['개발'])!.score
    const b = matchMemo(entry, '개발', ['빌드'])!.score
    expect(t).toBeGreaterThan(c)
    expect(c).toBeGreaterThan(b)
    expect(matchMemo(entry, '개발', ['개발'])!.categoryHit).toBe(true)
  })
})

describe('searchMemos', () => {
  const categories = [cat(1, '업무', 1), cat(2, '개발', 2)]
  const old = memo('# 배포 절차\n빌드 후 복사', { category_id: 2, updated_at: '2026-10-01 00:00:00' })
  const recentBody = memo('# 회의록\n배포 일정 공유', { category_id: 1, updated_at: '2026-11-10 00:00:00' })
  const other = memo('# 점심\n메뉴 고르기', { updated_at: '2026-11-11 00:00:00' })
  const memos = [old, recentBody, other]

  it('본문에만 있는 단어로 찾고, 결과에 분류 키를 싣는다', () => {
    const r = searchMemos(memos, categories, '메뉴')
    expect(r.map((x) => x.memo.id)).toEqual([other.id])
    expect(r[0].categoryKey).toBe('uncategorized')
    expect(r[0].excerpt.ranges.length).toBe(1)
  })

  it('제목 일치가 최근 본문 일치보다 위', () => {
    const r = searchMemos(memos, categories, '배포')
    expect(r.map((x) => x.memo.id)).toEqual([old.id, recentBody.id])
    expect(r[0].titleRanges).toEqual([[0, 2]])
  })

  it('동점이면 updated_at 최신순', () => {
    const a = memo('# a\n공통', { updated_at: '2026-11-01 00:00:00' })
    const b = memo('# b\n공통', { updated_at: '2026-11-02 00:00:00' })
    expect(searchMemos([a, b], [], '공통').map((x) => x.memo.id)).toEqual([b.id, a.id])
  })

  it('분류명으로 찾고 scope 로 좁힌다', () => {
    expect(searchMemos(memos, categories, '개발').map((x) => x.memo.id)).toEqual([old.id])
    expect(searchMemos(memos, categories, '배포', 1).map((x) => x.memo.id)).toEqual([recentBody.id])
    expect(searchMemos(memos, categories, '배포', 'uncategorized')).toEqual([])
  })

  it('지워진 분류를 가리키는 메모는 미분류로 본다', () => {
    const orphan = memo('# 고아\n본문', { category_id: 99 })
    expect(searchMemos([orphan], categories, '고아')[0].categoryKey).toBe('uncategorized')
  })

  it('빈 검색어는 모두 일치', () => {
    expect(searchMemos(memos, categories, '  ')).toHaveLength(3)
  })

  it('scopeChips 는 결과가 있는 분류만 분류 순서대로, 미분류는 끝', () => {
    const all = searchMemos(memos, categories, '')
    expect(scopeChips(all, categories)).toEqual([
      { key: 1, label: '업무', color: '#3B82F6', count: 1 },
      { key: 2, label: '개발', color: '#3B82F6', count: 1 },
      { key: 'uncategorized', label: '미분류', color: null, count: 1 }
    ])
    expect(scopeChips(searchMemos(memos, categories, '배포'), categories).map((c) => c.key)).toEqual([1, 2])
  })

  it('countMatches 는 본문 전체 일치 수를 센다', () => {
    expect(countMatches('배포 그리고 배포, Deploy deploy', '배포 deploy')).toBe(4)
    expect(countMatches('abc', '')).toBe(0)
  })
})

describe('sortMemos', () => {
  const a = memo('# 나', { id: 101, created_at: '2026-11-01 09:00:00', updated_at: '2026-11-03 00:00:00' })
  const b = memo('# 가', { id: 102, created_at: '2026-11-02 09:00:00', updated_at: '2026-11-02 00:00:00' })
  const c = memo('# 다', { id: 103, created_at: '2026-11-02 09:00:00', updated_at: '2026-11-01 00:00:00' })
  it('updated / created / oldest / title', () => {
    expect(sortMemos([a, b, c], 'updated').map((m) => m.id)).toEqual([101, 102, 103])
    expect(sortMemos([a, b, c], 'created').map((m) => m.id)).toEqual([103, 102, 101])
    expect(sortMemos([a, b, c], 'oldest').map((m) => m.id)).toEqual([101, 102, 103])
    expect(sortMemos([a, b, c], 'title').map((m) => m.id)).toEqual([102, 101, 103])
  })
  it('UTC 문자열과 오프셋 문자열을 같은 기준으로 비교한다', () => {
    const x = memo('x', { id: 201, updated_at: '2026-11-18 10:00:00' })
    const y = memo('y', { id: 202, updated_at: '2026-11-18T18:30:00+09:00' }) // UTC 09:30
    expect(sortMemos([y, x], 'updated').map((m) => m.id)).toEqual([201, 202])
  })
  it('예전 저장값 newest 는 created 로 옮긴다', () => {
    expect(normalizeSortOrder('newest')).toBe('created')
    expect(normalizeSortOrder('oldest')).toBe('oldest')
    expect(normalizeSortOrder('이상한값')).toBe('updated')
  })
})

describe('레일', () => {
  const categories = [cat(2, '개발', 2), cat(1, '업무', 1), cat(3, '빈 분류', 3)]
  const m1 = memo('a', { id: 1, category_id: 1, is_important: 1 })
  const m2 = memo('b', { id: 2, category_id: 2 })
  const m3 = memo('c', { id: 3, category_id: null })
  const m4 = memo('d', { id: 4, category_id: 99 })
  const ar = memo('e', { id: 5, category_id: 1, is_archived: 1 })
  const memos = [m1, m2, m3, m4]

  it('buildRailItems: 개수·0개 분류 포함·sort_order 순·지워진 분류는 미분류', () => {
    const items = buildRailItems(memos, [ar], categories)
    expect(items.map((i) => [i.key, i.count])).toEqual([
      ['all', 4],
      ['important', 1],
      ['recent', null],
      [1, 1],
      [2, 1],
      [3, 0],
      ['uncategorized', 2],
      ['archived', 1]
    ])
  })

  it('selectByRail', () => {
    const ids = (rail: Parameters<typeof selectByRail>[2], recent: number[] = []): number[] =>
      selectByRail(memos, [ar], rail, recent, categories).map((m) => m.id)
    expect(ids('all')).toEqual([1, 2, 3, 4])
    expect(ids('important')).toEqual([1])
    expect(ids('archived')).toEqual([5])
    expect(ids(1)).toEqual([1])
    expect(ids('uncategorized')).toEqual([3, 4])
    // 최근 본: 기록 순서 유지, 없는 id 제거, 보관 메모 포함
    expect(ids('recent', [3, 777, 5, 1])).toEqual([3, 5, 1])
  })

  it('groupImportantFirst', () => {
    const g = groupImportantFirst(memos)
    expect(g.important.map((m) => m.id)).toEqual([1])
    expect(g.rest.map((m) => m.id)).toEqual([2, 3, 4])
  })

  it('resolveFocusTarget: 활성이면 전체, 보관이면 보관함, 없으면 null', () => {
    expect(resolveFocusTarget(2, memos, [ar])).toEqual({ rail: 'all', memo: m2 })
    expect(resolveFocusTarget(5, memos, [ar])).toEqual({ rail: 'archived', memo: ar })
    expect(resolveFocusTarget(42, memos, [ar])).toBeNull()
  })
})
