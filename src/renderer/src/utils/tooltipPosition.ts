// 툴팁 말풍선의 화면 좌표 계산. DOM 없이 순수 계산만 하도록 떼어냈다.
// 뒤집기·clamp는 레이아웃 값에 의존해 jsdom에서 검증할 수 없는데(rect가 전부 0),
// 좌표 계산만 분리하면 실제 회귀가 났던 부분을 단위 테스트로 막을 수 있다.

/** 뷰포트 가장자리와 말풍선 사이 최소 여백 */
export const TOOLTIP_MARGIN = 8

export interface TriggerRect {
  top: number
  bottom: number
  left: number
}

export interface TooltipSize {
  width: number
  /** 트리거와의 간격을 덮는 투명 다리를 포함한 높이 */
  height: number
}

export interface Viewport {
  width: number
  height: number
}

export interface TooltipPlacement {
  top: number
  left: number
  /** 트리거 아래로 뒤집혔는지. 투명 다리를 붙일 방향을 정한다 */
  below: boolean
}

/**
 * 말풍선을 트리거 위에 두되, 위 공간이 모자라면 아래로 뒤집고 뷰포트 안으로 당긴다.
 * height에 투명 다리가 포함돼 있어 간격을 따로 더하지 않는다.
 */
export function placeTooltip(
  trigger: TriggerRect,
  tip: TooltipSize,
  viewport: Viewport,
  margin: number = TOOLTIP_MARGIN
): TooltipPlacement {
  const above = trigger.top - tip.height
  const below = above < margin
  const maxLeft = viewport.width - tip.width - margin
  // 아래로 뒤집은 뒤 하단이 넘치는 경우가 있다. 말풍선이 뷰포트보다 크면
  // max/min이 뒤집히므로 시작 여백을 마지막에 한 번 더 우선시킨다.
  const maxTop = viewport.height - tip.height - margin
  return {
    top: Math.max(margin, Math.min(below ? trigger.bottom : above, maxTop)),
    left: Math.max(margin, Math.min(trigger.left, maxLeft)),
    below
  }
}
