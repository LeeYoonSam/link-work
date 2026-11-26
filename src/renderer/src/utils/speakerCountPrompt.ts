import type { Meeting } from '../types'

// 상세 화면 "참석 인원 확인" 배너 노출 조건(#8).
// 회의(면접 아님)이고, 사용자가 화자 구성을 아직 확인하지 않았고(speakers_confirmed=0),
// 참석 인원을 지정하지 않았고, 전사가 끝나 발언이 있을 때만 자동으로 나눈 화자 수를 돌려준다.
// speakers_confirmed가 없으면(옛 main) 확인된 것으로 본다.
export function speakerCountPrompt(
  meeting: Pick<Meeting, 'kind' | 'status' | 'expected_speakers'> & { speakers_confirmed?: number },
  speakers: Array<{ id: number }>,
  segments: Array<{ speaker_id: number | null }>
): { detected: number } | null {
  if (meeting.kind !== 'meeting') return null
  if (meeting.speakers_confirmed !== 0) return null
  if (meeting.expected_speakers != null) return null
  if (meeting.status !== 'transcribed' && meeting.status !== 'summarized') return null
  if (segments.length === 0) return null
  const used = new Set<number>()
  for (const seg of segments) if (seg.speaker_id != null) used.add(seg.speaker_id)
  const detected = speakers.filter((s) => used.has(s.id)).length
  return { detected: Math.max(1, detected) }
}
