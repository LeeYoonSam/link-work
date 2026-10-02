import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

/**
 * 렌더러 Content-Security-Policy. 메인 창이 sandbox:false라 렌더러에 스크립트가 주입되면 피해가 크다.
 * - script-src 'self': 번들된 스크립트만. 인라인·eval 금지.
 * - style-src 'unsafe-inline': 라이브러리가 넣는 <style>을 허용 (React style prop은 CSSOM이라 무관).
 * - img-src https: — 캘린더 설명·메모 마크다운(MarkdownContent)의 외부 이미지. blob:은 AI 첨부 미리보기,
 *   linkwork-media:는 저장된 AI 첨부(linkwork-media://attachment/…). (bypassCSP 스킴이지만 명시해 둔다)
 * - media-src linkwork-media:/blob: — 녹음 재생(AudioPlayer, linkwork-media://audio/…).
 * - connect-src 'self': 렌더러는 외부로 직접 통신하지 않는다 — Jira·Google·Notion 호출은 전부 메인 프로세스.
 */
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: linkwork-media:",
  "media-src 'self' blob: linkwork-media:",
  "connect-src 'self' linkwork-media:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join('; ')

/**
 * 프로덕션 빌드에만 CSP meta를 넣는다. dev는 Vite HMR·react-refresh 인라인 프리앰블이 막히므로 제외.
 * 트레이 패널도 같은 index.html(#tray-panel)을 쓰므로 함께 적용된다.
 */
function rendererCspPlugin(): Plugin {
  return {
    name: 'linkwork-renderer-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: RENDERER_CSP },
        injectTo: 'head-prepend'
      }
    ]
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 메인 엔트리 + 화자분리 워커(utilityProcess용)를 함께 빌드 → out/main/[name].js
        input: {
          index: resolve('src/main/index.ts'),
          'diarization-worker': resolve('src/main/services/diarization/worker.ts')
        },
        // 회의 녹음용 선택적 네이티브 모듈 — 미설치 시 런타임 try/catch로 폴백되므로
        // 번들에 포함하지 않고 외부화한다 (docs/MEETING_RECORDING.md §9).
        external: ['better-sqlite3', '@fugood/whisper.node', 'sherpa-onnx-node', 'silero-vad-node']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss(), rendererCspPlugin()]
  }
})
