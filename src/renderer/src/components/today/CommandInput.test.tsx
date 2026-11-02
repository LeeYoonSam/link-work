import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  CommandInterpretation,
  CommandOpResult,
  CommandPreviewOp,
  TodayPayload
} from '../../types'
import {
  CommandInputView,
  COMMAND_NO_AI_HINT,
  commandViewOf,
  executableOps,
  type CommandInputViewProps
} from './CommandInput'
import { isCommandStale, useAssistantStore } from '../../stores/assistantStore'

// 명령 입력창 (docs/ASSISTANT.md 부록 G.10). 자동 클릭 검증이 불가하다.
// 그래서 표시 컴포넌트는 renderToStaticMarkup 으로, 스토어 동작은 window.api 스텁으로 확인한다.

const done: CommandPreviewOp = {
  op: { kind: 'set_status', itemId: 1, status: 'done', note: null },
  label: "'PROJ-12 결제 API' 완료",
  executable: true
}
const manual: CommandPreviewOp = {
  op: { kind: 'add_manual', title: '견적서 보내기', dueDate: null },
  label: "'견적서 보내기' 임시 항목으로 추가",
  executable: true
}
const unsupported: CommandPreviewOp = {
  op: { kind: 'unsupported', reason: '캘린더에서 바꿔 주세요.' },
  label: '지원하지 않음: 캘린더에서 바꿔 주세요.',
  executable: false
}

const interp = (over: Partial<CommandInterpretation> = {}): CommandInterpretation => ({
  text: 'PROJ-12 끝났어',
  scopeItemId: null,
  ops: [done, unsupported],
  source: 'llm',
  error: null,
  dropped: 0,
  ...over
})

const props = (over: Partial<CommandInputViewProps> = {}): CommandInputViewProps => ({
  text: '',
  scoped: false,
  aiOn: true,
  busy: false,
  interpreting: false,
  applying: false,
  preview: null,
  error: '',
  result: null,
  onTextChange: () => {},
  onSubmit: () => {},
  onApply: () => {},
  onCancel: () => {},
  ...over
})

const render = (over: Partial<CommandInputViewProps> = {}): string =>
  renderToStaticMarkup(<CommandInputView {...props(over)} />)

describe('CommandInput 표시', () => {
  it('입력: 일반 모드 placeholder·maxLength 500·해석 버튼. 빈 문장이면 해석 버튼이 비활성', () => {
    const html = render()
    expect(html).toContain('placeholder="비서에게 말하기. 예: PROJ-12 끝났어 · API 문서는 내일 할게"')
    expect(html).toContain('maxLength="500"')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>해석<\/button>/)
    expect(html).not.toContain(COMMAND_NO_AI_HINT)
  })

  it('입력: scope 모드 placeholder 와 AI 꺼짐 힌트', () => {
    const html = render({ scoped: true, aiOn: false, text: '완료' })
    expect(html).toContain('placeholder="완료, 미룸, 또는 진행 상황 한 줄"')
    expect(html).toContain(COMMAND_NO_AI_HINT)
    expect(html).toMatch(/<button type="button" class="[^"]*">해석<\/button>/)
  })

  it('진행 중: 해석 중… 이고 입력이 비활성이다', () => {
    const html = render({ text: 'PROJ-12 끝났어', interpreting: true })
    expect(html).toContain('해석 중…')
    expect(html).toMatch(/<input[^>]*disabled=""/)
  })

  it('미리보기: 조작 label, 실행 불가는 회색, 적용 (n건)·취소 버튼', () => {
    const html = render({ preview: interp() })
    expect(html).toContain("&#x27;PROJ-12 결제 API&#x27; 완료")
    expect(html).toMatch(/class="text-xs text-gray-400">· 지원하지 않음: 캘린더에서 바꿔 주세요.</)
    expect(html).toContain('적용 (1건)')
    expect(html).toContain('취소')
    expect(html).not.toContain('적용할 조작이 없습니다.')
    // 적용 버튼이 활성이다
    expect(html).not.toMatch(/disabled=""[^>]*>적용 \(1건\)/)
  })

  it('미리보기: 규칙 폴백 안내·뺀 조작 수·실행 가능 0건이면 적용 (0건) 비활성', () => {
    const html = render({
      preview: interp({ ops: [unsupported], source: 'rules', error: '시간 초과', dropped: 2 })
    })
    expect(html).toContain('AI 해석에 실패해 규칙으로 해석했습니다: 시간 초과')
    expect(html).toContain('2건은 오늘 계획에 없는 항목이라 뺐습니다.')
    expect(html).toContain('적용할 조작이 없습니다.')
    expect(html).toMatch(/disabled=""[^>]*>적용 \(0건\)/)
  })

  it('미리보기: busy 면 적용 비활성, 적용 중이면 적용 중…', () => {
    expect(render({ preview: interp(), busy: true })).toMatch(/disabled=""[^>]*>적용 \(1건\)/)
    expect(render({ preview: interp(), busy: true, applying: true })).toContain('적용 중…')
  })

  it('결과: n건 적용과 실패 조작의 label·error 를 줄마다 보인다', () => {
    const results: CommandOpResult[] = [
      { op: done.op, label: done.label, ok: true, error: null },
      { op: manual.op, label: manual.label, ok: false, error: '항목을 찾을 수 없습니다.' }
    ]
    const html = render({ result: { results, applied: 1, failed: 1 } })
    expect(html).toContain('1건 적용')
    expect(html).toContain('&#x27;견적서 보내기&#x27; 임시 항목으로 추가: 항목을 찾을 수 없습니다.')
    expect(html).not.toContain('PROJ-12 결제 API')
  })

  it('오류: commandError 를 빨간 문구로 보인다', () => {
    expect(render({ error: '근무 중이 아닙니다' })).toContain(
      '<p class="text-xs text-red-600">근무 중이 아닙니다</p>'
    )
  })
})

describe('CommandInput 순수 헬퍼', () => {
  it('executableOps: 실행 가능한 조작의 op 만 순서대로 고른다', () => {
    expect(executableOps(null)).toEqual([])
    expect(executableOps(interp({ ops: [done, unsupported, manual] }))).toEqual([done.op, manual.op])
  })

  it('commandViewOf: 미리보기는 같은 scopeItemId 에서만, 진행·오류·결과는 요청한 입력창에서만 보인다', () => {
    const base = {
      command: interp({ scopeItemId: 7 }),
      commandPhase: 'interpreting' as const,
      commandError: '실패',
      commandResult: null,
      commandScope: 7
    }
    const scoped = commandViewOf(base, 7)
    expect(scoped.preview?.scopeItemId).toBe(7)
    expect(scoped.interpreting).toBe(true)
    expect(scoped.error).toBe('실패')
    const main = commandViewOf(base)
    expect(main.preview).toBeNull()
    expect(main.interpreting).toBe(false)
    expect(main.error).toBe('')
  })
})

describe('assistantStore 명령 동작 (부록 G.10.2)', () => {
  const today = { logicalDate: '2026-11-02' } as unknown as TodayPayload
  const dayOf = (id: number, status: 'active' | 'closed'): TodayPayload =>
    ({ logicalDate: '2026-11-02', plan: { id, status } }) as unknown as TodayPayload
  const interpretCommand = vi.fn()
  const applyCommand = vi.fn()
  const closeDay = vi.fn()
  const reopenDay = vi.fn()
  const getToday = vi.fn()

  beforeEach(() => {
    interpretCommand.mockReset()
    applyCommand.mockReset()
    vi.stubGlobal('window', {
      api: { assistant: { interpretCommand, applyCommand, closeDay, reopenDay, getToday } }
    })
    useAssistantStore.setState({
      today: dayOf(1, 'active'),
      busy: false,
      error: '',
      command: null,
      commandPhase: 'idle',
      commandError: '',
      commandResult: null,
      commandScope: null
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('interpretCommand: 공백 정리한 문장을 보내고 busy 를 바꾸지 않는다. 빈 문장은 보내지 않는다', async () => {
    let busyDuring: boolean | null = null
    interpretCommand.mockImplementation(async () => {
      busyDuring = useAssistantStore.getState().busy
      expect(useAssistantStore.getState().commandPhase).toBe('interpreting')
      return { success: true, interpretation: interp() }
    })
    await useAssistantStore.getState().interpretCommand('   ')
    expect(interpretCommand).not.toHaveBeenCalled()
    await useAssistantStore.getState().interpretCommand('  PROJ-12   끝났어 ')
    expect(interpretCommand).toHaveBeenCalledWith('PROJ-12 끝났어', undefined)
    expect(busyDuring).toBe(false)
    const s = useAssistantStore.getState()
    expect(s.command?.ops).toHaveLength(2)
    expect(s.commandPhase).toBe('idle')
  })

  it('interpretCommand: 실패 사유는 commandError 에 두고 스토어 error 는 그대로다', async () => {
    interpretCommand.mockResolvedValue({ success: false, error: '근무 중이 아닙니다' })
    await useAssistantStore.getState().interpretCommand('완료', 3)
    const s = useAssistantStore.getState()
    expect(interpretCommand).toHaveBeenCalledWith('완료', 3)
    expect(s.commandError).toBe('근무 중이 아닙니다')
    expect(s.commandScope).toBe(3)
    expect(s.error).toBe('')
  })

  it('applyCommand: 실행 가능한 조작만 보내고, 성공하면 today·commandResult 를 두고 command 를 비운다', async () => {
    const results: CommandOpResult[] = [{ op: done.op, label: done.label, ok: true, error: null }]
    let busyDuring: boolean | null = null
    applyCommand.mockImplementation(async () => {
      busyDuring = useAssistantStore.getState().busy
      return { success: true, today, results, applied: 1, failed: 0 }
    })
    useAssistantStore.setState({ command: interp() })
    const ok = await useAssistantStore.getState().applyCommand()
    expect(ok).toBe(true)
    expect(applyCommand).toHaveBeenCalledWith([done.op], 'PROJ-12 끝났어')
    expect(busyDuring).toBe(true)
    const s = useAssistantStore.getState()
    expect(s.today).toBe(today)
    expect(s.command).toBeNull()
    expect(s.commandResult).toEqual({ results, applied: 1, failed: 0 })
    expect(s.busy).toBe(false)
    expect(s.commandPhase).toBe('idle')
  })

  it('applyCommand: 실행 가능한 조작이 0건이면 보내지 않는다. 실패하면 command 를 남긴다', async () => {
    useAssistantStore.setState({ command: interp({ ops: [unsupported] }) })
    expect(await useAssistantStore.getState().applyCommand()).toBe(false)
    expect(applyCommand).not.toHaveBeenCalled()

    applyCommand.mockResolvedValue({ success: false, error: '조작 형식이 잘못되었습니다' })
    useAssistantStore.setState({ command: interp() })
    expect(await useAssistantStore.getState().applyCommand()).toBe(false)
    const s = useAssistantStore.getState()
    expect(s.commandError).toBe('조작 형식이 잘못되었습니다')
    expect(s.command).not.toBeNull()
    expect(s.busy).toBe(false)
  })

  it('closeDay 성공·날짜 변경: 명령 미리보기·오류·결과·범위를 비운다. 다시 열어도 예전 미리보기가 없다', async () => {
    const filled = {
      command: interp(),
      commandError: 'x',
      commandResult: { results: [], applied: 1, failed: 0 },
      commandScope: 4
    }
    useAssistantStore.setState(filled)
    closeDay.mockResolvedValue({ success: true, today: dayOf(1, 'closed') })
    await useAssistantStore.getState().closeDay()
    let s = useAssistantStore.getState()
    expect(s.command).toBeNull()
    expect(s.commandError).toBe('')
    expect(s.commandResult).toBeNull()
    expect(s.commandScope).toBeNull()
    reopenDay.mockResolvedValue({ success: true, today: dayOf(1, 'active') })
    await useAssistantStore.getState().reopenDay()
    expect(useAssistantStore.getState().command).toBeNull()

    // 같은 계획을 다시 읽으면 미리보기를 유지한다. 날짜가 바뀌어 계획 id 가 바뀌면 비운다
    useAssistantStore.setState(filled)
    getToday.mockResolvedValue({ success: true, today: dayOf(1, 'active') })
    await useAssistantStore.getState().load()
    expect(useAssistantStore.getState().command).not.toBeNull()
    getToday.mockResolvedValue({ success: true, today: dayOf(2, 'active') })
    await useAssistantStore.getState().load()
    s = useAssistantStore.getState()
    expect(s.command).toBeNull()
    expect(s.commandScope).toBeNull()

    expect(isCommandStale(dayOf(1, 'active'), dayOf(1, 'active'))).toBe(false)
    expect(isCommandStale(dayOf(1, 'active'), dayOf(1, 'closed'))).toBe(true)
    expect(isCommandStale(dayOf(1, 'active'), { plan: null } as unknown as TodayPayload)).toBe(true)
  })

  it('interpretCommand: 해석 중에 하루가 닫히면 결과를 버린다', async () => {
    interpretCommand.mockImplementation(async () => {
      useAssistantStore.setState({ today: dayOf(1, 'closed') })
      return { success: true, interpretation: interp() }
    })
    await useAssistantStore.getState().interpretCommand('PROJ-12 끝났어')
    const s = useAssistantStore.getState()
    expect(s.command).toBeNull()
    expect(s.commandPhase).toBe('idle')
  })

  it('clearCommand: 취소하면 command·commandError·commandResult 를 비운다', () => {
    useAssistantStore.setState({
      command: interp(),
      commandError: 'x',
      commandResult: { results: [], applied: 0, failed: 0 }
    })
    useAssistantStore.getState().clearCommand()
    const s = useAssistantStore.getState()
    expect(s.command).toBeNull()
    expect(s.commandError).toBe('')
    expect(s.commandResult).toBeNull()
  })
})
