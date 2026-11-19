// 테스트 전용: React 요소 트리를 펼쳐 호스트 요소(button·input 등)를 모은다.
// 이 저장소에는 DOM 테스트 환경이 없다. 그래서 컴포넌트를 함수로 직접 불러 반환 트리의 핸들러를 부른다.
// 훅을 쓰는 컴포넌트는 테스트 파일에서 react 의 훅을 단순 구현으로 바꾼 뒤 써야 한다(IssueTree.keyboard.test 참고).
import { isValidElement, type ReactElement, type ReactNode } from 'react'

export type AnyElement = ReactElement<Record<string, unknown> & { children?: ReactNode }>

/** 함수 컴포넌트를 불러 펼치고 호스트 요소를 문서 순서로 모은다 */
export function collect(node: ReactNode, out: AnyElement[] = []): AnyElement[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') return out
  if (Array.isArray(node)) {
    for (const n of node) collect(n as ReactNode, out)
    return out
  }
  if (!isValidElement(node)) return out
  const el = node as AnyElement
  if (typeof el.type === 'function') {
    collect((el.type as (p: unknown) => ReactNode)(el.props), out)
    return out
  }
  if (typeof el.type === 'string') out.push(el)
  collect(el.props.children, out)
  return out
}

/** 요소 아래 글자를 이어 붙인다(함수 컴포넌트도 펼친다) */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') return String(node)
  if (Array.isArray(node)) return node.map((n) => textOf(n as ReactNode)).join('')
  if (!isValidElement(node)) return ''
  const el = node as AnyElement
  if (typeof el.type === 'function') return textOf((el.type as (p: unknown) => ReactNode)(el.props))
  return textOf(el.props.children)
}

/** 글자가 text 를 포함하는 첫 button */
export function findButton(root: ReactNode, text: string): AnyElement {
  const btn = collect(root).find((e) => e.type === 'button' && textOf(e).includes(text))
  if (!btn) throw new Error(`button not found: ${text}`)
  return btn
}

/** 클릭 핸들러를 부른다 */
export function click(el: AnyElement): void {
  const fn = el.props.onClick as ((e: unknown) => void) | undefined
  if (!fn) throw new Error('onClick 없음')
  fn({ stopPropagation: () => {}, preventDefault: () => {} })
}
