import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import type { MeetingCut } from '../../types'

export interface AudioPlayerHandle {
  seekTo: (ms: number) => void
}

interface Props {
  audioPath: string | null
  cuts: MeetingCut[]
  // MediaRecorder webm/opus는 duration 메타데이터가 없어 audio.duration이 Infinity가 된다.
  // 녹음 시 저장한 정확한 길이를 fallback으로 사용한다.
  durationMs?: number
}

function formatTime(sec: number): string {
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// 활성(enabled) 컷 구간인지 판별
function isInEnabledCut(timeSec: number, cuts: MeetingCut[]): boolean {
  const ms = timeSec * 1000
  return cuts.some((c) => c.enabled === 1 && ms >= c.start_ms && ms < c.end_ms)
}

// enabled 컷 이후의 다음 안전 위치(ms)를 찾는다
function skipCuts(timeSec: number, cuts: MeetingCut[]): number {
  const enabledCuts = cuts.filter((c) => c.enabled === 1).sort((a, b) => a.start_ms - b.start_ms)
  let ms = timeSec * 1000
  let changed = true
  while (changed) {
    changed = false
    for (const cut of enabledCuts) {
      if (ms >= cut.start_ms && ms < cut.end_ms) {
        ms = cut.end_ms
        changed = true
        break
      }
    }
  }
  return ms / 1000
}

const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(function AudioPlayer(
  { audioPath, cuts, durationMs },
  ref
) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loadError, setLoadError] = useState(false)

  // 외부에서 seekTo 호출 가능하게 노출
  useImperativeHandle(ref, () => ({
    seekTo(ms: number) {
      const audio = audioRef.current
      if (!audio) return
      const targetSec = skipCuts(ms / 1000, cuts)
      audio.currentTime = targetSec
      setCurrentTime(targetSec)
      if (audio.paused) {
        audio.play().catch(() => setLoadError(true))
        setPlaying(true)
      }
    }
  }))

  // src 결정: 메인에 등록된 커스텀 프로토콜로 userData/recordings/<파일명> 스트리밍
  const src = audioPath ? `linkwork-media://audio/${encodeURIComponent(audioPath)}` : null

  useEffect(() => {
    setLoadError(false)
    setCurrentTime(0)
    setDuration(0)
    setPlaying(false)
  }, [audioPath])

  const handleTimeUpdate = (): void => {
    const audio = audioRef.current
    if (!audio) return
    const t = audio.currentTime
    // 컷 구간 스킵
    if (isInEnabledCut(t, cuts)) {
      const next = skipCuts(t, cuts)
      audio.currentTime = next
      return
    }
    setCurrentTime(t)
  }

  const handleLoadedMetadata = (): void => {
    if (audioRef.current) {
      const d = audioRef.current.duration
      setDuration(Number.isFinite(d) ? d : 0)
    }
  }

  const handleEnded = (): void => setPlaying(false)

  const handleError = (): void => {
    setLoadError(true)
    setPlaying(false)
  }

  const togglePlay = (): void => {
    const audio = audioRef.current
    if (!audio || loadError) return
    if (audio.paused) {
      audio.play().catch(() => setLoadError(true))
      setPlaying(true)
    } else {
      audio.pause()
      setPlaying(false)
    }
  }

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const audio = audioRef.current
    if (!audio) return
    const t = Number(e.target.value)
    const safe = skipCuts(t, cuts)
    audio.currentTime = safe
    setCurrentTime(safe)
  }

  // webm duration이 없으면(0) 저장된 durationMs를 사용
  const effectiveDuration =
    duration > 0 ? duration : durationMs && durationMs > 0 ? durationMs / 1000 : 0
  const progress = effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0

  if (!src) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg text-xs text-gray-400">
        <AudioOffIcon />
        오디오 경로 없음
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg text-xs text-gray-400">
        <AudioOffIcon />
        오디오 미리듣기 준비 중 — 처리 완료 후 이용 가능합니다
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-gray-50 rounded-lg">
      {/* 오디오 엘리먼트 (숨김) */}
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        onError={handleError}
        preload="metadata"
      />

      {/* 재생/정지 버튼 */}
      <button
        type="button"
        onClick={togglePlay}
        className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-800 text-white hover:bg-gray-700 transition-colors shrink-0"
        aria-label={playing ? '일시정지' : '재생'}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      {/* 시간 표시 */}
      <span className="text-[11px] font-mono text-gray-500 shrink-0 tabular-nums w-14">
        {formatTime(currentTime)}
      </span>

      {/* 시크 바 */}
      <div className="flex-1 relative h-1 bg-gray-200 rounded-full">
        {/* 재생 진행 */}
        <div
          className="absolute inset-y-0 left-0 bg-gray-700 rounded-full pointer-events-none"
          style={{ width: `${progress}%` }}
        />
        {/* 컷 구간 표시 */}
        {cuts
          .filter((c) => c.enabled === 1 && effectiveDuration > 0)
          .map((c) => {
            const left = (c.start_ms / 1000 / effectiveDuration) * 100
            const width = ((c.end_ms - c.start_ms) / 1000 / effectiveDuration) * 100
            return (
              <div
                key={c.id}
                className="absolute inset-y-0 bg-orange-300/60 pointer-events-none"
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`컷: ${c.type}${c.note ? ` (${c.note})` : ''}`}
              />
            )
          })}
        <input
          type="range"
          min={0}
          max={effectiveDuration || 1}
          step={0.1}
          value={currentTime}
          onChange={handleSeek}
          className="absolute inset-0 w-full opacity-0 cursor-pointer h-4 -top-1.5"
          aria-label="재생 위치"
        />
      </div>

      {/* 총 길이 */}
      <span className="text-[11px] font-mono text-gray-400 shrink-0 tabular-nums w-14 text-right">
        {formatTime(effectiveDuration)}
      </span>
    </div>
  )
})

export default AudioPlayer

function PlayIcon(): React.ReactNode {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  )
}

function PauseIcon(): React.ReactNode {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  )
}

function AudioOffIcon(): React.ReactNode {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.54 8.46a5 5 0 0 1 1.46 5" />
    </svg>
  )
}
