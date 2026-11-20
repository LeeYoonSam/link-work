import { describe, it, expect } from 'vitest'
import { filterHallucinations } from './hallucination-filter'
import type { SttSegment } from '../meeting-types'

const seg = (text: string, start = 0): SttSegment => ({ start_ms: start, end_ms: start + 1000, text })
const texts = (segs: SttSegment[]): string[] => segs.map((s) => s.text)

describe('filterHallucinations — 블록리스트', () => {
  it.each([
    '시청해주셔서 감사합니다.',
    '시청해 주셔서 감사합니다',
    '영상 시청해주셔서 감사합니다!',
    '구독과 좋아요 부탁드립니다.',
    '구독, 좋아요, 알림설정',
    '구독 좋아요 알림설정 부탁드립니다',
    '다음 영상에서 만나요~',
    '한글자막 by 한효정',
    '자막 제공 및 광고',
    'MBC 뉴스 홍길동입니다.',
    'KBS 뉴스 김철수 기자입니다.'
  ])('"%s"를 제거한다', (text) => {
    const result = filterHallucinations([seg(text)])
    expect(result.segments).toEqual([])
    expect(result.removed).toBe(1)
  })

  it('환각 문구들로만 이어진 세그먼트도 제거한다', () => {
    const result = filterHallucinations([seg('시청해주셔서 감사합니다. 구독과 좋아요 부탁드립니다.')])
    expect(result.removed).toBe(1)
  })

  it.each([
    '감사합니다.',
    '네',
    '안녕하세요.',
    '시청률이 올랐습니다.',
    '시청해주셔서 감사합니다 라는 문구가 자막에 나오던데요',
    '다음 시간에 뵙겠습니다.',
    '자막 기능을 추가해야 합니다.',
    'MBC 뉴스에서 봤어요.'
  ])('일상·부분 포함 발화 "%s"는 보존한다', (text) => {
    const result = filterHallucinations([seg(text)])
    expect(texts(result.segments)).toEqual([text])
    expect(result.removed).toBe(0)
  })
})

describe('filterHallucinations — 프롬프트 에코', () => {
  const PROMPT =
    '다음은 한국어 회의 녹음입니다. 주제: 주간 스프린트 회고. 참석자: 김철수, 이영희. 용어: LinkWork, WBS, Jira.'

  it('프롬프트 기본 문장 에코를 제거한다', () => {
    const result = filterHallucinations([seg('다음은 한국어 회의 녹음입니다.')], { prompt: PROMPT })
    expect(result.removed).toBe(1)
  })

  it('"용어: A, B, C." 에코를 제거한다', () => {
    const result = filterHallucinations([seg('용어: LinkWork, WBS, Jira.')], { prompt: PROMPT })
    expect(result.removed).toBe(1)
  })

  it('프롬프트의 10자 이상 연속 부분 문자열 에코를 제거한다', () => {
    const result = filterHallucinations([seg('한국어 회의 녹음입니다')], { prompt: PROMPT })
    expect(result.removed).toBe(1)
  })

  it('용어 단독 발화와 짧은 부분 일치는 보존한다', () => {
    const input = [seg('LinkWork'), seg('Jira', 1000), seg('회의 녹음', 2000), seg('김철수', 3000)]
    const result = filterHallucinations(input, { prompt: PROMPT })
    expect(texts(result.segments)).toEqual(['LinkWork', 'Jira', '회의 녹음', '김철수'])
    expect(result.removed).toBe(0)
  })

  it('prompt 미지정 시 블록리스트만 동작한다', () => {
    const input = [seg('다음은 한국어 회의 녹음입니다.'), seg('시청해주셔서 감사합니다.', 1000)]
    const result = filterHallucinations(input)
    expect(texts(result.segments)).toEqual(['다음은 한국어 회의 녹음입니다.'])
    expect(result.removed).toBe(1)
  })
})

describe('filterHallucinations — 공통', () => {
  it('removed 개수가 정확하고 순서·나머지 세그먼트를 보존한다', () => {
    const input = [
      seg('오늘 안건은 세 가지입니다.', 0),
      seg('시청해주셔서 감사합니다.', 1000),
      seg('네', 2000),
      seg('다음은 한국어 회의 녹음입니다.', 3000),
      seg('구독과 좋아요 부탁드립니다.', 4000),
      seg('감사합니다.', 5000)
    ]
    const result = filterHallucinations(input, { prompt: '다음은 한국어 회의 녹음입니다.' })
    expect(result.removed).toBe(3)
    expect(texts(result.segments)).toEqual(['오늘 안건은 세 가지입니다.', '네', '감사합니다.'])
  })

  it('입력 배열을 변형하지 않는다', () => {
    const input = [seg('시청해주셔서 감사합니다.'), seg('정상 발화입니다.', 1000)]
    const snapshot = JSON.parse(JSON.stringify(input))
    filterHallucinations(input, { prompt: '다음은 한국어 회의 녹음입니다.' })
    expect(input).toEqual(snapshot)
  })
})
