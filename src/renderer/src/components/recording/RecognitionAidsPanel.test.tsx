import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GlossaryEntry, Member, Project } from '../../types'

// 인식 보조 패널(용어집·구성원)이 등록된 항목과 빈 상태·고지 문구를 실제로 그리는지 고정한다.
//
// zustand v5는 서버 렌더(renderToStaticMarkup)에서 useSyncExternalStore의
// getServerSnapshot으로 **초기 상태**를 돌려준다. setState로 주입해도 렌더에 반영되지
// 않으므로 스토어 훅 자체를 모킹한다 (RecordingList.test.tsx와 같은 방식).
const state: { glossary: GlossaryEntry[]; members: Member[]; projects: Project[] } = {
  glossary: [],
  members: [],
  projects: []
}

const noop = async (): Promise<boolean> => true

vi.mock('../../stores/recognitionAidsStore', () => ({
  useRecognitionAidsStore: () => ({
    glossary: state.glossary,
    members: state.members,
    loading: false,
    error: null,
    fetchAll: async () => {},
    upsertGlossary: noop,
    removeGlossary: noop,
    importGlossaryText: async () => null,
    upsertMember: noop,
    removeMember: noop
  })
}))

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: () => ({
    projects: state.projects,
    fetchProjects: async () => {}
  })
}))

const RecognitionAidsPanel = (await import('./RecognitionAidsPanel')).default

const glossary = (
  id: number,
  term: string,
  aliases: string[],
  note: string | null,
  project_id: number | null = null
): GlossaryEntry => ({
  id,
  term,
  aliases,
  note,
  priority: 0,
  enabled: 1,
  project_id,
  created_at: '2026-08-25 10:00:00',
  updated_at: '2026-08-25 10:00:00'
})

const member = (id: number, name: string, aliases: string[], role: string | null): Member => ({
  id,
  name,
  aliases,
  role,
  enabled: 1,
  sort_order: id,
  created_at: '2026-08-25 10:00:00',
  updated_at: '2026-08-25 10:00:00'
})

const project = (id: number, name: string): Project => ({
  id,
  name,
  description: null,
  dev_start_date: '2026-08-01',
  dev_end_date: '2026-08-10',
  qa_start_date: '2026-08-11',
  qa_end_date: '2026-08-15',
  deploy_date: '2026-08-20',
  deploy_version: null,
  status: 'development',
  status_manual: 0,
  created_at: '2026-08-01 10:00:00',
  updated_at: '2026-08-01 10:00:00'
})

const render = (
  next: Partial<typeof state>,
  tab: 'glossary' | 'members' = 'glossary'
): string => {
  state.glossary = next.glossary ?? []
  state.members = next.members ?? []
  state.projects = next.projects ?? []
  return renderToStaticMarkup(<RecognitionAidsPanel initialTab={tab} />)
}

describe('RecognitionAidsPanel', () => {
  it('용어 행에 정답 표기·오인식 표기·메모·프로젝트 범위를 그린다', () => {
    const html = render(
      {
        glossary: [glossary(1, 'LinkWork', ['링크워크', '링크웍'], '사내 WBS 앱', 7)],
        projects: [project(7, '검색홈 개편')]
      },
      'glossary'
    )
    // value= 로 확인한다 — 같은 문자열이 가져오기 textarea의 예시 placeholder에도 있어서
    // 단순 포함 검사로는 빈 목록에서도 통과해 버린다.
    expect(html).toContain('value="LinkWork"')
    // 별칭 배열은 사람이 읽는 쉼표 나열로 되돌아온다
    expect(html).toContain('value="링크워크, 링크웍"')
    expect(html).toContain('value="사내 WBS 앱"')
    // 프로젝트 범위 select에 전역과 프로젝트 이름이 모두 있다
    expect(html).toContain('전역')
    expect(html).toContain('검색홈 개편')
  })

  it('구성원 행에 이름·호칭/별칭·역할을 그린다', () => {
    const html = render({ members: [member(1, '홍길동', ['길동 님', 'gildong'], 'PM')] }, 'members')
    expect(html).toContain('value="홍길동"')
    expect(html).toContain('value="길동 님, gildong"')
    expect(html).toContain('value="PM"')
  })

  it('등록된 항목이 없으면 탭별 빈 상태를 안내한다', () => {
    expect(render({}, 'glossary')).toContain('등록된 용어가 없습니다')
    expect(render({}, 'members')).toContain('등록된 구성원이 없습니다')
  })

  it('저장 위치와 용도 고지를 항상 보여준다', () => {
    const guidance = '이 정보는 이 기기의 로컬 DB에만 저장되며, 전사 힌트·후보정·AI 요약 프롬프트에 사용됩니다.'
    expect(render({}, 'glossary')).toContain(guidance)
    expect(render({ members: [member(1, '홍길동', [], null)] }, 'members')).toContain(guidance)
  })

  it('용어집 탭은 텍스트 일괄 가져오기 형식을 안내한다', () => {
    const html = render({}, 'glossary')
    expect(html).toContain('텍스트로 가져오기')
    expect(html).toContain('정답 | 별칭1, 별칭2 | 메모')
  })
})
