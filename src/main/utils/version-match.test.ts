import { describe, expect, it } from 'vitest'
import {
  compareVersionDesc,
  isSameVersion,
  matchesDeployVersion,
  normalizeVersionName,
  splitDeployVersions
} from './version-match'

describe('normalizeVersionName', () => {
  it('앞뒤 공백을 제거한다', () => {
    expect(normalizeVersionName('  4.164.0 ')).toBe('4.164.0')
  })

  it('선행 v/V를 제거한다', () => {
    expect(normalizeVersionName('v4.164.0')).toBe('4.164.0')
    expect(normalizeVersionName('V4.164.0')).toBe('4.164.0')
  })

  it('소문자로 맞춘다', () => {
    expect(normalizeVersionName('4.164.0-RC1')).toBe('4.164.0-rc1')
  })

  it('중간의 v는 건드리지 않는다', () => {
    expect(normalizeVersionName('4.164.0-v2')).toBe('4.164.0-v2')
  })
})

describe('isSameVersion — 같다고 봐야 하는 것', () => {
  it('완전히 같은 버전 이름', () => {
    expect(isSameVersion('4.164.0', '4.164.0')).toBe(true)
  })

  it('한쪽에만 v 접두사가 있는 경우', () => {
    expect(isSameVersion('v4.164.0', '4.164.0')).toBe(true)
    expect(isSameVersion('4.164.0', 'V4.164.0')).toBe(true)
  })

  it('앞뒤 공백이 섞인 경우', () => {
    expect(isSameVersion(' 4.164.0', '4.164.0 ')).toBe(true)
    expect(isSameVersion('  v4.164.0  ', '4.164.0')).toBe(true)
  })

  it('대소문자만 다른 경우', () => {
    expect(isSameVersion('2.8.2-HOTFIX', '2.8.2-hotfix')).toBe(true)
  })
})

describe('isSameVersion — 추측 매칭 금지', () => {
  // 여기가 이 함수의 핵심이다. 잘못 연결된 릴리스 노트는 사용자가 알아채기 어렵다.
  it('자릿수가 다르면 다르다 (4.164.0 ≠ 4.164)', () => {
    expect(isSameVersion('4.164.0', '4.164')).toBe(false)
    expect(isSameVersion('4.164', '4.164.0')).toBe(false)
  })

  it('패치 번호가 다르면 다르다', () => {
    expect(isSameVersion('4.164.0', '4.164.1')).toBe(false)
  })

  it('마이너 번호가 다르면 다르다', () => {
    expect(isSameVersion('4.164.0', '4.163.0')).toBe(false)
  })

  it('접미사가 붙으면 다르다', () => {
    expect(isSameVersion('4.164.0', '4.164.0-rc1')).toBe(false)
    expect(isSameVersion('4.164.0', '4.164.0 (hotfix)')).toBe(false)
  })

  it('부분 문자열이어도 다르다', () => {
    expect(isSameVersion('2.8.2', '12.8.2')).toBe(false)
    expect(isSameVersion('2.8.2', '2.8.20')).toBe(false)
  })

  it('빈 값은 무엇과도 같지 않다 — 버전 없음끼리 묶이면 안 된다', () => {
    expect(isSameVersion('', '')).toBe(false)
    expect(isSameVersion('   ', '')).toBe(false)
    expect(isSameVersion('', '4.164.0')).toBe(false)
    expect(isSameVersion('4.164.0', '')).toBe(false)
  })
})

describe('splitDeployVersions — 한 칸에 여러 버전이 적힌 경우', () => {
  it('쉼표로 나눈다', () => {
    // 실제 데이터: 작가앱·구매자앱을 함께 배포한 프로젝트
    expect(splitDeployVersions('2.8.1 , 4.155.0')).toEqual(['2.8.1', '4.155.0'])
  })

  it('슬래시와 줄바꿈으로도 나눈다', () => {
    expect(splitDeployVersions('2.8.1/4.155.0')).toEqual(['2.8.1', '4.155.0'])
    expect(splitDeployVersions('2.8.1\n4.155.0')).toEqual(['2.8.1', '4.155.0'])
  })

  it('공백으로는 나누지 않는다 — 괄호 주석이 붙은 표기를 쪼개면 엉뚱한 릴리스에 걸린다', () => {
    expect(splitDeployVersions('4.164.0 (핫픽스)')).toEqual(['4.164.0 (핫픽스)'])
  })

  it('빈 값과 구분자만 있는 값은 빈 목록이다', () => {
    expect(splitDeployVersions(null)).toEqual([])
    expect(splitDeployVersions('')).toEqual([])
    expect(splitDeployVersions(' , , ')).toEqual([])
  })
})

describe('matchesDeployVersion', () => {
  it('여러 버전 중 하나만 맞아도 같은 릴리스로 본다', () => {
    expect(matchesDeployVersion('2.8.1 , 4.155.0', '4.155.0')).toBe(true)
    expect(matchesDeployVersion('2.8.1 , 4.155.0', '2.8.1')).toBe(true)
  })

  it('어느 것도 맞지 않으면 false', () => {
    expect(matchesDeployVersion('2.8.1 , 4.155.0', '4.164.0')).toBe(false)
  })

  it('배포 버전이 비어 있으면 어떤 릴리스와도 맞지 않는다', () => {
    expect(matchesDeployVersion(null, '4.164.0')).toBe(false)
    expect(matchesDeployVersion('   ', '4.164.0')).toBe(false)
  })
})

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
