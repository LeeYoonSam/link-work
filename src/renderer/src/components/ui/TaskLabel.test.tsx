import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TaskLabel, ClampedText, Tooltip } from './index'

// 작업명 말줄임 개선의 핵심 불변식을 지킨다.
// 1) 자르기는 CSS(line-clamp)로만 한다 — JS로 문자열을 자르면 DOM에서 원문이 사라져
//    스크린리더가 전체 내용에 영영 접근할 수 없다.
// 2) 대괄호 접두사(Jira 키·도메인 태그)는 칩으로 떼어내 제목이 쓸 폭을 넓힌다.
// 렌더 테스트는 기존 dashboard/TodaySchedule.test.tsx와 같이 renderToStaticMarkup을 쓴다.

// 마크업에서 태그를 걷어낸 순수 텍스트 (실제로 사용자가 읽게 되는 글자들)
const textOf = (html: string): string => html.replace(/<[^>]*>/g, '')

const JIRA_NAME =
  '[ICA-8636] 바이럴 작품 상세 잔여 Rx 제거 + UpdateFavoriteUseCase dual-track 신설'
const JIRA_TITLE = '바이럴 작품 상세 잔여 Rx 제거 + UpdateFavoriteUseCase dual-track 신설'
const DOUBLE_TAG_NAME = '[ICA-8681] [검색홈] 트렌드 검색어 가로 스크롤 크래시 수정'
const PLAIN_NAME = 'd+즉시할인 - 적립금 전환 관련 PRD 리뷰'

describe('TaskLabel', () => {
  it('Jira 키가 붙은 작업명의 원문을 한 글자도 잃지 않는다', () => {
    const text = textOf(renderToStaticMarkup(<TaskLabel name={JIRA_NAME} />))
    // 접두사는 칩으로, 제목은 본문으로 — 둘을 합치면 원문의 모든 글자가 남는다
    expect(text).toContain('ICA-8636')
    expect(text).toContain(JIRA_TITLE)
    // JS 절단의 흔적(말줄임표)이 DOM에 들어가지 않는다
    expect(text).not.toContain('…')
    expect(text).not.toContain('...')
  })

  it('접두사가 두 개여도 각각 칩으로 분리하고 제목을 보존한다', () => {
    const text = textOf(renderToStaticMarkup(<TaskLabel name={DOUBLE_TAG_NAME} />))
    expect(text).toContain('ICA-8681')
    expect(text).toContain('검색홈')
    expect(text).toContain('트렌드 검색어 가로 스크롤 크래시 수정')
    // 대괄호는 칩 배경이 대신하므로 텍스트로 남기지 않는다
    expect(text).not.toContain('[ICA-8681]')
  })

  it('1줄 말줄임(truncate)을 쓰지 않는다', () => {
    const html = renderToStaticMarkup(<TaskLabel name={JIRA_NAME} />)
    expect(html).not.toContain('truncate')
  })

  it('기본 2줄 line-clamp로 자른다', () => {
    expect(renderToStaticMarkup(<TaskLabel name={JIRA_NAME} />)).toContain('line-clamp-2')
  })

  it('lines=1이면 1줄 line-clamp를 쓴다', () => {
    const html = renderToStaticMarkup(<TaskLabel name={JIRA_NAME} lines={1} />)
    expect(html).toContain('line-clamp-1')
    expect(html).not.toContain('line-clamp-2')
  })

  it('접두사가 없는 작업명도 원문 그대로 렌더한다', () => {
    const html = renderToStaticMarkup(<TaskLabel name={PLAIN_NAME} />)
    expect(textOf(html)).toContain(PLAIN_NAME)
    // 빈 칩 자리를 만들지 않는다
    // 칩 전용 배경 토큰으로 확인한다 — text-[10px]는 칩 밖에서도 쓰여 의도를 표현하지 못한다
    expect(html).not.toContain('bg-indigo-50')
    expect(html).not.toContain('bg-slate-100')
  })

  it('Jira 키 칩과 도메인 태그 칩의 스타일을 구분한다', () => {
    const jira = renderToStaticMarkup(<TaskLabel name="[ICA-8681] 수정" />)
    const domain = renderToStaticMarkup(<TaskLabel name="[검색홈] 수정" />)
    expect(jira).toContain('font-mono')
    expect(domain).not.toContain('font-mono')
  })

  it('leading 클래스를 잘리는 요소에 그대로 얹는다', () => {
    const html = renderToStaticMarkup(<TaskLabel name={JIRA_NAME} leading="leading-[14px]" />)
    expect(html).toContain('leading-[14px]')
  })
})

describe('ClampedText', () => {
  it('서버 렌더에서 예외 없이 원문을 그대로 낸다', () => {
    const html = renderToStaticMarkup(<ClampedText text={JIRA_NAME} lines={3} />)
    expect(html).toContain('line-clamp-3')
    expect(textOf(html)).toContain(JIRA_NAME)
  })

  it('children이 있으면 그것을 렌더하고 text는 툴팁 원문으로만 쓴다', () => {
    const html = renderToStaticMarkup(
      <ClampedText text={JIRA_NAME}>
        <b>대체 표시</b>
      </ClampedText>
    )
    expect(html).toContain('대체 표시')
    // 측정 전에는 "안 잘림" 상태 — 툴팁이 붙지 않는다
    expect(html).not.toContain('role="tooltip"')
  })
})

describe('Tooltip', () => {
  it('서버 렌더에서 예외 없이 트리거를 내고, 툴팁은 닫힌 상태로 시작한다', () => {
    const html = renderToStaticMarkup(<Tooltip content="숨은 설명">라벨</Tooltip>)
    expect(html).toContain('라벨')
    expect(html).not.toContain('숨은 설명')
    expect(html).not.toContain('role="tooltip"')
  })

  it('키보드로 도달할 수 있도록 트리거를 포커스 가능하게 만든다', () => {
    const html = renderToStaticMarkup(<Tooltip content="숨은 설명">라벨</Tooltip>)
    expect(html).toContain('tabindex="0"')
  })

  // 조상이 이미 포커스 가능한 곳(대시보드 TODO 행: role="button" tabIndex=0)에서
  // 트리거까지 포커스를 받으면 탭 정지점이 중첩되고 ARIA 위반이 된다.
  it('focusable=false면 탭 정지점을 만들지 않는다', () => {
    const html = renderToStaticMarkup(
      <Tooltip content="숨은 설명" focusable={false}>
        라벨
      </Tooltip>
    )
    expect(html).not.toContain('tabindex')
    expect(html).toContain('라벨')
  })
})

// 브라우저 검증 중 발견: className에 display 유틸리티를 넘기면 line-clamp의
// -webkit-box가 덮여 자르기가 조용히 풀린다(scrollHeight === clientHeight).
// 손으로 적은 목록과 대조하면 소비처가 늘거나 바뀔 때 조용히 통과하므로 소스를 직접 읽는다.
describe('소비처가 line-clamp의 display를 덮지 않는다', () => {
  const DISPLAY_UTILS = /\b(block|flex|inline-flex|inline-block|grid|contents)\b/
  const CONSUMERS = [
    '../project/ScheduleTimeline.tsx',
    '../project/TaskList.tsx',
    '../dashboard/Dashboard.tsx'
  ]

  // <TaskLabel .../> · <ClampedText .../>에 넘어가는 className 표현식만 뽑는다.
  // 래퍼 div의 `flex-1 min-w-0`까지 훑으면 오탐이 난다(\bflex\b가 flex-1에 걸린다).
  const clampConsumerClassNames = (src: string): string[] => {
    const found: string[] = []
    for (const el of src.matchAll(/<(?:TaskLabel|ClampedText)\b([\s\S]*?)\/>/g)) {
      const cn = /className=(?:"([^"]*)"|\{([\s\S]*?)\}\s*(?:\n|\/>|[a-zA-Z]))/.exec(el[1])
      if (cn) found.push(cn[1] ?? cn[2])
    }
    return found
  }

  it('소비처가 넘기는 className에 display 유틸리티가 없다', () => {
    let total = 0
    for (const rel of CONSUMERS) {
      const src = readFileSync(resolve(__dirname, rel), 'utf-8')
      const names = clampConsumerClassNames(src)
      for (const cls of names) expect(cls, `${rel}: ${cls}`).not.toMatch(DISPLAY_UTILS)
      total += names.length
    }
    // 정규식이 조용히 0건을 반환하면 검사가 무력해진다
    expect(total).toBeGreaterThanOrEqual(CONSUMERS.length)
  })

  it('clamp 클래스가 className보다 먼저 와도 line-clamp-2가 마크업에 남는다', () => {
    const html = renderToStaticMarkup(
      <ClampedText text={JIRA_NAME} lines={2} className="text-sm text-gray-800" />
    )
    expect(html).toContain('line-clamp-2')
  })
})

describe('focusable 통과 경로', () => {
  it('TaskLabel과 ClampedText가 focusable을 Tooltip까지 넘긴다', () => {
    // 서버 렌더에서는 항상 clamped=false라 Tooltip이 붙지 않는다.
    // prop이 타입상 연결돼 있고 렌더가 깨지지 않는지만 확인한다.
    expect(() =>
      renderToStaticMarkup(<TaskLabel name={JIRA_NAME} focusable={false} />)
    ).not.toThrow()
    expect(() =>
      renderToStaticMarkup(<ClampedText text={JIRA_NAME} focusable={false} />)
    ).not.toThrow()
  })
})
