import { useState, useRef, useCallback, useEffect } from 'react'

export type RecorderState = 'idle' | 'recording' | 'paused' | 'stopped'

export interface UseRecorder {
  state: RecorderState
  elapsedMs: number
  level: number
  error: string | null
  start: (opts: { source: 'mic' | 'mic+system' }) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => Promise<{ blob: Blob; durationMs: number; mime: string }>
  reset: () => void
}

const PREFERRED_MIME = 'audio/webm;codecs=opus'
const FALLBACK_MIME = 'audio/webm'

function getSupportedMime(): string {
  if (MediaRecorder.isTypeSupported(PREFERRED_MIME)) return PREFERRED_MIME
  if (MediaRecorder.isTypeSupported(FALLBACK_MIME)) return FALLBACK_MIME
  return ''
}

export function useRecorder(): UseRecorder {
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // 미디어 자원 refs
  const micStreamRef = useRef<MediaStream | null>(null)
  const systemStreamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mimeRef = useRef<string>('')

  // 타이머 refs
  const startTimeRef = useRef<number>(0)   // 현재 구간 시작 타임스탬프
  const accumulatedRef = useRef<number>(0) // 이전 구간까지 누적 ms
  const timerIdRef = useRef<number | null>(null)

  // 애니메이션 루프 ref
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafIdRef = useRef<number | null>(null)

  // stop 시 resolve 를 저장하는 ref
  const stopResolveRef = useRef<((result: { blob: Blob; durationMs: number; mime: string }) => void) | null>(null)

  // 레벨미터 루프
  const startLevelLoop = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return

    const buf = new Float32Array(analyser.fftSize)

    const loop = (): void => {
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        sum += buf[i] * buf[i]
      }
      const rms = Math.sqrt(sum / buf.length)
      setLevel(Math.min(1, rms * 5)) // 0..1 스케일링
      rafIdRef.current = requestAnimationFrame(loop)
    }
    rafIdRef.current = requestAnimationFrame(loop)
  }, [])

  const stopLevelLoop = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    setLevel(0)
  }, [])

  // 타이머: 100ms 마다 elapsedMs 갱신
  const startTimer = useCallback(() => {
    startTimeRef.current = performance.now()
    timerIdRef.current = window.setInterval(() => {
      const elapsed = accumulatedRef.current + (performance.now() - startTimeRef.current)
      setElapsedMs(Math.round(elapsed))
    }, 100)
  }, [])

  const stopTimer = useCallback(() => {
    if (timerIdRef.current !== null) {
      clearInterval(timerIdRef.current)
      timerIdRef.current = null
    }
  }, [])

  // 모든 트랙과 AudioContext 정리
  const cleanup = useCallback(async () => {
    stopLevelLoop()
    stopTimer()

    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    systemStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
    systemStreamRef.current = null

    if (audioCtxRef.current) {
      try {
        await audioCtxRef.current.close()
      } catch {
        // 이미 닫혀있을 수 있음 — 무시
      }
      audioCtxRef.current = null
    }

    analyserRef.current = null
    mediaRecorderRef.current = null
    chunksRef.current = []
    accumulatedRef.current = 0
    startTimeRef.current = 0
  }, [stopLevelLoop, stopTimer])

  const start = useCallback(async (opts: { source: 'mic' | 'mic+system' }) => {
    setError(null)

    try {
      // 1) 마이크 스트림 획득
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1
        }
      })
      micStreamRef.current = micStream

      // 2) 시스템 오디오 획득 시도 (mic+system 요청 시)
      let sysStream: MediaStream | null = null
      if (opts.source === 'mic+system') {
        try {
          const displayStream = await navigator.mediaDevices.getDisplayMedia({
            audio: true,
            video: true
          })
          // 오디오 트랙만 분리; 비디오 트랙은 즉시 정지
          displayStream.getVideoTracks().forEach((t) => t.stop())
          const audioTracks = displayStream.getAudioTracks()
          if (audioTracks.length > 0) {
            sysStream = new MediaStream(audioTracks)
          } else {
            // 오디오 권한이 없는 경우
            setError('시스템 오디오를 가져올 수 없어 마이크만 녹음합니다.')
          }
        } catch {
          // 사용자 취소 또는 미지원
          setError('시스템 오디오 캡처를 사용할 수 없어 마이크만 녹음합니다.')
        }
      }
      systemStreamRef.current = sysStream

      // 3) Web Audio 믹싱: mic=L / system=R 스테레오 분리
      const ctx = new AudioContext()
      audioCtxRef.current = ctx

      const merger = ctx.createChannelMerger(2)

      // 마이크 소스 → 채널 0 (L)
      const micSource = ctx.createMediaStreamSource(micStream)

      // 레벨미터용 AnalyserNode (마이크 신호 기준)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyserRef.current = analyser
      micSource.connect(analyser)
      micSource.connect(merger, 0, 0)

      // 시스템 오디오 소스 → 채널 1 (R)
      if (sysStream) {
        const sysSource = ctx.createMediaStreamSource(sysStream)
        sysSource.connect(merger, 0, 1)
      } else {
        // 시스템 없으면 mic 을 R 에도 연결(모노 폴백)
        micSource.connect(merger, 0, 1)
      }

      const dest = ctx.createMediaStreamDestination()
      merger.connect(dest)

      // 4) MediaRecorder 설정
      const mime = getSupportedMime()
      mimeRef.current = mime
      const recorderOpts: MediaRecorderOptions = mime ? { mimeType: mime } : {}
      const recorder = new MediaRecorder(dest.stream, recorderOpts)
      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data)
        }
      }

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeRef.current || 'audio/webm' })
        const durationMs = accumulatedRef.current
        stopResolveRef.current?.({ blob, durationMs, mime: mimeRef.current || 'audio/webm' })
        stopResolveRef.current = null
      }

      recorder.start(100) // 100ms 청크

      // 5) 타이머 + 레벨루프 시작
      accumulatedRef.current = 0
      startTimer()
      startLevelLoop()

      setState('recording')
    } catch (err) {
      await cleanup()
      const msg = err instanceof Error ? err.message : String(err)
      setError(`녹음을 시작할 수 없습니다: ${msg}`)
      setState('idle')
    }
  }, [startTimer, startLevelLoop, cleanup])

  const pause = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state !== 'recording') return

    recorder.pause()
    // 누적 시간 저장
    accumulatedRef.current += performance.now() - startTimeRef.current
    stopTimer()
    stopLevelLoop()
    setState('paused')
  }, [stopTimer, stopLevelLoop])

  const resume = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state !== 'paused') return

    recorder.resume()
    startTimer()
    startLevelLoop()
    setState('recording')
  }, [startTimer, startLevelLoop])

  const stop = useCallback((): Promise<{ blob: Blob; durationMs: number; mime: string }> => {
    return new Promise((resolve, reject) => {
      const recorder = mediaRecorderRef.current
      if (!recorder) {
        reject(new Error('MediaRecorder가 초기화되지 않았습니다.'))
        return
      }

      // 마지막 구간 누적
      if (recorder.state === 'recording') {
        accumulatedRef.current += performance.now() - startTimeRef.current
      }
      stopTimer()
      stopLevelLoop()

      stopResolveRef.current = (result) => {
        // 트랙 정리 (AudioContext는 cleanup에서)
        micStreamRef.current?.getTracks().forEach((t) => t.stop())
        systemStreamRef.current?.getTracks().forEach((t) => t.stop())
        micStreamRef.current = null
        systemStreamRef.current = null

        if (audioCtxRef.current) {
          audioCtxRef.current.close().catch(() => {})
          audioCtxRef.current = null
        }
        analyserRef.current = null

        setState('stopped')
        resolve(result)
      }

      try {
        recorder.stop()
      } catch (err) {
        stopResolveRef.current = null
        reject(err)
      }
    })
  }, [stopTimer, stopLevelLoop])

  const reset = useCallback(() => {
    cleanup()
    setElapsedMs(0)
    setLevel(0)
    setError(null)
    setState('idle')
  }, [cleanup])

  // 언마운트 시 자원 정리
  useEffect(() => {
    return () => {
      stopLevelLoop()
      stopTimer()
      micStreamRef.current?.getTracks().forEach((t) => t.stop())
      systemStreamRef.current?.getTracks().forEach((t) => t.stop())
      audioCtxRef.current?.close().catch(() => {})
    }
  }, [stopLevelLoop, stopTimer])

  return { state, elapsedMs, level, error, start, pause, resume, stop, reset }
}
