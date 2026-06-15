import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 회의 녹음용 선택적 네이티브 모듈 — 미설치 시 런타임 try/catch로 폴백되므로
        // 번들에 포함하지 않고 외부화한다 (docs/MEETING_RECORDING.md §9).
        external: ['better-sqlite3', '@fugood/whisper.node', 'sherpa-onnx', 'silero-vad-node']
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
