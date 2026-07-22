import { useState } from 'react'
import { formatElapsed, useRecorderStore } from '../../stores/recorderStore'
import { useRecordingStore } from '../../stores/recordingStore'
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

  const [source, setSource] = useState<MeetingSource>('mic')
  const [kind, setKind] = useState<MeetingKind>('meeting')
  // 면접 녹음은 지원자 동의가 전제다. 고지를 확인해야만 시작 버튼이 활성화된다.
  const [consent, setConsent] = useState(false)

  // 레벨 미터 바 개수
  const BAR_COUNT = 20
  const activeBars = Math.round(level * BAR_COUNT)

  const isInterview = kind === 'interview'

  const handleStart = async (): Promise<void> => {
    setSaveError(null)
    try {
      const id = await createDraft({ source, kind })
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
                  onClick={() => setKind(k)}
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
