import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Variable } from '../../types'
import { FIRST_CELL_FOCUS_CLASS, ROW_FOCUS_CLASS, VariableRow } from './VariableList'
import { FOCUS_RING_CLASS } from '../../hooks/useFocusFlash'

// 앱 내 링크 포커스의 DOM id 와 강조 클래스를 정적 HTML 로 검증한다.
// 요청 소비·스크롤은 effect 라서 헤드리스 렌더로 검증하지 않는다.
// 목록 전체는 렌더하지 않는다. 이유: zustand v5 SSR 은 스토어 초기 상태만 그린다
const plain: Variable = {
  id: 4,
  key: 'API_HOST',
  value: 'https://example.com',
  description: null,
  view_type: 'general',
  sort_order: 0,
  created_at: '2026-11-05T10:00:00',
  updated_at: '2026-11-05T10:00:00'
}

const secret: Variable = {
  ...plain,
  id: 5,
  key: 'API_TOKEN',
  value: 'super-secret-value',
  view_type: 'secret'
}

const noop = (): void => {}

function renderRow(v: Variable, highlighted: boolean): string {
  return renderToStaticMarkup(
    <table>
      <tbody>
        <VariableRow
          variable={v}
          highlighted={highlighted}
          revealed={false}
          copied={false}
          dropTarget={false}
          onToggleReveal={noop}
          onCopy={noop}
          onEdit={noop}
          onDelete={noop}
          onDragStart={noop}
          onDragOver={noop}
          onDragEnd={noop}
          onDragLeave={noop}
        />
      </tbody>
    </table>
  )
}

describe('VariableRow 포커스', () => {
  it('highlighted 이면 variable-{id} 행의 셀 배경과 첫 셀 강조선을 붙인다', () => {
    const html = renderRow(plain, true)
    expect(html).toContain('id="variable-4"')
    expect(html).toContain(ROW_FOCUS_CLASS)
    expect(html).toContain(FIRST_CELL_FOCUS_CLASS)
    // <tr> 에는 ring 을 쓰지 않는다. 이유: 브라우저마다 그리지 않을 수 있다
    expect(html).not.toContain(FOCUS_RING_CLASS)
  })

  it('highlighted 가 아니면 강조 클래스를 붙이지 않는다', () => {
    const html = renderRow(plain, false)
    expect(html).toContain('id="variable-4"')
    expect(html).not.toContain(ROW_FOCUS_CLASS)
    expect(html).not.toContain(FIRST_CELL_FOCUS_CLASS)
  })

  it('강조된 secret 행도 값을 공개하지 않는다', () => {
    const html = renderRow(secret, true)
    expect(html).toContain('id="variable-5"')
    expect(html).toContain(ROW_FOCUS_CLASS)
    expect(html).not.toContain('super-secret-value')
    expect(html).toContain('••••••••')
  })
})
