import { describe, it, expect } from 'vitest'
import { buildNotionExportMarkdown } from './notionExport'
import type { Document, Project, Task } from '../types'

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: '알림 개편',
    description: null,
    dev_start_date: '2026-06-01',
    dev_end_date: '2026-06-10',
    qa_start_date: '2026-06-11',
    qa_end_date: '2026-06-15',
    deploy_date: '2026-06-17',
    deploy_version: null,
    status: 'development',
    status_manual: 0,
    created_at: '',
    updated_at: '',
    ...overrides
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    project_id: 1,
    parent_task_id: null,
    name: 't',
    start_date: null,
    end_date: null,
    status: 'pending',
    sort_order: 0,
    created_at: '',
    ...overrides
  }
}

function doc(overrides: Partial<Document> = {}): Document {
  return {
    id: 1,
    name: 'd',
    url: 'https://example.com',
    type: 'link',
    description: null,
    project_id: 1,
    sort_order: 0,
    created_at: '',
    updated_at: '',
    ...overrides
  }
}

// 프로젝트 블록에서 헤딩만 추려 섹션 순서를 본다.
function headings(markdown: string): string[] {
  return markdown.split('\n').filter((line) => /^#{1,2} /.test(line))
}

// 헤딩 다음 빈 줄부터 다음 빈 줄 직전까지 — 해당 섹션의 본문만 잘라낸다.
function sectionBody(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n')
  const body = lines.slice(lines.indexOf(heading) + 2)
  const end = body.indexOf('')
  return end === -1 ? body : body.slice(0, end)
}

describe('buildNotionExportMarkdown', () => {
  it('데이터가 모두 있는 프로젝트를 노션 템플릿 구조 그대로 내보낸다', () => {
    const markdown = buildNotionExportMarkdown([
      {
        project: project({
          description: '알림 센터를 새로 만든다.\n푸시 정책도 함께 정리한다.',
          deploy_version: 'v2.3.0'
        }),
        tasks: [
          task({
            id: 1,
            name: 'API 설계',
            sort_order: 1,
            status: 'done',
            start_date: '2026-06-01',
            end_date: '2026-06-03'
          }),
          task({
            id: 2,
            parent_task_id: 1,
            name: '스키마 정의',
            sort_order: 1,
            status: 'done',
            start_date: '2026-06-01',
            end_date: '2026-06-02'
          }),
          task({
            id: 3,
            name: '클라이언트 구현',
            sort_order: 2,
            status: 'in_progress',
            start_date: '2026-06-04'
          })
        ],
        documents: [
          doc({ id: 1, name: 'PRD - 알림 개편', url: 'https://notion.so/prd' }),
          doc({ id: 2, name: '피그마 시안', url: 'https://figma.com/x' }),
          doc({ id: 3, name: '참고 자료', url: 'https://ex.com/ref' })
        ]
      }
    ])

    expect(markdown).toBe(
      [
        '# 알림 개편',
        '',
        '> 알림 센터를 새로 만든다.',
        '',
        '## 배포 일정',
        '',
        '- **개발 기간**: 2026.06.01 ~ 2026.06.10 (총 10일)',
        '- **QA 기간**: 2026.06.11 ~ 2026.06.15',
        '- **배포 버전**: v2.3.0 (2026.06.17)',
        '- **분류**: TBD',
        '- **배경/목적**: 알림 센터를 새로 만든다. / 푸시 정책도 함께 정리한다.',
        '',
        '---',
        '',
        '## 링크',
        '',
        '- **PRD**: [PRD - 알림 개편](https://notion.so/prd)',
        '- **Ticket (Epic/상위 작업)**:',
        '- **API Interface**:',
        '- **Figma**: [피그마 시안](https://figma.com/x)',
        '- **WBS**:',
        '- [참고 자료](https://ex.com/ref)',
        '',
        '---',
        '',
        '## 작업 범위',
        '',
        '| 작업 | 비고 | 기간 |',
        '| --- | --- | --- |',
        '| API 설계 | 완료 | 2026.06.01 ~ 2026.06.03 |',
        '| └ 스키마 정의 | 완료 | 2026.06.01 ~ 2026.06.02 |',
        '| 클라이언트 구현 | 진행중 | 2026.06.04 ~ |',
        '',
        '---',
        '',
        '## 관련 구현 티켓',
        '',
        '> 작업 기간 동안 커밋에 포함된 ICA 티켓을 나열합니다.',
        '',
        '| 티켓 | 분류 | 내용 |',
        '| --- | --- | --- |',
        '| ICA-XXXX | 구현 | ... |',
        '',
        '---',
        '',
        '## QA',
        '',
        '- **QA 에픽**:',
        '- **QA 티켓 수**:',
        '- **QA 발생률**:',
        '- **주요 이슈 요약**:',
        '',
        '---',
        '',
        '## 회고',
        '',
        '- **잘된 점**:',
        '- **아쉬운 점 / 개선할 점**:',
        '- **다음에 시도할 것**:'
      ].join('\n')
    )
  })

  it('섹션 헤딩이 템플릿 순서대로 나온다', () => {
    const markdown = buildNotionExportMarkdown([
      { project: project(), tasks: [], documents: [] }
    ])
    expect(headings(markdown)).toEqual([
      '# 알림 개편',
      '## 배포 일정',
      '## 링크',
      '## 작업 범위',
      '## 관련 구현 티켓',
      '## QA',
      '## 회고'
    ])
  })

  it('빈 입력은 빈 문자열', () => {
    expect(buildNotionExportMarkdown([])).toBe('')
  })
})

describe('배포 일정', () => {
  function scheduleLines(overrides: Partial<Project>): string[] {
    const markdown = buildNotionExportMarkdown([
      { project: project(overrides), tasks: [], documents: [] }
    ])
    return sectionBody(markdown, '## 배포 일정')
  }

  it('총 일수는 양끝을 포함해 센다', () => {
    expect(
      scheduleLines({ dev_start_date: '2026-06-01', dev_end_date: '2026-06-01' })[0]
    ).toBe('- **개발 기간**: 2026.06.01 ~ 2026.06.01 (총 1일)')
    expect(
      scheduleLines({ dev_start_date: '2026-06-29', dev_end_date: '2026-07-02' })[0]
    ).toBe('- **개발 기간**: 2026.06.29 ~ 2026.07.02 (총 4일)')
  })

  it('날짜는 YYYY.MM.DD로 바꾸고 타임존 영향을 받지 않는다', () => {
    // UTC 자정 파싱 후 로컬 변환을 거치면 하루 밀릴 수 있는 경계값
    expect(scheduleLines({ qa_start_date: '2026-01-01', qa_end_date: '2026-12-31' })[1]).toBe(
      '- **QA 기간**: 2026.01.01 ~ 2026.12.31'
    )
  })

  it('deploy_version이 없으면 TBD로 표기한다', () => {
    expect(scheduleLines({ deploy_version: null })[2]).toBe('- **배포 버전**: TBD (2026.06.17)')
    expect(scheduleLines({ deploy_version: 'v1.0.0' })[2]).toBe(
      '- **배포 버전**: v1.0.0 (2026.06.17)'
    )
  })

  it('분류는 항상 TBD', () => {
    expect(scheduleLines({})[3]).toBe('- **분류**: TBD')
  })

  it('description이 없으면 인용구를 생략하고 배경/목적은 콜론까지만 남는다', () => {
    const markdown = buildNotionExportMarkdown([
      { project: project({ description: null }), tasks: [], documents: [] }
    ])
    expect(markdown).not.toContain('\n> 알림')
    expect(markdown.split('\n')[1]).toBe('')
    expect(markdown.split('\n')[2]).toBe('## 배포 일정')
    expect(markdown).toContain('- **배경/목적**:\n')
  })

  it('인용구는 첫 줄만, 배경/목적은 전체 줄을 구분자로 이어 붙인다', () => {
    const markdown = buildNotionExportMarkdown([
      { project: project({ description: '첫 줄\n둘째 줄\n셋째 줄' }), tasks: [], documents: [] }
    ])
    expect(markdown).toContain('> 첫 줄\n')
    expect(markdown).toContain('- **배경/목적**: 첫 줄 / 둘째 줄 / 셋째 줄')
  })

  it('평문 한 줄 description은 그대로 인용구와 배경/목적에 쓰인다', () => {
    const markdown = buildNotionExportMarkdown([
      { project: project({ description: '결제 실패율을 낮춘다.' }), tasks: [], documents: [] }
    ])
    expect(markdown).toContain('> 결제 실패율을 낮춘다.\n')
    expect(markdown).toContain('- **배경/목적**: 결제 실패율을 낮춘다.')
  })
})

describe('링크 슬롯 매칭', () => {
  function linkLines(documents: Document[]): string[] {
    const markdown = buildNotionExportMarkdown([
      { project: project(), tasks: [], documents }
    ])
    return sectionBody(markdown, '## 링크')
  }

  it('문서가 없으면 빈 슬롯 5개만 남는다', () => {
    expect(linkLines([])).toEqual([
      '- **PRD**:',
      '- **Ticket (Epic/상위 작업)**:',
      '- **API Interface**:',
      '- **Figma**:',
      '- **WBS**:'
    ])
  })

  it('이름으로 슬롯을 찾고 대소문자를 가리지 않는다', () => {
    expect(
      linkLines([
        doc({ id: 1, name: '기획안', url: 'u1' }),
        doc({ id: 2, name: 'JIRA 에픽', url: 'u2' }),
        doc({ id: 3, name: 'swagger', url: 'u3' }),
        doc({ id: 4, name: 'Figma', url: 'u4' }),
        doc({ id: 5, name: 'wbs 시트', url: 'u5' })
      ])
    ).toEqual([
      '- **PRD**: [기획안](u1)',
      '- **Ticket (Epic/상위 작업)**: [JIRA 에픽](u2)',
      '- **API Interface**: [swagger](u3)',
      '- **Figma**: [Figma](u4)',
      '- **WBS**: [wbs 시트](u5)'
    ])
  })

  it('슬롯당 첫 문서만 채우고 나머지 매칭 문서는 개별 불릿으로 내려간다', () => {
    expect(
      linkLines([
        doc({ id: 1, name: 'PRD v1', url: 'u1' }),
        doc({ id: 2, name: 'PRD v2', url: 'u2' })
      ])
    ).toEqual([
      '- **PRD**: [PRD v1](u1)',
      '- **Ticket (Epic/상위 작업)**:',
      '- **API Interface**:',
      '- **Figma**:',
      '- **WBS**:',
      '- [PRD v2](u2)'
    ])
  })

  it('여러 슬롯에 걸리는 이름은 우선순위가 앞선 슬롯 하나에만 들어간다', () => {
    // '기획 디자인'은 PRD(기획)와 Figma(디자인) 모두에 걸리지만 PRD가 앞선다
    expect(linkLines([doc({ id: 1, name: '기획 디자인', url: 'u1' })])).toEqual([
      '- **PRD**: [기획 디자인](u1)',
      '- **Ticket (Epic/상위 작업)**:',
      '- **API Interface**:',
      '- **Figma**:',
      '- **WBS**:'
    ])
  })

  it('어느 슬롯에도 걸리지 않는 문서는 개별 불릿으로 남는다', () => {
    expect(linkLines([doc({ id: 1, name: '회의록', url: 'u1' })])).toEqual([
      '- **PRD**:',
      '- **Ticket (Epic/상위 작업)**:',
      '- **API Interface**:',
      '- **Figma**:',
      '- **WBS**:',
      '- [회의록](u1)'
    ])
  })
})

describe('작업 범위 표', () => {
  function taskRows(tasks: Task[]): string[] {
    const markdown = buildNotionExportMarkdown([
      { project: project(), tasks, documents: [] }
    ])
    return sectionBody(markdown, '## 작업 범위')
  }

  it('작업이 없으면 표 대신 안내 문구만 남는다', () => {
    expect(taskRows([])).toEqual(['_등록된 작업 없음_'])
  })

  it('하위 작업은 상위 바로 아래에 └ 접두로 붙는다', () => {
    expect(
      taskRows([
        task({ id: 1, name: '상위 B', sort_order: 2 }),
        task({ id: 2, name: '상위 A', sort_order: 1 }),
        task({ id: 3, parent_task_id: 2, name: '하위 A-1', sort_order: 1 })
      ])
    ).toEqual([
      '| 작업 | 비고 | 기간 |',
      '| --- | --- | --- |',
      '| 상위 A | 대기 |  |',
      '| └ 하위 A-1 | 대기 |  |',
      '| 상위 B | 대기 |  |'
    ])
  })

  it('상태를 한국어로 바꾼다', () => {
    const rows = taskRows([
      task({ id: 1, name: 'a', sort_order: 1, status: 'pending' }),
      task({ id: 2, name: 'b', sort_order: 2, status: 'in_progress' }),
      task({ id: 3, name: 'c', sort_order: 3, status: 'done' })
    ])
    expect(rows.slice(2)).toEqual([
      '| a | 대기 |  |',
      '| b | 진행중 |  |',
      '| c | 완료 |  |'
    ])
  })

  it('기간은 있는 쪽만 채우고 둘 다 없으면 빈 셀로 둔다', () => {
    const rows = taskRows([
      task({ id: 1, name: '양쪽', sort_order: 1, start_date: '2026-06-01', end_date: '2026-06-02' }),
      task({ id: 2, name: '시작만', sort_order: 2, start_date: '2026-06-03' }),
      task({ id: 3, name: '종료만', sort_order: 3, end_date: '2026-06-04' }),
      task({ id: 4, name: '없음', sort_order: 4 })
    ])
    expect(rows.slice(2)).toEqual([
      '| 양쪽 | 대기 | 2026.06.01 ~ 2026.06.02 |',
      '| 시작만 | 대기 | 2026.06.03 ~ |',
      '| 종료만 | 대기 | ~ 2026.06.04 |',
      '| 없음 | 대기 |  |'
    ])
  })

  it('셀 안의 파이프는 이스케이프하고 개행은 공백으로 바꾼다', () => {
    const rows = taskRows([
      task({ id: 1, name: '배포 | 롤백 계획', sort_order: 1 }),
      task({ id: 2, name: '두 줄\n작업명', sort_order: 2 })
    ])
    expect(rows.slice(2)).toEqual([
      '| 배포 \\| 롤백 계획 | 대기 |  |',
      '| 두 줄 작업명 | 대기 |  |'
    ])
  })
})

describe('마크다운 description', () => {
  function exportOne(overrides: Partial<Project>, documents: Document[] = []): string {
    return buildNotionExportMarkdown([{ project: project(overrides), tasks: [], documents }])
  }

  // 실데이터: 프로젝트 "Sus 개선 작업 (4.162.0)"의 description
  const susDescription = [
    '## 개요',
    '4.162.0 배포 타겟의 Sustaining 개선 작업 모음.',
    '',
    '## 참조',
    '- 상위 에픽: [ICA-8672] Android/Sus Sprint 26-08 — https://backpackr.atlassian.net/browse/ICA-8672'
  ].join('\n')

  it('헤딩 줄은 본문에서 버리고 첫 본문 줄을 인용구로 쓴다', () => {
    const markdown = exportOne({ description: susDescription })
    expect(markdown).toContain('> 4.162.0 배포 타겟의 Sustaining 개선 작업 모음.\n')
    expect(markdown).not.toContain('> ## 개요')
  })

  it('배경/목적에 마크다운 마커가 섞이지 않는다', () => {
    const scheduleFields = sectionBody(exportOne({ description: susDescription }), '## 배포 일정')
    expect(scheduleFields[4]).toBe('- **배경/목적**: 4.162.0 배포 타겟의 Sustaining 개선 작업 모음.')
    expect(scheduleFields[4]).not.toContain('#')
    expect(scheduleFields[4]).not.toContain('http')
  })

  it('description 속 Jira 링크가 Ticket 슬롯으로 올라간다', () => {
    expect(sectionBody(exportOne({ description: susDescription }), '## 링크')).toEqual([
      '- **PRD**:',
      '- **Ticket (Epic/상위 작업)**: [상위 에픽: ICA-8672 Android/Sus Sprint 26-08](https://backpackr.atlassian.net/browse/ICA-8672)',
      '- **API Interface**:',
      '- **Figma**:',
      '- **WBS**:'
    ])
  })

  it('bare URL은 앞 텍스트를, 마크다운 링크는 라벨을 링크 이름으로 쓴다', () => {
    const description = [
      '- PRD 문서: https://notion.so/prd',
      '- [피그마 시안](https://figma.com/file/abc)'
    ].join('\n')
    const markdown = exportOne({ description })
    expect(sectionBody(markdown, '## 링크')).toEqual([
      '- **PRD**: [PRD 문서](https://notion.so/prd)',
      '- **Ticket (Epic/상위 작업)**:',
      '- **API Interface**:',
      '- **Figma**: [피그마 시안](https://figma.com/file/abc)',
      '- **WBS**:'
    ])
    // URL 줄만 있으면 본문이 비어 인용구도 배경/목적도 남지 않는다
    expect(markdown.split('\n').slice(0, 3)).toEqual(['# 알림 개편', '', '## 배포 일정'])
    expect(markdown).toContain('- **배경/목적**:\n')
  })

  it('라벨이 비면 URL 자체를 라벨로 쓴다', () => {
    expect(sectionBody(exportOne({ description: 'https://example.com/a' }), '## 링크')).toContain(
      '- [https://example.com/a](https://example.com/a)'
    )
  })

  it('documents를 먼저 배정하고 남은 슬롯을 description 링크가 채운다', () => {
    const markdown = exportOne(
      { description: '- 기획 초안: https://notion.so/from-description' },
      [doc({ id: 1, name: '기획서', url: 'https://notion.so/from-document' })]
    )
    expect(sectionBody(markdown, '## 링크')).toEqual([
      '- **PRD**: [기획서](https://notion.so/from-document)',
      '- **Ticket (Epic/상위 작업)**:',
      '- **API Interface**:',
      '- **Figma**:',
      '- **WBS**:',
      '- [기획 초안](https://notion.so/from-description)'
    ])
  })
})

describe('URL 호스트 기반 슬롯 배정', () => {
  function linkLines(documents: Document[]): string[] {
    return sectionBody(
      buildNotionExportMarkdown([{ project: project(), tasks: [], documents }]),
      '## 링크'
    )
  }

  it('atlassian URL이면 이름에 PRD가 있어도 Ticket 슬롯으로 간다', () => {
    expect(
      linkLines([
        doc({ id: 1, name: 'PRD', url: 'https://notion.so/prd' }),
        doc({ id: 2, name: 'PRD 티켓', url: 'https://backpackr.atlassian.net/browse/ICA-1' })
      ])
    ).toEqual([
      '- **PRD**: [PRD](https://notion.so/prd)',
      '- **Ticket (Epic/상위 작업)**: [PRD 티켓](https://backpackr.atlassian.net/browse/ICA-1)',
      '- **API Interface**:',
      '- **Figma**:',
      '- **WBS**:'
    ])
  })

  it('문서 순서가 반대여도 같은 슬롯에 배정된다', () => {
    expect(
      linkLines([
        doc({ id: 1, name: 'PRD 에픽', url: 'https://backpackr.atlassian.net/browse/ICA-2' }),
        doc({ id: 2, name: 'PRD', url: 'https://notion.so/prd' })
      ])
    ).toEqual([
      '- **PRD**: [PRD](https://notion.so/prd)',
      '- **Ticket (Epic/상위 작업)**: [PRD 에픽](https://backpackr.atlassian.net/browse/ICA-2)',
      '- **API Interface**:',
      '- **Figma**:',
      '- **WBS**:'
    ])
  })

  it('figma.com URL이면 이름 키워드보다 Figma 슬롯이 우선한다', () => {
    expect(linkLines([doc({ id: 1, name: '기획 화면', url: 'https://figma.com/file/x' })])).toEqual([
      '- **PRD**:',
      '- **Ticket (Epic/상위 작업)**:',
      '- **API Interface**:',
      '- **Figma**: [기획 화면](https://figma.com/file/x)',
      '- **WBS**:'
    ])
  })

  it('앞선 매칭 슬롯이 차 있으면 다음 매칭 슬롯으로 내려간다', () => {
    // '기획 디자인'은 PRD와 Figma 모두에 걸린다 — PRD가 이미 차 있으면 Figma로
    expect(
      linkLines([
        doc({ id: 1, name: 'PRD', url: 'u1' }),
        doc({ id: 2, name: '기획 디자인', url: 'u2' })
      ])
    ).toEqual([
      '- **PRD**: [PRD](u1)',
      '- **Ticket (Epic/상위 작업)**:',
      '- **API Interface**:',
      '- **Figma**: [기획 디자인](u2)',
      '- **WBS**:'
    ])
  })
})

describe('여러 프로젝트', () => {
  it('프로젝트 블록을 빈 줄로 이어 붙인다', () => {
    const markdown = buildNotionExportMarkdown([
      { project: project({ id: 1, name: '프로젝트 A' }), tasks: [], documents: [] },
      { project: project({ id: 2, name: '프로젝트 B' }), tasks: [], documents: [] }
    ])
    const topHeadings = markdown.split('\n').filter((line) => line.startsWith('# '))
    expect(topHeadings).toEqual(['# 프로젝트 A', '# 프로젝트 B'])
    expect(markdown).toContain('- **다음에 시도할 것**:\n\n# 프로젝트 B')
  })
})
