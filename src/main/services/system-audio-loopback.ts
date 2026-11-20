import { session as electronSession, desktopCapturer as electronDesktopCapturer } from 'electron'
import type { DesktopCapturerSource, Session, Streams } from 'electron'

// 렌더러의 getDisplayMedia 요청에 시스템 오디오(loopback)를 붙여 응답한다.
// 회의 녹음 '마이크 + 시스템' 소스가 이 핸들러에 의존한다 — 핸들러가 없으면 요청이 거부되어
// 항상 마이크만 녹음된다.
// - Electron 39+는 macOS 14.2+에서 audio:'loopback'을 CoreAudio Tap으로 지원한다(feature flag 불필요).
// - 'loopbackWithMute'는 스피커를 음소거하므로 쓰지 않는다.
// - 시스템 오디오 권한이 없으면 에러 없이 처음부터 ended인 오디오 트랙이 온다 → 렌더러가 live 여부를 검사한다.

// getSources가 권한 대기 등으로 resolve되지 않을 때 요청을 거절하기까지의 시간
export const GET_SOURCES_TIMEOUT_MS = 5000

export interface SystemAudioLoopbackDeps {
  session: Pick<Session, 'setDisplayMediaRequestHandler'>
  desktopCapturer: {
    getSources: (opts: { types: Array<'screen' | 'window'> }) => Promise<DesktopCapturerSource[]>
  }
  timeoutMs?: number
}

// 타임아웃과 경쟁시켜 화면 소스를 얻는다. 실패·타임아웃이면 빈 배열.
async function getScreenSources(deps: SystemAudioLoopbackDeps): Promise<DesktopCapturerSource[]> {
  const timeoutMs = deps.timeoutMs ?? GET_SOURCES_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<DesktopCapturerSource[]>((resolve) => {
    timer = setTimeout(() => resolve([]), timeoutMs)
  })
  try {
    return await Promise.race([deps.desktopCapturer.getSources({ types: ['screen'] }), timeout])
  } catch {
    return []
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export function registerSystemAudioLoopback(deps?: SystemAudioLoopbackDeps): void {
  const d: SystemAudioLoopbackDeps = deps ?? {
    session: electronSession.defaultSession,
    desktopCapturer: electronDesktopCapturer
  }

  d.session.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void getScreenSources(d).then((sources) => {
        try {
          if (sources.length > 0) {
            callback({ video: sources[0], audio: 'loopback' })
          } else {
            // video 없이 응답하면 요청이 거절된다 → 렌더러는 마이크만으로 진행
            const reject: Streams = {}
            callback(reject)
          }
        } catch (err) {
          // 요청 프레임이 이미 사라진 경우 callback이 던질 수 있다
          console.warn('[system-audio-loopback] 응답 실패:', err)
        }
      })
    },
    { useSystemPicker: false }
  )
}
