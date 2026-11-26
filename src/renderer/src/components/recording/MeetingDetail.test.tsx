import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Meeting, MeetingDetail } from '../../types'

// 상세 화면 렌더 테스트용 스토어 목. zustand v5는 서버 렌더에서 초기 상태를 돌려주므로
// setState 대신 훅 자체를 모킹한다(RecordingList.test와 같은 방식).
const state: { current: MeetingDetail | null } = { current: null }
const noop = async (): Promise<void> => {}
vi.mock('../../stores/recordingStore', () => ({
  useRecordingStore: () => ({
    current: state.current,
    processing: {},
    cancelling: {},
    renameMeeting: noop,
    removeMeeting: noop,
    reprocessMeeting: noop,
    summarizeMeeting: noop,
    setExpectedSpeakers: noop,
    setAttendees: noop,
    cancelProcessing: noop,
    refreshCurrent: noop,
    pendingSeek: null,
    consumePendingSeek: () => null
  })
}))
vi.mock('../../stores/recognitionAidsStore', () => ({
  useRecognitionAidsStore: () => ({ members: [], fetchAll: noop })
}))
vi.mock('./AudioPlayer', () => ({ default: () => null }))
vi.mock('./SpeakerTimeline', () => ({ default: () => null }))
vi.mock('./SummaryPanel', () => ({ default: () => null }))
vi.mock('./SpeakerEditor', () => ({ default: () => null }))

const {
  default: MeetingDetailView,
  canRediarize,
  compactionSummary,
  needsFullReanalysis,
  shouldRenameTitle
} = await import('./MeetingDetail')

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

// 화자 탭 "화자 다시 분리" 노출 조건 — 마이크 단독 녹음인데 목소리가 저장된 화자가 없을 때만.
describe('canRediarize', () => {
  const noVoice = [{ has_voice: false }, { has_voice: false }]

  it('마이크 녹음이고 목소리 있는 화자가 없으면 노출한다', () => {
    expect(canRediarize({ source: 'mic', status: 'summarized' }, noVoice)).toBe(true)
    expect(canRediarize({ source: 'mic', status: 'transcribed' }, [{ has_voice: false }])).toBe(true)
    // 분리에 실패해 화자가 하나도 없어도 노출한다
    expect(canRediarize({ source: 'mic', status: 'summarized' }, [])).toBe(true)
  })

  it('목소리가 저장된 화자가 하나라도 있으면 숨긴다', () => {
    expect(
      canRediarize({ source: 'mic', status: 'summarized' }, [{ has_voice: false }, { has_voice: true }])
    ).toBe(false)
  })

  it('채널 분리(mic+system) 녹음은 숨긴다', () => {
    expect(canRediarize({ source: 'mic+system', status: 'summarized' }, noVoice)).toBe(false)
  })

  it('녹음·처리 중이거나 실패한 회의는 숨긴다', () => {
    expect(canRediarize({ source: 'mic', status: 'recording' }, noVoice)).toBe(false)
    expect(canRediarize({ source: 'mic', status: 'processing' }, noVoice)).toBe(false)
    expect(canRediarize({ source: 'mic', status: 'failed' }, noVoice)).toBe(false)
  })
})

// F4 — 요약에서 만든 제목이면 '자동 제목' 배지를 단다. 사용자 제목(title_auto=0)에는 달지 않는다.
describe('MeetingDetailView 헤더', () => {
  const meeting = (over: Partial<Meeting>): Meeting => ({
    id: 5,
    title: '결제 모듈 배포 점검',
    title_auto: 1,
    status: 'summarized',
    audio_path: null,
    audio_mime: 'audio/wav',
    duration_ms: 60_000,
    language: 'ko',
    source: 'mic',
    expected_speakers: 3,
    compact_audio: 1,
    audio_compacted: 0,
    original_duration_ms: null,
    pipeline_version: 3,
    speakers_confirmed: 1,
    project_id: null,
    calendar_event_id: null,
    calendar_event_title: null,
    error: null,
    started_at: '2026-07-22 10:00:00',
    created_at: '2026-07-22 10:00:00',
    updated_at: '2026-07-22 10:00:00',
    ...over
  })
  const render = (m: Meeting): string => {
    state.current = { meeting: m, speakers: [], segments: [], cuts: [], summary: null, attendees: [] }
    return renderToStaticMarkup(<MeetingDetailView onClose={() => {}} />)
  }

  it('title_auto=1이고 요약이 끝났으면 자동 제목 배지를 그린다', () => {
    const html = render(meeting({ title_auto: 1, status: 'summarized' }))
    expect(html).toContain('자동 제목')
    expect(html).toContain('요약에서 만든 제목입니다')
  })

  it('사용자 제목(title_auto=0)이면 배지가 없다', () => {
    expect(render(meeting({ title_auto: 0 }))).not.toContain('자동 제목')
  })

  it('요약 전(기본 제목)에는 배지가 없다', () => {
    expect(render(meeting({ title_auto: 1, status: 'transcribed' }))).not.toContain('자동 제목')
  })

  it('요약이 끝났어도 제목이 기본 제목이거나 비어 있으면 배지가 없다', () => {
    expect(render(meeting({ title: '제목 없는 회의' }))).not.toContain('자동 제목')
    expect(render(meeting({ title: '  ' }))).not.toContain('자동 제목')
  })

  it('요약 탭 라벨은 요약이다', () => {
    const html = render(meeting({}))
    expect(html).toContain('>요약<')
  })
})

// F4 — 자동 제목을 그대로 저장해도 사용자 제목으로 굳혀야 다음 요약이 덮지 않는다.
describe('shouldRenameTitle', () => {
  it('자동 제목은 바꾸지 않고 저장해도 rename한다', () => {
    expect(shouldRenameTitle({ title: '결제 모듈 배포 점검', title_auto: 1 }, '결제 모듈 배포 점검')).toBe(true)
  })
  it('사용자 제목을 그대로 저장하면 rename하지 않는다', () => {
    expect(shouldRenameTitle({ title: '결제 모듈 배포 점검', title_auto: 0 }, ' 결제 모듈 배포 점검 ')).toBe(false)
  })
  it('바꾼 제목은 rename하고, 빈 값은 하지 않는다', () => {
    expect(shouldRenameTitle({ title: 'A', title_auto: 0 }, 'B')).toBe(true)
    expect(shouldRenameTitle({ title: 'A', title_auto: 1 }, '   ')).toBe(false)
  })
})
