import { describe, it, expect } from 'vitest'
import { buildInitialPrompt } from './initial-prompt'

describe('buildInitialPrompt', () => {
  it('비한국어 전사에는 프롬프트를 붙이지 않는다', () => {
    // 한국어 문장으로 구성된 힌트라 en/ja 등에는 오히려 방해가 된다 → undefined.
    expect(buildInitialPrompt({ kind: 'meeting', language: 'en' })).toBeUndefined()
    expect(buildInitialPrompt({ kind: 'meeting', language: 'ja' })).toBeUndefined()
  })

  it('한국어 계열(ko/ko-KR)은 기본 문장만이라도 반환한다', () => {
    expect(buildInitialPrompt({ kind: 'meeting', language: 'ko' })).toBe(
      '다음은 한국어 회의 녹음입니다.'
    )
    expect(buildInitialPrompt({ kind: 'meeting', language: 'ko-KR' })).toBe(
      '다음은 한국어 회의 녹음입니다.'
    )
  })

  it('면접(kind=interview)은 면접 기본 문장을 쓴다', () => {
    expect(buildInitialPrompt({ kind: 'interview', language: 'ko' })).toBe(
      '다음은 한국어 채용 면접 녹음입니다.'
    )
  })

  it('자동 부여 기본 제목은 주제로 넣지 않는다', () => {
    // '제목 없는 회의'/'제목 없는 면접'은 힌트 가치가 없다.
    expect(
      buildInitialPrompt({ kind: 'meeting', language: 'ko', title: '제목 없는 회의' })
    ).toBe('다음은 한국어 회의 녹음입니다.')
    expect(
      buildInitialPrompt({ kind: 'interview', language: 'ko', title: '제목 없는 면접' })
    ).toBe('다음은 한국어 채용 면접 녹음입니다.')
  })

  it('제목·프로젝트·참석자를 우선순위 순으로 덧붙인다', () => {
    const r = buildInitialPrompt({
      kind: 'meeting',
      language: 'ko',
      title: 'API 연동 설계',
      projectName: 'LinkWork',
      speakerNames: ['김철수', '이영희']
    })
    expect(r).toBe(
      '다음은 한국어 회의 녹음입니다. 주제: API 연동 설계. 프로젝트: LinkWork. 참석자: 김철수, 이영희.'
    )
  })

  it('일정 제목이 회의 제목과 같으면 중복으로 넣지 않는다', () => {
    const r = buildInitialPrompt({
      kind: 'meeting',
      language: 'ko',
      title: '주간 회의',
      calendarEventTitle: '주간 회의'
    })
    expect(r).toBe('다음은 한국어 회의 녹음입니다. 주제: 주간 회의.')
  })

  it('일정 제목이 회의 제목과 다르면 덧붙인다', () => {
    const r = buildInitialPrompt({
      kind: 'meeting',
      language: 'ko',
      title: '주간 회의',
      calendarEventTitle: '스프린트 플래닝'
    })
    expect(r).toBe('다음은 한국어 회의 녹음입니다. 주제: 주간 회의. 일정: 스프린트 플래닝.')
  })

  it('참석자는 공백/빈 문자열 제거·중복 제거 후 최대 5명까지만 넣는다', () => {
    const r = buildInitialPrompt({
      kind: 'meeting',
      language: 'ko',
      // 앞뒤 공백, 빈 문자열, 중복(김철수), 6번째 이름(한소희)이 섞여 있다.
      speakerNames: ['  김철수 ', '', '이영희', '김철수', '박민수', '최지우', '정해인', '한소희']
    })
    // 정규화 후 김철수/이영희/박민수/최지우/정해인 5명에서 잘림(한소희 제외).
    expect(r).toBe('다음은 한국어 회의 녹음입니다. 참석자: 김철수, 이영희, 박민수, 최지우, 정해인.')
  })

  it('총 길이가 300자를 넘기는 항목은 통째로 제외한다', () => {
    const r = buildInitialPrompt({
      kind: 'meeting',
      language: 'ko',
      title: '가'.repeat(400)
    })
    // 상한을 넘기는 긴 제목 항목은 빠지고 기본 문장만 남는다.
    expect(r).toBe('다음은 한국어 회의 녹음입니다.')
    expect(r!.length).toBeLessThanOrEqual(300)
  })
})
