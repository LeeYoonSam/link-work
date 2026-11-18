import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClampedText, Tooltip } from './index'

// 말줄임의 핵심 불변식: 자르기는 CSS(line-clamp)로만 한다 — JS로 문자열을 자르면
// DOM에서 원문이 사라져 스크린리더가 전체 내용에 영영 접근할 수 없다.
// 렌더 테스트는 기존 dashboard/TodaySchedule.test.tsx와 같이 renderToStaticMarkup을 쓴다.

// 마크업에서 태그를 걷어낸 순수 텍스트 (실제로 사용자가 읽게 되는 글자들)
const textOf = (html: string): string => html.replace(/<[^>]*>/g, '')

const JIRA_NAME =
  '[PROJ-1636] 바이럴 작품 상세 잔여 Rx 제거 + UpdateFavoriteUseCase dual-track 신설'

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

  // 조상이 이미 포커스 가능한 곳(role="button" tabIndex=0 인 행)에서
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

// className에 display 유틸리티를 넘기면 line-clamp의 -webkit-box가 덮여 자르기가 조용히 풀린다.
describe('className과 line-clamp', () => {
  it('clamp 클래스가 className보다 먼저 와도 line-clamp-2가 마크업에 남는다', () => {
    const html = renderToStaticMarkup(
      <ClampedText text={JIRA_NAME} lines={2} className="text-sm text-gray-800" />
    )
    expect(html).toContain('line-clamp-2')
  })
})

describe('focusable 통과 경로', () => {
  it('ClampedText가 focusable을 Tooltip까지 넘긴다', () => {
    // 서버 렌더에서는 항상 clamped=false라 Tooltip이 붙지 않는다.
    // prop이 타입상 연결돼 있고 렌더가 깨지지 않는지만 확인한다.
    expect(() =>
      renderToStaticMarkup(<ClampedText text={JIRA_NAME} focusable={false} />)
    ).not.toThrow()
  })
})
