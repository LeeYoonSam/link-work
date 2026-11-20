#!/usr/bin/env node
// Claude Code Stop 훅: 턴을 끝내기 전에 문서 동기화를 확인한다.
//
// - 바뀐 파일이 없으면 조용히 통과한다(종료 코드 0).
// - 바뀐 코드 구역의 문서 중 함께 바뀌지 않은 문서가 있거나 check:docs (a)(b)(c) 오류가 있으면
//   stderr 에 목록과 안내를 쓰고 종료 코드 2 로 한 번 멈춰 세운다.
// - 입력 JSON 의 stop_hook_active 가 true(이미 한 번 멈춰 세운 뒤 다시 끝내려는 경우)면 통과한다.
//   남은 (a)(b)(c) 오류는 systemMessage 로 사용자에게만 보여 주고 다시 막지 않는다.
// - 같은 세션에서 같은 내용으로 이미 멈춰 세웠다면 다시 막지 않는다(턴마다 같은 안내가 반복되지 않게).
// - 스크립트가 실행에 실패하면(예외, 읽을 수 없는 입력 JSON) 통과한다. 검사 실패만 막고 실행 실패로 작업을 막지 않는다.
//
// 테스트용 환경 변수: CHECK_DOCS_ROOT(검사할 저장소 루트), CHECK_DOCS_CHANGED_FILES(바뀐 파일 목록 주입),
// CHECK_DOCS_HOOK_STATE_DIR(중복 안내 방지 상태 파일 위치).

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_PROBLEMS_SHOWN = 20

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** 입력을 읽지 못하면 null. stop_hook_active 를 알 수 없으니 막지 않는다(무한 반복 방지) */
function parseInput(raw) {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

function stateFile(sessionId, env) {
  if (!sessionId || typeof sessionId !== 'string') return null
  const dir = env.CHECK_DOCS_HOOK_STATE_DIR || join(tmpdir(), 'linkwork-docs-hook')
  return join(dir, sessionId.replace(/[^\w.-]/g, '_') + '.json')
}

function alreadyReported(file, fingerprint) {
  if (!file || !existsSync(file)) return false
  try {
    return JSON.parse(readFileSync(file, 'utf8')).fingerprint === fingerprint
  } catch {
    return false
  }
}

function remember(file, fingerprint) {
  if (!file) return
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ fingerprint, at: new Date().toISOString() }))
  } catch {
    /* 기록 실패는 무시한다 */
  }
}

export async function runHook(input, env = process.env) {
  const lib = await import('./check-docs.mjs')
  const root = env.CHECK_DOCS_ROOT || lib.DEFAULT_ROOT

  const changed = lib.runChanged(root, env)
  if (changed.changed.length === 0) return { code: 0 }

  const problems = lib.runChecks(root)
  const pending = changed.pending
  if (pending.length === 0 && problems.length === 0) return { code: 0 }

  const shownProblems = problems.slice(0, MAX_PROBLEMS_SHOWN)
  const problemText =
    problems.length === 0
      ? ''
      : `[문서 검사 오류 ${problems.length}건 — npm run check:docs]\n${lib.formatProblems(shownProblems)}` +
        (problems.length > shownProblems.length ? `\n  … 외 ${problems.length - shownProblems.length}건` : '')

  if (input.stop_hook_active === true) {
    // 이미 한 번 안내했다. 다시 막지 않는다. 오류가 남아 있으면 사용자에게만 알린다
    if (problems.length === 0) return { code: 0 }
    return {
      code: 0,
      stdout: JSON.stringify({ systemMessage: `문서 검사 오류 ${problems.length}건이 남아 있다(npm run check:docs).` })
    }
  }

  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ pending: pending.map((p) => [p.doc, p.files]), problems }))
    .digest('hex')
  const file = stateFile(input.session_id, env)
  if (alreadyReported(file, fingerprint)) return { code: 0 }

  const parts = []
  if (pending.length) {
    parts.push(`[문서 동기화] 바뀐 코드에 대응하는데 함께 바뀌지 않은 문서 ${pending.length}개:\n${lib.formatPending(changed)}`)
  }
  if (problemText) parts.push(problemText)
  parts.push(
    '해당 문서를 현재 코드와 대조해 고치거나, 고칠 것이 없으면 그 근거를 한 줄로 밝히고 끝내라. ' +
      '해당하는 문서만 고친다(매핑: docs/docs-map.json).'
  )
  remember(file, fingerprint)
  return { code: 2, stderr: parts.join('\n\n') + '\n' }
}

async function main() {
  const input = parseInput(readStdin())
  if (!input) process.exit(0)
  let result
  try {
    result = await runHook(input)
  } catch (err) {
    // 실행 실패는 사용자의 작업을 막지 않는다
    process.stderr.write(`[docs-stop-hook] 검사를 실행하지 못해 건너뛴다: ${err?.message ?? err}\n`)
    process.exit(0)
  }
  if (result.stdout) process.stdout.write(result.stdout + '\n')
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.code)
}

// 테스트가 runHook 만 불러 쓸 수 있게, 직접 실행할 때만 stdin 을 읽고 종료한다
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
