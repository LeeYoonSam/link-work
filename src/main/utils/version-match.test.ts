import { describe, expect, it } from 'vitest'
import { compareVersionDesc } from './version-match'

describe('compareVersionDesc — 시맨틱 버전 내림차순', () => {
  const sorted = (names: string[]): string[] => [...names].sort(compareVersionDesc)

  it('마디를 숫자로 비교한다 — 사전순이면 4.46.0이 4.166.0보다 위로 온다', () => {
    // 실제로 화면에서 4.46.0이 맨 위에 앉았던 그 조합이다
    expect(sorted(['4.46.0', '4.166.0', '4.165.0'])).toEqual(['4.166.0', '4.165.0', '4.46.0'])
  })

  it('major가 다르면 major가 먼저다', () => {
    expect(sorted(['2.8.1', '4.46.0', '10.0.0'])).toEqual(['10.0.0', '4.46.0', '2.8.1'])
  })

  it('patch까지 내려가 비교한다', () => {
    expect(sorted(['4.164.0', '4.164.10', '4.164.2'])).toEqual(['4.164.10', '4.164.2', '4.164.0'])
  })

  it('마디 수가 달라도 없는 자리를 0으로 채워 비교한다', () => {
    expect(compareVersionDesc('4.166', '4.166.0')).toBe(0)
    expect(sorted(['4.166', '4.167.0'])).toEqual(['4.167.0', '4.166'])
  })

  it('v 접두사는 무시한다', () => {
    expect(sorted(['v4.166.0', '4.167.0'])).toEqual(['4.167.0', 'v4.166.0'])
  })

  it('접미사가 없는 정식 릴리스가 rc보다 위다', () => {
    expect(sorted(['4.166.0-rc1', '4.166.0'])).toEqual(['4.166.0', '4.166.0-rc1'])
    expect(sorted(['4.166.0-rc1', '4.166.0-rc2'])).toEqual(['4.166.0-rc2', '4.166.0-rc1'])
  })

  it('숫자로 시작하지 않는 이름은 전부 뒤로 가고 자기들끼리 이름순이다', () => {
    expect(sorted(['핫픽스', '4.166.0', 'Q3 릴리스'])).toEqual(['4.166.0', 'Q3 릴리스', '핫픽스'])
  })

  it('같은 버전은 0을 돌려줘 호출부의 다음 기준에 맡긴다', () => {
    expect(compareVersionDesc('4.164.0', '4.164.0')).toBe(0)
  })
})
