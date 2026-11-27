import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  // .tsx 테스트에서 React 자동 JSX 런타임을 쓰도록 esbuild에 알린다
  // (renderToStaticMarkup 기반 렌더 테스트용)
  esbuild: {
    jsx: 'automatic'
  },
  test: {
    globals: true,
    // 워크트리 사본(.claude/worktrees)의 테스트가 중복 수집되지 않게 한다
    exclude: [...configDefaults.exclude, '.claude/worktrees/**']
  }
})
