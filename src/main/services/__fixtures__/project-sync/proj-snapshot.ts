// 프로젝트 싱크업 픽스처 — 일반적인 Jira 프로젝트 형태를 본뜬 가상 데이터다.
// 이슈 타입(에픽/작업/하위 작업), 상태 이름(할 일·처리중·완료), Sustain·QA 에픽 요약 패턴을 싱크업 규칙에 맞춰 구성했다.
import type { JiraSyncIssue } from '../../jira'
import type { JiraSyncSnapshot } from '../../project-sync-plan'

export const SITE_URL = 'https://acme.atlassian.net'
export const ME = 'acc-me'
export const OTHER = 'acc-other'

const STATUS = {
  todo: { status: '할 일', statusCategory: 'new' },
  backlog: { status: '백로그', statusCategory: 'new' },
  doing: { status: '처리중', statusCategory: 'indeterminate' },
  done: { status: '완료', statusCategory: 'done' }
} as const

const TYPE = {
  epic: { issueType: '에픽', level: 'epic' },
  task: { issueType: '작업', level: 'standard' },
  subtask: { issueType: '하위 작업', level: 'subtask' }
} as const

export function issue(
  key: string,
  summary: string,
  type: keyof typeof TYPE,
  status: keyof typeof STATUS,
  overrides: Partial<JiraSyncIssue> = {}
): JiraSyncIssue {
  return {
    key,
    summary,
    ...TYPE[type],
    ...STATUS[status],
    parentKey: null,
    assigneeAccountId: ME,
    duedate: null,
    labels: [],
    description: null,
    issueLinks: [],
    ...overrides
  }
}

/** 알림센터 에픽 설명 — link mark, inlineCard, 본문 텍스트 URL이 섞여 있다 */
export const NOTICE_DESCRIPTION = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: '알림센터를 개편한다.' }]
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: '기획서',
          marks: [{ type: 'link', attrs: { href: 'https://www.notion.so/acme/notice-spec' } }]
        },
        { type: 'text', text: ' / 디자인 ' },
        { type: 'inlineCard', attrs: { url: 'https://www.figma.com/design/abc123/Notice' } }
      ]
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: '회의록: https://docs.google.com/document/d/xyz/edit. 위키 https://acme.atlassian.net/wiki/spaces/APP/pages/1'
        }
      ]
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: '위험 링크 javascript:alert(1) ftp://files.example.com/a' }]
    }
  ]
}

/**
 * 시나리오
 * - 일반 에픽 PROJ-1855(처리중) 아래 할 일 작업·하위 작업이 트리거 → 에픽 1개 = 프로젝트 1개
 * - Sustain 에픽 PROJ-1892 아래 할 일 작업 2개가 트리거 → 작업 각각이 프로젝트
 * - QA 에픽 PROJ-8054의 하위 작업, QA 타입 이슈 → 제외
 * - 에픽 없는 작업 PROJ-2000 → no_epic
 */
export function projSnapshot(): JiraSyncSnapshot {
  const issues: JiraSyncIssue[] = [
    // 일반 에픽
    issue('PROJ-1855', '알림센터 개편', 'epic', 'doing', {
      description: NOTICE_DESCRIPTION,
      duedate: '2099-12-31',
      issueLinks: [{ type: 'Relates', key: 'PROJ-1700', summary: '알림 기획' }]
    }),
    issue('PROJ-1856', '알림센터 API 연동', 'task', 'todo', { parentKey: 'PROJ-1855' }),
    issue('PROJ-1860', 'API 모델 정의', 'subtask', 'done', { parentKey: 'PROJ-1856' }),
    issue('PROJ-1861', '화면 바인딩', 'subtask', 'todo', {
      parentKey: 'PROJ-1856',
      duedate: '2026-10-20'
    }),
    issue('PROJ-1857', '알림센터 UI', 'task', 'doing', {
      parentKey: 'PROJ-1855',
      assigneeAccountId: null
    }),
    issue('PROJ-1858', '알림센터 서버', 'task', 'todo', {
      parentKey: 'PROJ-1855',
      assigneeAccountId: OTHER
    }),
    issue('PROJ-1859', '[포인트] 셀프 QA', 'task', 'backlog', { parentKey: 'PROJ-1855' }),
    issue('PROJ-1862', '알림센터 검수', 'task', 'todo', { parentKey: 'PROJ-1855', labels: ['qa'] }),

    // Sustain 에픽 — 에픽 자신도 내게 할당된 할 일이지만 프로젝트가 되지 않는다
    issue('PROJ-1892', '[Android/Sus] Sprint 10', 'epic', 'todo'),
    issue('PROJ-1893', '상품 상세 크래시 수정', 'task', 'todo', {
      parentKey: 'PROJ-1892',
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Crashlytics 상위 크래시' }] }]
      }
    }),
    issue('PROJ-1894', '원인 분석', 'subtask', 'done', { parentKey: 'PROJ-1893' }),
    issue('PROJ-1896', '수정 배포', 'subtask', 'todo', { parentKey: 'PROJ-1893' }),
    issue('PROJ-1895', '로그 개선', 'task', 'todo', { parentKey: 'PROJ-1892' }),

    // QA 에픽
    issue('PROJ-1054', '안드로이드QA-2099', 'epic', 'doing'),
    issue('PROJ-1100', 'v1.0.0 QA', 'task', 'doing', { parentKey: 'PROJ-1054' }),
    issue('PROJ-1101', '안드로이드 앱 v1.0.0 QA', 'subtask', 'todo', {
      parentKey: 'PROJ-1100'
    }),

    // QA 타입 이슈
    issue('PROJ-2001', '회귀 테스트', 'task', 'todo', { issueType: 'QA' }),

    // 에픽 없는 작업
    issue('PROJ-2000', '에픽 없는 작업', 'task', 'todo')
  ]

  return {
    siteUrl: SITE_URL,
    myAccountId: ME,
    triggerKeys: [
      'PROJ-1856',
      'PROJ-1861',
      'PROJ-1892',
      'PROJ-1893',
      'PROJ-1895',
      'PROJ-1101',
      'PROJ-2001',
      'PROJ-2000'
    ],
    issues,
    remoteLinks: {
      'PROJ-1855': [
        { title: '알림센터 PRD', url: 'https://www.notion.so/acme/notice-prd' },
        // 이슈 본인 browse 링크와 끝 슬래시만 다른 중복 — 하나만 남아야 한다
        { title: '자기 자신', url: `${SITE_URL}/browse/PROJ-1855/` }
      ]
    },
    truncated: false,
    fetchedAt: '2026-10-02T00:00:00.000Z'
  }
}
