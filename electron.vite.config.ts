import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
    plugins: [react(), tailwindcss()]
  }
})
