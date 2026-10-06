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

export interface RecorderResult {
  blob: Blob
  durationMs: number
  mime: string
}

// stop() 요청 후 onstop을 기다리는 최대 시간. 넘기면 지금까지의 청크로 끝낸다.
export const STOP_TIMEOUT_MS = 5000

export const UNEXPECTED_STOP_ERROR =
  '녹음이 예기치 않게 중단되었습니다. 종료 및 저장을 눌러 지금까지 녹음된 내용을 저장하세요.'

interface RecorderStore {
  state: RecorderState
  elapsedMs: number
  level: number
  error: string | null
  // 녹음 시작 시 만든 draft 회의 id — 종료 시 saveAndProcess 대상
  draftId: number | null
  saving: boolean
  saveError: string | null
  // 마지막 stop() 결과 — 저장 실패 시 재시도(다시 저장)에 쓰도록 reset 전까지 보존
  lastResult: RecorderResult | null

  // 시작 성공 시 true. 실패하면 자원을 정리하고 error·idle 상태로 false
  start: (opts: { source: 'mic' | 'mic+system'; draftId: number }) => Promise<boolean>
  pause: () => void
  resume: () => void
  stop: () => Promise<RecorderResult>
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

// stop() 진행 상태 — 중복 호출 시 같은 Promise를 돌려주고, onstop/타임아웃 중 먼저 온 쪽으로 끝낸다
let stopPromise: Promise<RecorderResult> | null = null
let stopResolve: (() => void) | null = null
let stopReject: ((err: Error) => void) | null = null
let stopTimeoutId: ReturnType<typeof setTimeout> | null = null
let stopRequested = false

// 녹음 세션 번호 — reset/새 start 이후 늦게 도착한 이전 녹음기의 이벤트를 무시한다
let session = 0

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

  // 진행 중인 구간을 누적하고 타이머·레벨미터를 멈춘다 (이미 멈춰 있으면 누적하지 않음)
  const freezeElapsed = (): void => {
    if (timerId !== null) {
      accumulated += performance.now() - startTime
      set({ elapsedMs: Math.round(accumulated) })
    }
    stopTimer()
    stopLevelLoop()
  }

  const clearStopTimeout = (): void => {
    if (stopTimeoutId !== null) {
      clearTimeout(stopTimeoutId)
      stopTimeoutId = null
    }
  }

  // 마이크·시스템 트랙과 AudioContext만 정리 (청크·녹음기는 유지)
  const releaseMedia = (): void => {
    micStream?.getTracks().forEach((t) => t.stop())
    systemStream?.getTracks().forEach((t) => t.stop())
    micStream = null
    systemStream = null

    if (audioCtx) {
      audioCtx.close().catch(() => {})
      audioCtx = null
    }
    analyser = null
  }

  // 녹음이 요청 없이 끊겼을 때(onerror·예기치 않은 onstop·마이크 트랙 종료).
  // state는 그대로 두어 사용자가 '종료 및 저장'으로 지금까지의 청크를 저장할 수 있게 한다.
  const handleUnexpectedStop = (): void => {
    if (stopRequested) return
    freezeElapsed()
    set({ error: UNEXPECTED_STOP_ERROR })
  }

  // 모든 트랙과 AudioContext 정리
  const cleanup = async (): Promise<void> => {
    stopLevelLoop()
    stopTimer()
    clearStopTimeout()

    micStream?.getTracks().forEach((t) => t.stop())
    systemStream?.getTracks().forEach((t) => t.stop())
    micStream = null
    systemStream = null

    analyser = null
    mediaRecorder = null
    chunks = []
    accumulated = 0
    startTime = 0
    stopPromise = null
    stopResolve = null
    stopReject = null
    stopRequested = false

    if (audioCtx) {
      const ctx = audioCtx
      audioCtx = null
      try {
        await ctx.close()
      } catch {
        // 이미 닫혀있을 수 있음 — 무시
      }
    }
  }

  return {
    state: 'idle',
    elapsedMs: 0,
    level: 0,
    error: null,
    draftId: null,
    saving: false,
    saveError: null,
    lastResult: null,

    start: async (opts) => {
      const mySession = ++session
      set({ error: null, draftId: opts.draftId, lastResult: null })

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
        stopRequested = false

        recorder.ondataavailable = (e) => {
          if (mySession !== session) return
          if (e.data && e.data.size > 0) {
            chunks.push(e.data)
          }
        }

        recorder.onstop = () => {
          if (mySession !== session) return
          if (stopRequested) {
            stopResolve?.()
          } else {
            // 요청 없는 중단 — 청크는 보존하고 이후 stop()이 그걸로 끝낸다
            handleUnexpectedStop()
          }
        }

        recorder.onerror = () => {
          if (mySession !== session) return
          handleUnexpectedStop()
        }

        // 마이크 장치가 빠지거나 권한이 회수되면 트랙이 끝난다
        mic.getAudioTracks().forEach((t) =>
          t.addEventListener('ended', () => {
            if (mySession !== session) return
            handleUnexpectedStop()
          })
        )

        recorder.start(100) // 100ms 청크

        // 5) 타이머 + 레벨루프 시작
        accumulated = 0
        startTimer()
        startLevelLoop()

        set({ state: 'recording' })
        return true
      } catch (err) {
        await cleanup()
        const msg = err instanceof Error ? err.message : String(err)
        set({ error: `녹음을 시작할 수 없습니다: ${msg}`, state: 'idle', draftId: null })
        return false
      }
    },

    pause: () => {
      if (!mediaRecorder || mediaRecorder.state !== 'recording') return

      mediaRecorder.pause()
      // 누적 시간 저장
      freezeElapsed()
      set({ state: 'paused' })
    },

    resume: () => {
      if (!mediaRecorder || mediaRecorder.state !== 'paused') return

      mediaRecorder.resume()
      startTimer()
      startLevelLoop()
      set({ state: 'recording' })
    },

    // 절대 무한 대기하지 않는다: 이미 멈춘 녹음기는 즉시, 그 외엔 onstop 또는
    // STOP_TIMEOUT_MS 중 먼저 오는 쪽에서 지금까지의 청크로 끝낸다.
    stop: () => {
      if (stopPromise) return stopPromise

      const recorder = mediaRecorder
      if (!recorder) {
        return Promise.reject(new Error('MediaRecorder가 초기화되지 않았습니다.'))
      }

      stopRequested = true
      // 마지막 구간 누적
      freezeElapsed()

      stopPromise = new Promise<RecorderResult>((resolve, reject) => {
        stopReject = (err) => {
          clearStopTimeout()
          stopResolve = null
          stopReject = null
          reject(err)
        }
        stopResolve = () => {
          clearStopTimeout()
          stopResolve = null
          stopReject = null
          const mime = currentMime || 'audio/webm'
          const result: RecorderResult = {
            blob: new Blob(chunks, { type: mime }),
            durationMs: Math.round(accumulated),
            mime
          }
          // 트랙 정리 (AudioContext 포함)
          releaseMedia()
          set({ state: 'stopped', lastResult: result })
          resolve(result)
        }
      })
      // reset으로 거부된 Promise를 아무도 기다리지 않아도 unhandled rejection이 되지 않게
      stopPromise.catch(() => {})
      const promise = stopPromise

      if (recorder.state === 'inactive') {
        // 이미 멈춘 녹음기(예기치 않은 중단 등) — stop()은 no-op이라 onstop이 오지 않는다
        stopResolve?.()
        return promise
      }

      stopTimeoutId = setTimeout(() => {
        stopTimeoutId = null
        stopResolve?.()
      }, STOP_TIMEOUT_MS)

      try {
        recorder.stop()
      } catch {
        // 상태가 꼬여 stop이 던지면 지금까지의 청크로 끝낸다
        stopResolve?.()
      }
      return promise
    },

    reset: () => {
      session++
      const recorder = mediaRecorder
      if (recorder) {
        // 늦게 오는 이벤트가 새 상태를 건드리지 않게 핸들러를 먼저 분리
        recorder.ondataavailable = null
        recorder.onstop = null
        recorder.onerror = null
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop()
          } catch {
            // 이미 멈춘 경우 — 무시
          }
        }
      }
      // 저장 없이 끝나는 pending stop은 거부해 기다리는 쪽이 멈추지 않게 한다
      stopReject?.(new Error('녹음이 취소되었습니다.'))
      void cleanup()
      set({
        state: 'idle',
        elapsedMs: 0,
        level: 0,
        error: null,
        draftId: null,
        saving: false,
        saveError: null,
        lastResult: null
      })
    },

    setSaving: (saving) => set({ saving }),
    setSaveError: (msg) => set({ saveError: msg })
  }
})
