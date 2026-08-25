import { describe, it, expect } from 'vitest'
import { compactionSummary, needsFullReanalysis } from './MeetingDetail'

// 무음 컷편집 배지의 표시 조건과 절감 비율을 고정한다.
// 비율의 분모를 현재 길이로 잘못 잡으면 "52분에서 12분 뺐다"가 24%가 아니라 31%로 부풀려진다.
describe('compactionSummary', () => {
  const M = 60_000

  it('원본 길이 기준으로 제거량과 비율을 낸다', () => {
    const r = compactionSummary({
      audio_compacted: 1,
      original_duration_ms: 52 * M + 34_000,
      duration_ms: 40 * M
    })
    expect(r).not.toBeNull()
    expect(r!.removedMs).toBe(12 * M + 34_000)
    expect(r!.pct).toBe(24)
    expect(r!.originalMs).toBe(52 * M + 34_000)
  })

  it('컷편집이 적용되지 않았으면 배지를 그리지 않는다', () => {
    expect(
      compactionSummary({ audio_compacted: 0, original_duration_ms: null, duration_ms: 40 * M })
    ).toBeNull()
    // 플래그만 서고 원본 길이가 없으면(옛 레코드) 계산 근거가 없다
    expect(
      compactionSummary({ audio_compacted: 1, original_duration_ms: null, duration_ms: 40 * M })
    ).toBeNull()
  })

  it('실제로 줄지 않았으면 배지를 그리지 않는다', () => {
    expect(
      compactionSummary({ audio_compacted: 1, original_duration_ms: 40 * M, duration_ms: 40 * M })
    ).toBeNull()
    // 원본보다 길어진 모순된 값도 0%/음수 배지를 만들지 않는다
    expect(
      compactionSummary({ audio_compacted: 1, original_duration_ms: 30 * M, duration_ms: 40 * M })
    ).toBeNull()
  })
})

// "요약 다시 생성"을 전체 재분석으로 승격할지 판정한다.
// 구 파이프라인 전사는 컷편집·용어집·참석자를 안 거쳤으므로 같은 입력을 다시 요약해봐야 결과가 같다.
describe('needsFullReanalysis', () => {
  it('현재 파이프라인 버전(2)에 못 미치는 회의는 재분석이 필요하다', () => {
    // 0 = 이 기능 이전에 처리됐거나 아직 처리되지 않은 회의
    expect(needsFullReanalysis({ pipeline_version: 0 })).toBe(true)
    expect(needsFullReanalysis({ pipeline_version: 1 })).toBe(true)
  })

  it('현재 버전으로 처리된 회의는 요약만 다시 만든다', () => {
    expect(needsFullReanalysis({ pipeline_version: 2 })).toBe(false)
  })

  it('앞선 버전으로 처리된 회의를 되돌려 재분석하지 않는다', () => {
    // main의 CURRENT_PIPELINE_VERSION이 먼저 올라간 빌드에서 처리된 회의를
    // 구버전 렌더러가 매번 전체 재처리로 끌고 가면 안 된다.
    expect(needsFullReanalysis({ pipeline_version: 3 })).toBe(false)
  })
})
