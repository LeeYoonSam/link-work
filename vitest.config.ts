import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src')
    }
  },
  // .tsx 테스트에서 React 자동 JSX 런타임을 쓰도록 esbuild에 알린다
  // (renderToStaticMarkup 기반 렌더 테스트용)
  esbuild: {
    jsx: 'automatic'
  },
  test: {
    globals: true
  }
})
