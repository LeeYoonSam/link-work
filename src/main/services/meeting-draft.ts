// recording:createDraft 입력을 meetings 행 값으로 정규화한다.
// electron·DB를 import하지 않아 단위 테스트에서 바로 부른다.
import { DEFAULT_MEETING_TITLE } from './meeting-templates'

export interface DraftInput {
  title?: string
  source?: string
  expected_speakers?: number | null
  compact_audio?: boolean
}

export interface DraftRow {
  title: string
  /** 1=시스템이 붙인 기본 제목(요약이 바꿀 수 있음), 0=사용자 제목 */
  title_auto: 0 | 1
  source: 'mic' | 'mic+system'
  expected_speakers: number | null
  compact_audio: 0 | 1
  speakers_confirmed: 0 | 1
}

export function buildDraftRow(input: DraftInput | undefined): DraftRow {
  const typed = typeof input?.title === 'string' ? input.title.trim() : ''
  const title = typed || DEFAULT_MEETING_TITLE
  const titleAuto: 0 | 1 = typed ? 0 : 1
  const source = input?.source === 'mic+system' ? 'mic+system' : 'mic'
  // 참석 인원(화자분리 클러스터 수). 유효한 수(≥1)면 반올림해 20 이하로, 아니면 자동 추정(null).
  // 상세 화면에서 언제든 바꿔 재분리할 수 있다.
  const raw = input?.expected_speakers
  const expectedSpeakers =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.min(20, Math.round(raw)) : null
  // 무음 컷편집은 기본 on. 명시적으로 false를 준 경우에만 끈다.
  const compactAudio: 0 | 1 = input?.compact_audio === false ? 0 : 1
  // 참석 인원을 직접 골랐으면 화자 구성을 확인한 것으로 본다.
  const speakersConfirmed: 0 | 1 = expectedSpeakers !== null ? 1 : 0
  return {
    title,
    title_auto: titleAuto,
    source,
    expected_speakers: expectedSpeakers,
    compact_audio: compactAudio,
    speakers_confirmed: speakersConfirmed
  }
}
