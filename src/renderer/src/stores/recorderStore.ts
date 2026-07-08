import { create } from 'zustand'

export type RecorderState = 'idle' | 'recording' | 'paused' | 'stopped'

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

interface RecorderStore {
  state: RecorderState
  elapsedMs: number
  level: number
  error: string | null
  // 녹음 시작 시 만든 draft 회의 id — 종료 시 saveAndProcess 대상
  draftId: number | null
  saving: boolean
  saveError: string | null

  start: (opts: { source: 'mic' | 'mic+system'; draftId: number }) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => Promise<{ blob: Blob; durationMs: number; mime: string }>
  reset: () => void
  setSaving: (saving: boolean) => void
  setSaveError: (msg: string | null) => void
}

const PREFERRED_MIME = 'audio/webm;codecs=opus'
const FALLBACK_MIME = 'audio/webm'

function getSupportedMime(): string {
  if (MediaRecorder.isTypeSupported(PREFERRED_MIME)) return PREFERRED_MIME
  if (MediaRecorder.isTypeSupported(FALLBACK_MIME)) return FALLBACK_MIME
  return ''
}

// 미디어 자원은 React 트리 밖(모듈 레벨)에 둔다.
// 화면(View)이 언마운트되어도 녹음이 끊기지 않아야 하기 때문 —
// 정지 버튼을 누르기 전까지는 어떤 메뉴로 이동해도 녹음이 유지된다.
let micStream: MediaStream | null = null
let systemStream: MediaStream | null = null
let audioCtx: AudioContext | null = null
let mediaRecorder: MediaRecorder | null = null
let chunks: Blob[] = []
let currentMime = ''

let startTime = 0 // 현재 구간 시작 타임스탬프
let accumulated = 0 // 이전 구간까지 누적 ms
let timerId: number | null = null

let analyser: AnalyserNode | null = null
let rafId: number | null = null

let stopResolve: ((result: { blob: Blob; durationMs: number; mime: string }) => void) | null = null

export const useRecorderStore = create<RecorderStore>((set) => {
  const startLevelLoop = (): void => {
    if (!analyser) return
    const buf = new Float32Array(analyser.fftSize)

    const loop = (): void => {
      if (!analyser) return
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        sum += buf[i] * buf[i]
      }
      const rms = Math.sqrt(sum / buf.length)
      set({ level: Math.min(1, rms * 5) }) // 0..1 스케일링
      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)
  }

  const stopLevelLoop = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    set({ level: 0 })
  }

  // 타이머: 100ms 마다 elapsedMs 갱신
  const startTimer = (): void => {
    startTime = performance.now()
    timerId = window.setInterval(() => {
      set({ elapsedMs: Math.round(accumulated + (performance.now() - startTime)) })
    }, 100)
  }

  const stopTimer = (): void => {
    if (timerId !== null) {
      clearInterval(timerId)
      timerId = null
    }
  }

  // 모든 트랙과 AudioContext 정리
  const cleanup = async (): Promise<void> => {
    stopLevelLoop()
    stopTimer()

    micStream?.getTracks().forEach((t) => t.stop())
    systemStream?.getTracks().forEach((t) => t.stop())
    micStream = null
    systemStream = null

    if (audioCtx) {
      try {
        await audioCtx.close()
      } catch {
        // 이미 닫혀있을 수 있음 — 무시
      }
      audioCtx = null
    }

    analyser = null
    mediaRecorder = null
    chunks = []
    accumulated = 0
    startTime = 0
  }

  return {
    state: 'idle',
    elapsedMs: 0,
    level: 0,
    error: null,
    draftId: null,
    saving: false,
    saveError: null,

    start: async (opts) => {
      set({ error: null, draftId: opts.draftId })

      try {
        // 1) 마이크 스트림 획득
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1
          }
        })
        micStream = mic

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
              set({ error: '시스템 오디오를 가져올 수 없어 마이크만 녹음합니다.' })
            }
          } catch {
            // 사용자 취소 또는 미지원
            set({ error: '시스템 오디오 캡처를 사용할 수 없어 마이크만 녹음합니다.' })
          }
        }
        systemStream = sysStream

        // 3) Web Audio 믹싱
        const ctx = new AudioContext()
        audioCtx = ctx

        // 마이크 소스
        const micSource = ctx.createMediaStreamSource(mic)

        // 레벨미터용 AnalyserNode (마이크 신호 기준)
        const analyserNode = ctx.createAnalyser()
        analyserNode.fftSize = 1024
        analyser = analyserNode
        micSource.connect(analyserNode)

        const dest = ctx.createMediaStreamDestination()

        if (sysStream) {
          // mic=L / system=R 스테레오 분리 → 채널 기반 화자분리('나'/'상대')에 사용
          const merger = ctx.createChannelMerger(2)
          micSource.connect(merger, 0, 0)
          const sysSource = ctx.createMediaStreamSource(sysStream)
          sysSource.connect(merger, 0, 1)
          merger.connect(dest)
        } else {
          // 시스템 오디오가 없으면 mono로 녹음한다. (과거엔 mic을 양 채널에 복제해
          // '2채널인 척'했지만 L≈R이라 채널 분리가 무의미했고 화자 1명으로 붕괴했다.)
          // mono 저장 시 채널 에너지가 없어 main에서 source를 'mic'으로 강등하고,
          // sherpa 임베딩 기반 다화자 분리로 처리한다.
          micSource.connect(dest)
        }

        // 4) MediaRecorder 설정
        const mime = getSupportedMime()
        currentMime = mime
        const recorderOpts: MediaRecorderOptions = mime ? { mimeType: mime } : {}
        const recorder = new MediaRecorder(dest.stream, recorderOpts)
        mediaRecorder = recorder
        chunks = []

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            chunks.push(e.data)
          }
        }

        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: currentMime || 'audio/webm' })
          const durationMs = accumulated
          stopResolve?.({ blob, durationMs, mime: currentMime || 'audio/webm' })
          stopResolve = null
        }

        recorder.start(100) // 100ms 청크

        // 5) 타이머 + 레벨루프 시작
        accumulated = 0
        startTimer()
        startLevelLoop()

        set({ state: 'recording' })
      } catch (err) {
        await cleanup()
        const msg = err instanceof Error ? err.message : String(err)
        set({ error: `녹음을 시작할 수 없습니다: ${msg}`, state: 'idle', draftId: null })
      }
    },

    pause: () => {
      if (!mediaRecorder || mediaRecorder.state !== 'recording') return

      mediaRecorder.pause()
      // 누적 시간 저장
      accumulated += performance.now() - startTime
      stopTimer()
      stopLevelLoop()
      set({ state: 'paused' })
    },

    resume: () => {
      if (!mediaRecorder || mediaRecorder.state !== 'paused') return

      mediaRecorder.resume()
      startTimer()
      startLevelLoop()
      set({ state: 'recording' })
    },

    stop: () => {
      return new Promise<{ blob: Blob; durationMs: number; mime: string }>((resolve, reject) => {
        const recorder = mediaRecorder
        if (!recorder) {
          reject(new Error('MediaRecorder가 초기화되지 않았습니다.'))
          return
        }

        // 마지막 구간 누적
        if (recorder.state === 'recording') {
          accumulated += performance.now() - startTime
        }
        stopTimer()
        stopLevelLoop()

        stopResolve = (result) => {
          // 트랙 정리 (AudioContext 포함)
          micStream?.getTracks().forEach((t) => t.stop())
          systemStream?.getTracks().forEach((t) => t.stop())
          micStream = null
          systemStream = null

          if (audioCtx) {
            audioCtx.close().catch(() => {})
            audioCtx = null
          }
          analyser = null

          set({ state: 'stopped' })
          resolve(result)
        }

        try {
          recorder.stop()
        } catch (err) {
          stopResolve = null
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },

    reset: () => {
      void cleanup()
      set({
        state: 'idle',
        elapsedMs: 0,
        level: 0,
        error: null,
        draftId: null,
        saving: false,
        saveError: null
      })
    },

    setSaving: (saving) => set({ saving }),
    setSaveError: (msg) => set({ saveError: msg })
  }
})
