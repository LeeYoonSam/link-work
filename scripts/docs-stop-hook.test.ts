// scripts/docs-stop-hook.mjs 판정 로직 테스트. 바뀐 파일은 CHECK_DOCS_CHANGED_FILES 로 주입하고
// 저장소·상태 디렉터리는 임시 폴더를 쓴다.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runHook } from './docs-stop-hook.mjs'

let root: string
let stateDir: string

function env(changed: string[]): Record<string, string> {
  return {
    CHECK_DOCS_ROOT: root,
    CHECK_DOCS_CHANGED_FILES: changed.join('\n'),
    CHECK_DOCS_HOOK_STATE_DIR: stateDir
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'docs-hook-repo-'))
  stateDir = mkdtempSync(join(tmpdir(), 'docs-hook-state-'))
  mkdirSync(join(root, 'docs'))
  mkdirSync(join(root, 'src/main/ipc'), { recursive: true })
  writeFileSync(
    join(root, 'docs/docs-map.json'),
    JSON.stringify({
      areas: [{ name: 'A 기능', patterns: ['src/main/ipc/a.ipc.ts'], docs: ['docs/A.md'] }]
    })
  )
  writeFileSync(join(root, 'docs/A.md'), '# A\n`a:get` 채널\n')
  writeFileSync(join(root, 'src/main/ipc/a.ipc.ts'), "ipcMain.handle('a:get', f)\n")
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

describe('runHook', () => {
  it('바뀐 파일이 없으면 조용히 통과한다', async () => {
    expect(await runHook({ session_id: 's' }, env([]))).toEqual({ code: 0 })
  })

  it('코드만 바뀌면 대응 문서와 안내를 stderr 에 쓰고 종료 코드 2', async () => {
    const r = await runHook({ session_id: 's', stop_hook_active: false }, env(['src/main/ipc/a.ipc.ts']))
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('docs/A.md')
    expect(r.stderr).toContain('← src/main/ipc/a.ipc.ts')
    expect(r.stderr).toContain('고칠 것이 없으면 그 근거를 한 줄로 밝히고 끝내라')
  })

  it('코드와 문서가 함께 바뀌면 통과한다', async () => {
    expect(await runHook({ session_id: 's' }, env(['src/main/ipc/a.ipc.ts', 'docs/A.md']))).toEqual({ code: 0 })
  })

  it('매핑 밖 파일만 바뀌면 통과한다', async () => {
    expect(await runHook({ session_id: 's' }, env(['src/other.ts']))).toEqual({ code: 0 })
  })

  it('stop_hook_active 가 true 면 다시 막지 않는다', async () => {
    expect(await runHook({ session_id: 's', stop_hook_active: true }, env(['src/main/ipc/a.ipc.ts']))).toEqual({
      code: 0
    })
  })

  it('같은 세션에서 같은 내용이면 두 번째는 통과하고, 다른 세션이나 내용이 바뀌면 다시 막는다', async () => {
    const changed = env(['src/main/ipc/a.ipc.ts'])
    expect((await runHook({ session_id: 's1' }, changed)).code).toBe(2)
    expect((await runHook({ session_id: 's1' }, changed)).code).toBe(0)
    expect((await runHook({ session_id: 's2' }, changed)).code).toBe(2)
    writeFileSync(join(root, 'src/main/ipc/b.ipc.ts'), '')
    writeFileSync(
      join(root, 'docs/docs-map.json'),
      JSON.stringify({
        areas: [{ name: 'A 기능', patterns: ['src/main/ipc/*.ipc.ts'], docs: ['docs/A.md'] }]
      })
    )
    expect((await runHook({ session_id: 's1' }, env(['src/main/ipc/a.ipc.ts', 'src/main/ipc/b.ipc.ts']))).code).toBe(2)
  })

  it('세션 id 가 없으면 상태를 남기지 않고 매번 막는다', async () => {
    const changed = env(['src/main/ipc/a.ipc.ts'])
    expect((await runHook({}, changed)).code).toBe(2)
    expect((await runHook({}, changed)).code).toBe(2)
  })

  it('검사 오류가 있으면 막고, stop_hook_active 면 systemMessage 로만 알린다', async () => {
    writeFileSync(join(root, 'src/main/ipc/a.ipc.ts'), "ipcMain.handle('a:list', f)\n")
    const changed = env(['src/main/ipc/a.ipc.ts', 'docs/A.md'])
    const first = await runHook({ session_id: 's' }, changed)
    expect(first.code).toBe(2)
    expect(first.stderr).toContain('[b] docs/A.md:2 — 코드에 없는 IPC 채널: a:get')
    const again = await runHook({ session_id: 's', stop_hook_active: true }, changed)
    expect(again.code).toBe(0)
    expect(JSON.parse(again.stdout as string).systemMessage).toContain('문서 검사 오류 1건')
  })

  it('매핑 파일이 없으면 예외를 던진다(실행부가 잡아 통과시킨다)', async () => {
    rmSync(join(root, 'docs/docs-map.json'))
    await expect(runHook({ session_id: 's' }, env(['src/main/ipc/a.ipc.ts']))).rejects.toThrow()
  })
})
