import { useEffect, useState } from 'react'
import { formatElapsed, useRecorderStore } from '../../stores/recorderStore'
import { useRecordingStore } from '../../stores/recordingStore'
import { useRecognitionAidsStore } from '../../stores/recognitionAidsStore'
import type { MeetingKind, MeetingSource } from '../../types'
import { button } from '../ui'

interface Props {
  onDone: () => void
}

const KIND_LABEL: Record<MeetingKind, string> = {
  meeting: '회의',
  interview: '면접'
}

export default function RecorderControls({ onDone }: Props): React.ReactNode {
  const { createDraft, saveAndProcess } = useRecordingStore()
  // 녹음 상태는 화면(View) 언마운트에도 유지되도록 전역 스토어에 있다.
  // 다른 메뉴로 이동해도 녹음은 계속되고, 돌아오면 이 컴포넌트가 이어서 표시한다.
  const {
    state,
    elapsedMs,
    level,
    error,
    draftId,
    saving,
    saveError,
    start,
    pause,
    resume,
    stop,
    reset,
    setSaving,
    setSaveError
  } = useRecorderStore()

  const { members, fetchAll } = useRecognitionAidsStore()

  const [source, setSource] = useState<MeetingSource>('mic')
  const [kind, setKind] = useState<MeetingKind>('meeting')
  // 참석 인원(화자분리 클러스터 수). 빈 값이면 자동 추정. 면접 기본 2, 회의 기본 자동.
  const [speakerCount, setSpeakerCount] = useState('')
  // 참석 인원 입력에 우리가 마지막으로 자동으로 넣은 값.
  // 사용자가 직접 고쳐 넣은 숫자는 참석자를 더 골라도 덮지 않기 위해 구분한다.
  const [autoFilledCount, setAutoFilledCount] = useState('')
  // 참석자로 지정할 구성원 id
  const [attendeeIds, setAttendeeIds] = useState<number[]>([])
  // 처리 전 긴 침묵을 잘라낼지. 기본 on — 전사·화자분리 시간이 눈에 띄게 줄어든다.
  const [compactAudio, setCompactAudio] = useState(true)
  // 면접 녹음은 지원자 동의가 전제다. 고지를 확인해야만 시작 버튼이 활성화된다.
  const [consent, setConsent] = useState(false)

  // 참석자 칩에 쓸 구성원 목록. 인식 보조 패널에서 방금 추가했을 수도 있으니 열 때마다 읽는다.
  useEffect(() => {
    void fetchAll()
  }, [])

  const enabledMembers = members.filter((m) => m.enabled === 1)

  // 레벨 미터 바 개수
  const BAR_COUNT = 20
  const activeBars = Math.round(level * BAR_COUNT)

  const isInterview = kind === 'interview'

  // 종류를 바꾸면 참석 인원 기본값도 리셋한다(면접=2, 회의=자동).
  // 이 기본값도 "우리가 넣은 값"이므로, 뒤이어 참석자를 고르면 그 수로 덮인다.
  const handleKindChange = (k: MeetingKind): void => {
    setKind(k)
    const preset = k === 'interview' ? '2' : ''
    setSpeakerCount(preset)
    setAutoFilledCount(preset)
  }

  // 참석자를 고르면 참석 인원을 그 수로 제안한다.
  // 단 사용자가 직접 입력한 숫자(= 우리가 넣은 값과 다른 숫자)는 건드리지 않는다.
  const toggleAttendee = (memberId: number): void => {
    const next = attendeeIds.includes(memberId)
      ? attendeeIds.filter((id) => id !== memberId)
      : [...attendeeIds, memberId]
    setAttendeeIds(next)

    const untouched = speakerCount.trim() === '' || speakerCount === autoFilledCount
    if (!untouched) return
    // 참석자를 모두 해제하면 종류별 기본값으로 되돌린다(면접=2, 회의=자동).
    const fallback = kind === 'interview' ? '2' : ''
    const suggested = next.length > 0 ? String(next.length) : fallback
    setSpeakerCount(suggested)
    setAutoFilledCount(suggested)
  }

  const handleStart = async (): Promise<void> => {
    setSaveError(null)
    try {
      const parsed = speakerCount.trim() === '' ? NaN : parseInt(speakerCount, 10)
      const expected_speakers = Number.isNaN(parsed) ? null : parsed
      const id = await createDraft({
        source,
        kind,
        expected_speakers,
        attendee_ids: attendeeIds,
        compact_audio: compactAudio
      })
      await start({ source, draftId: id })
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : '녹음 시작 실패')
    }
  }

  const handleStop = async (): Promise<void> => {
    if (draftId == null) return
    setSaving(true)
    setSaveError(null)
    try {
      const { blob, durationMs, mime } = await stop()
      await saveAndProcess(draftId, blob, durationMs, mime)
      reset()
      onDone()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : '저장 실패')
      setSaving(false)
    }
  }

  const handleCancel = (): void => {
    reset()
    onDone()
  }

  const isIdle = state === 'idle'
  const isRecording = state === 'recording'
  const isPaused = state === 'paused'
  const isStopped = state === 'stopped'

  return (
    <div className="px-4 py-3 space-y-3">
      {/* 종류 · 소스 선택 (idle 상태에서만) */}
      {isIdle && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {/* 녹음 종류 — 요약 형식과 상세 화면이 이 값으로 갈린다 */}
            <div className="flex bg-gray-100 rounded-md p-0.5 w-fit">
              {(['meeting', 'interview'] as MeetingKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => handleKindChange(k)}
                  className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                    kind === k
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>

            <span className="text-gray-200">|</span>

            <div className="flex bg-gray-100 rounded-md p-0.5 w-fit">
              {(['mic', 'mic+system'] as MeetingSource[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSource(s)}
                  className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                    source === s
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {s === 'mic' ? '마이크' : '마이크 + 시스템'}
                </button>
              ))}
            </div>
          </div>

          {/* 참석자 — 전사 힌트·화자 이름 프리셋·요약 담당자 매칭에 함께 쓰인다 */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-gray-500 shrink-0">참석자</span>
            {enabledMembers.length === 0 ? (
              <span className="text-[10px] text-gray-400">
                구성원을 등록하면 참석자를 고를 수 있습니다
              </span>
            ) : (
              enabledMembers.map((m) => {
                const selected = attendeeIds.includes(m.id)
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggleAttendee(m.id)}
                    title={m.role ? `${m.name} · ${m.role}` : m.name}
                    className={`px-2 py-0.5 text-[11px] rounded-full border transition-colors ${
                      selected
                        ? 'bg-blue-50 border-blue-200 text-blue-600 font-medium'
                        : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {m.name}
                  </button>
                )
              })
            )}
          </div>

          {/* 참석 인원 — 화자분리 클러스터 수. 비우면 자동 추정 (MeetingDetail 재분리 입력과 동일 규약) */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">참석 인원</span>
            <input
              type="number"
              min={1}
              max={20}
              value={speakerCount}
              onChange={(e) => setSpeakerCount(e.target.value)}
              placeholder="자동"
              title="참석 인원을 지정하면 그 수만큼 화자를 분리합니다 (비우면 자동 추정)"
              className="w-14 text-xs px-1.5 py-1 border border-gray-200 rounded text-center focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            <span className="text-[11px] text-gray-400">명</span>
            <span className="text-[10px] text-gray-400">비우면 자동 추정</span>
          </div>

          {/* 무음 컷편집 — 처리 전에 긴 침묵을 잘라 전사·화자분리 입력을 줄인다 */}
          <label className="flex items-center gap-1.5 cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={compactAudio}
              onChange={(e) => setCompactAudio(e.target.checked)}
              className="accent-blue-600"
            />
            <span className="text-xs text-gray-500">무음 구간 자동 제거</span>
            <span className="text-[10px] text-gray-400">
              긴 침묵을 잘라 전사·화자 분리를 빠르게 (녹음 파일이 그만큼 짧아집니다)
            </span>
          </label>

          {/* 면접: 동의 고지 (개인정보보호법상 사전 동의 필요) */}
          {isInterview && (
            <label className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md cursor-pointer">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 accent-amber-600"
              />
              <span className="text-[11px] text-amber-800 leading-relaxed">
                지원자에게 녹음 사실과 목적을 알리고 동의를 받았습니다.
                <span className="block text-amber-600">
                  기록은 답변 확인용이며, AI 요약은 합격 판정 근거로 사용하지 않습니다.
                </span>
              </span>
            </label>
          )}
        </div>
      )}

      {/* 경과 시간 + 레벨 미터 (녹음/일시정지 중) */}
      {(isRecording || isPaused) && (
        <div className="flex items-center gap-3">
          {/* 시간 */}
          <span className="font-mono text-sm font-semibold text-gray-800 tabular-nums w-14">
            {formatElapsed(elapsedMs)}
          </span>

          {/* 레벨 미터 */}
          <div className="flex items-end gap-px h-4" aria-label="입력 레벨">
            {Array.from({ length: BAR_COUNT }).map((_, i) => (
              <div
                key={i}
                className={`w-1 rounded-sm transition-all duration-75 ${
                  i < activeBars
                    ? isPaused
                      ? 'bg-gray-400'
                      : i < BAR_COUNT * 0.6
                        ? 'bg-green-500'
                        : i < BAR_COUNT * 0.85
                          ? 'bg-yellow-400'
                          : 'bg-red-500'
                    : 'bg-gray-200'
                }`}
                style={{ height: `${Math.max(20, ((i + 1) / BAR_COUNT) * 100)}%` }}
              />
            ))}
          </div>

          {/* 상태 표시 */}
          {isPaused ? (
            <span className="text-[11px] text-gray-400 font-medium">일시정지됨</span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-red-500 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              녹음 중
            </span>
          )}
        </div>
      )}

      {/* 컨트롤 버튼 */}
      <div className="flex items-center gap-2">
        {isIdle && (
          <button
            type="button"
            onClick={handleStart}
            disabled={isInterview && !consent}
            title={isInterview && !consent ? '동의 확인 후 시작할 수 있습니다' : undefined}
            className={`px-3 py-1.5 text-xs font-medium ${button.primary} flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <RecordIcon />
            {isInterview ? '면접 녹음 시작' : '녹음 시작'}
          </button>
        )}

        {isRecording && (
          <>
            <button
              type="button"
              onClick={pause}
              className={`px-3 py-1.5 text-xs font-medium ${button.subtle}`}
            >
              일시정지
            </button>
            <button
              type="button"
              onClick={handleStop}
              disabled={saving}
              className={`px-3 py-1.5 text-xs font-medium ${button.dark} disabled:opacity-50`}
            >
              {saving ? '저장 중...' : '종료 및 저장'}
            </button>
          </>
        )}

        {isPaused && (
          <>
            <button
              type="button"
              onClick={resume}
              className={`px-3 py-1.5 text-xs font-medium ${button.primary}`}
            >
              재개
            </button>
            <button
              type="button"
              onClick={handleStop}
              disabled={saving}
              className={`px-3 py-1.5 text-xs font-medium ${button.dark} disabled:opacity-50`}
            >
              {saving ? '저장 중...' : '종료 및 저장'}
            </button>
          </>
        )}

        {isStopped && (
          <span className="text-xs text-gray-500">저장 완료</span>
        )}

        {!isIdle && (
          <button
            type="button"
            onClick={handleCancel}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            취소
          </button>
        )}

        {isIdle && (
          <button
            type="button"
            onClick={handleCancel}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            닫기
          </button>
        )}
      </div>

      {/* 오류 표시 */}
      {(error ?? saveError) && (
        <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-md">
          {error ?? saveError}
        </p>
      )}
    </div>
  )
}

function RecordIcon(): React.ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="10" />
    </svg>
  )
}
