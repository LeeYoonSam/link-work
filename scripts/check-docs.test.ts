// scripts/check-docs.mjs 의 순수 함수 단위 테스트 + 저장소 대상 문서 검사 (a)(b)(c)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_ROOT,
  changedFiles,
  channelPrefixes,
  checkMapping,
  extractChannelTokens,
  extractChannels,
  extractRepoPaths,
  findUnknownChannels,
  formatProblems,
  gitChangedFiles,
  globToRegExp,
  matchesAny,
  pendingDocs,
  runChecks
} from './check-docs.mjs'

describe('globToRegExp', () => {
  it('* 는 경로 구분자를 넘지 않고 ** 는 넘는다', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/x/a.ts')).toBe(false)
    expect(globToRegExp('src/**').test('src/x/y/a.ts')).toBe(true)
    expect(globToRegExp('src/**/a.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/**/a.ts').test('src/x/y/a.ts')).toBe(true)
  })

  it('{a,b} 와 점을 문자 그대로 다룬다', () => {
    const re = globToRegExp('src/{ai,todo}.ipc.ts')
    expect(re.test('src/ai.ipc.ts')).toBe(true)
    expect(re.test('src/todo.ipc.ts')).toBe(true)
    expect(re.test('src/memo.ipc.ts')).toBe(false)
    expect(re.test('src/aiXipcXts')).toBe(false)
    expect(matchesAny('a/b.test.tsx', ['**/*.test.ts', '**/*.test.tsx'])).toBe(true)
  })
})

describe('extractRepoPaths', () => {
  it('저장소 경로를 줄 번호와 함께 뽑고 조사·문장 부호를 떼어 낸다', () => {
    const text = [
      '첫 줄',
      '`src/main/services/ai-agent.ts` 를 본다. src/main/db/schema.ts의 테이블.',
      '끝에 점: scripts/check-docs.mjs.'
    ].join('\n')
    expect(extractRepoPaths(text, 'docs/X.md')).toEqual([
      { line: 2, path: 'src/main/services/ai-agent.ts', kind: 'path' },
      { line: 2, path: 'src/main/db/schema.ts', kind: 'path' },
      { line: 3, path: 'scripts/check-docs.mjs', kind: 'path' }
    ])
  })

  it('URL·glob·확장자 없는 디렉터리·줄 번호 접미사는 경로로 보지 않거나 떼어 낸다', () => {
    const text = [
      'https://github.com/x/src/main/a.ts',
      'src/main/services/assistant-*.ts',
      'src/renderer/src/mobile/',
      'src/main/ipc/ai.ipc.ts:42',
      'docs/{A,B}.md'
    ].join('\n')
    expect(extractRepoPaths(text, 'docs/X.md').map((r) => r.path)).toEqual(['src/main/ipc/ai.ipc.ts'])
  })

  it('마크다운 상대 링크를 문서 위치 기준으로 풀고 외부 링크·앵커는 건너뛴다', () => {
    const text = [
      '[a](./AI_GUARDRAILS.md) [b](../README.md#설치) [c](https://x.y/z.md) [d](#절)',
      '[e](references/claude-agent-teams.md "제목")'
    ].join('\n')
    expect(extractRepoPaths(text, 'docs/X.md')).toEqual([
      { line: 1, path: 'docs/AI_GUARDRAILS.md', kind: 'link' },
      { line: 1, path: 'README.md', kind: 'link' },
      { line: 2, path: 'docs/references/claude-agent-teams.md', kind: 'link' }
    ])
  })
})

describe('extractChannels', () => {
  it('등록·호출·송신 도우미의 첫 문자열 인자에서 채널을 뽑는다', () => {
    const code = `
      ipcMain.handle('todo:list', () => [])
      ipcMain.on("tray:openApp", fn)
      ipcRenderer.invoke('memo:create', input)
      ipcRenderer.on('tray:data', handler)
      win.webContents.send('assistant:navigate', payload)
      sendToAllWindows('mobile:publishRequested')
      sendToMainWindow(\`assistant:changed\`, e)
      format(d, 'HH:mm')
      ipcRenderer.invoke(channel)
      import x from 'node:sqlite'
    `
    expect([...extractChannels(code)].sort()).toEqual([
      'assistant:changed',
      'assistant:navigate',
      'memo:create',
      'mobile:publishRequested',
      'todo:list',
      'tray:data',
      'tray:openApp'
    ])
  })

  it('채널의 접두사 집합을 만든다', () => {
    expect([...channelPrefixes(new Set(['a:x', 'a:y', 'jiraBoard:get']))].sort()).toEqual(['a', 'jiraBoard'])
  })
})

describe('extractChannelTokens / findUnknownChannels', () => {
  const text = [
    '`todo:list` 와 `todo:gone` 을 쓴다.', // 1
    '`linkwork://view/today` 와 `mode=ro` 와 `task:N` 은 채널이 아니다.', // 2
    '`jira:KEY` 는 자리표시자다. `assistant:getToday(date)` 는 호출 꼴이다.', // 3
    '```ts', // 4
    "ipcMain.handle('todo:fenced')", // 5
    '`todo:inFence`', // 6
    '```', // 7
    '`unknownNs:thing` 과 `todo:a b` 는 무시한다.' // 8
  ].join('\n')

  it('`접두사:이름` 꼴 토큰만 뽑고 대문자 이름·펜스 코드 블록은 뺀다', () => {
    expect(extractChannelTokens(text)).toEqual([
      { line: 1, token: 'todo:list', prefix: 'todo' },
      { line: 1, token: 'todo:gone', prefix: 'todo' },
      { line: 3, token: 'assistant:getToday', prefix: 'assistant' },
      { line: 8, token: 'unknownNs:thing', prefix: 'unknownNs' }
    ])
  })

  it('알려진 접두사인데 채널 집합에 없는 토큰만 오류로 본다', () => {
    const channels = new Set(['todo:list', 'assistant:getToday', 'jira:status'])
    const unknown = findUnknownChannels(extractChannelTokens(text), channels, channelPrefixes(channels))
    expect(unknown.map((t) => `${t.line}:${t.token}`)).toEqual(['1:todo:gone'])
  })

  it('지운 네임스페이스(retired)의 토큰은 코드에 접두사가 없어도 오류로 본다', () => {
    const doc = '`report:generate` 와 `today:getBriefing` 은 지웠다. `todo:list` 는 있다. `other:x` 는 모른다.'
    const channels = new Set(['todo:list'])
    const unknown = findUnknownChannels(
      extractChannelTokens(doc),
      channels,
      channelPrefixes(channels),
      new Set(['report', 'today'])
    )
    expect(unknown.map((t) => t.token)).toEqual(['report:generate', 'today:getBriefing'])
    // retired 를 주지 않으면 모르는 접두사로 보고 넘긴다
    expect(findUnknownChannels(extractChannelTokens(doc), channels, channelPrefixes(channels))).toEqual([])
  })
})

describe('runChecks — retiredIpcPrefixes', () => {
  it('매핑 파일의 retiredIpcPrefixes 로 문서의 낡은 채널을 잡는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-docs-retired-'))
    try {
      mkdirSync(join(dir, 'docs'))
      mkdirSync(join(dir, 'src/main'), { recursive: true })
      writeFileSync(join(dir, 'src/main/a.ts'), "ipcMain.handle('todo:list', f)\n")
      writeFileSync(
        join(dir, 'docs/docs-map.json'),
        JSON.stringify({
          retiredIpcPrefixes: ['report'],
          areas: [{ name: 'A', patterns: ['src/main/**'], docs: ['docs/A.md'] }]
        })
      )
      writeFileSync(join(dir, 'docs/A.md'), '# A\n`todo:list`\n`report:generate`\n')
      expect(runChecks(dir)).toEqual([
        { check: 'b', file: 'docs/A.md', line: 3, message: '지운 IPC 네임스페이스의 채널: report:generate' }
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('checkMapping', () => {
  const map = {
    areas: [
      { name: 'A', patterns: ['src/a/**'], docs: ['docs/A.md', 'docs/GONE.md'] },
      { name: '문서 없음', patterns: ['src/b/**'], docs: [] },
      { name: '패턴 없음', patterns: [], docs: [] }
    ],
    unmappedDocs: { 'docs/NOTE.md': '메모용' }
  }
  const files = new Set(['docs/A.md', 'docs/NEW.md', 'docs/NOTE.md'])

  it('없는 문서, 매핑 빠진 문서, 패턴 없는 구역을 알린다', () => {
    const problems = checkMapping(map, ['docs/A.md', 'docs/NEW.md', 'docs/NOTE.md'], (p: string) => files.has(p))
    expect(problems.map((p: { file: string; message: string }) => `${p.file} ${p.message.split(':')[0]}`)).toEqual([
      'docs/docs-map.json 매핑의 문서가 없다',
      'docs/docs-map.json 구역 "패턴 없음" 에 patterns 가 없다',
      'docs/NEW.md docs/docs-map.json 에 매핑되지 않은 문서다. 구역의 docs 에 넣거나 unmappedDocs 에 사유와 함께 적는다'
    ])
  })
})

describe('pendingDocs', () => {
  const map = {
    ignore: ['**/*.test.ts'],
    areas: [
      { name: '비서', patterns: ['src/main/services/assistant-*.ts'], docs: ['docs/ASSISTANT.md'] },
      { name: 'Jira', patterns: ['src/main/services/jira.ts'], docs: ['docs/PROJECT_BOARD.md', 'docs/RELEASE_NOTES.md'] },
      { name: '할 일', patterns: ['src/main/ipc/todo.ipc.ts'], docs: [] },
      { name: '패키지', patterns: ['package.json'], docs: ['README.md', 'CLAUDE.md'] }
    ]
  }

  it('바뀐 코드 구역의 문서 중 함께 바뀌지 않은 문서만 돌려준다', () => {
    const r = pendingDocs(map, [
      'src/main/services/assistant-day.ts',
      'src/main/services/assistant-day.test.ts',
      'src/main/services/jira.ts',
      'docs/RELEASE_NOTES.md',
      'src/main/ipc/todo.ipc.ts',
      'src/main/other.ts'
    ])
    expect(r.pending).toEqual([
      { doc: 'docs/ASSISTANT.md', areas: ['비서'], files: ['src/main/services/assistant-day.ts'] },
      { doc: 'docs/PROJECT_BOARD.md', areas: ['Jira'], files: ['src/main/services/jira.ts'] }
    ])
    expect(r.unmapped).toEqual(['src/main/other.ts'])
    expect(r.noDocAreas).toEqual([{ area: '할 일', files: ['src/main/ipc/todo.ipc.ts'] }])
  })

  it('테스트·문서만 바뀌면 확인할 문서가 없다(지운 문서·docs 아래 html 포함)', () => {
    const r = pendingDocs(map, [
      'src/main/services/assistant-day.test.ts',
      'docs/ASSISTANT.md',
      'docs/MEETING_NOTES.md',
      'docs/icon-proposals.html'
    ])
    expect(r.pending).toEqual([])
    expect(r.unmapped).toEqual([])
  })

  it('package.json 변경은 README.md 와 CLAUDE.md 를 확인 대상으로 만든다', () => {
    expect(pendingDocs(map, ['package.json']).pending.map((p: { doc: string }) => p.doc)).toEqual([
      'CLAUDE.md',
      'README.md'
    ])
  })
})

describe('changedFiles / gitChangedFiles', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  it('환경 변수로 주입한 목록을 git 대신 쓴다', () => {
    expect(changedFiles('/nonexistent', { CHECK_DOCS_CHANGED_FILES: 'a.ts, b.ts\nc.ts\n' })).toEqual([
      'a.ts',
      'b.ts',
      'c.ts'
    ])
    expect(changedFiles('/nonexistent', { CHECK_DOCS_CHANGED_FILES: '' })).toEqual([])
  })

  it('스테이징·미스테이징·추적 안 된 파일과 이름 바꾸기를 모은다(업스트림 없음)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-docs-git-'))
    dirs.push(dir)
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
    git('init', '-q')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src/keep.ts'), '1')
    writeFileSync(join(dir, 'src/old.ts'), 'old content that is long enough to be detected as rename\n')
    writeFileSync(join(dir, 'src/edit.ts'), '1')
    git('add', '-A')
    git('commit', '-qm', 'init')
    expect(gitChangedFiles(dir)).toEqual([])

    writeFileSync(join(dir, 'src/edit.ts'), '2')
    git('mv', 'src/old.ts', 'src/new.ts')
    mkdirSync(join(dir, 'src/fresh'))
    writeFileSync(join(dir, 'src/fresh/added.ts'), '1')
    expect(gitChangedFiles(dir)).toEqual(['src/edit.ts', 'src/fresh/added.ts', 'src/new.ts', 'src/old.ts'])
  })
})

describe('저장소 문서 검사 (a) 경로 (b) IPC 채널 (c) 매핑', () => {
  it('문서가 현재 코드와 맞다 — 실패하면 npm run check:docs 로 목록을 보고 해당 문서를 고친다', () => {
    const problems = runChecks(DEFAULT_ROOT)
    expect(problems, `\n${formatProblems(problems)}`).toEqual([])
  })
})
