import type { Element, ElementContent, Root, RootContent } from 'hast'
import type { Plugin } from 'unified'

// raw HTML(예: Google Calendar description의 <ul><li>...https://...</li></ul>) 안에서는
// remark-gfm의 자동 링크가 동작하지 않는다(텍스트 노드가 아니라 HTML 블록으로 취급됨).
// 이 플러그인은 rehype-raw로 파싱된 뒤 <a>로 감싸이지 않은 순수 텍스트의 http/https URL을
// 클릭 가능한 <a> 요소로 바꿔 준다. 이미 <a> 내부인 텍스트는 건드리지 않는다.

const URL_REGEX = /https?:\/\/[^\s<>"'`]+/g
const HAS_URL = /https?:\/\//
// URL 끝에 붙는 문장부호는 링크에서 제외 (예: "(https://x)" 의 닫는 괄호)
const TRAILING_PUNCT = /[.,;:!?)\]}'"”’]+$/

function textToNodes(value: string): ElementContent[] {
  const nodes: ElementContent[] = []
  const re = new RegExp(URL_REGEX.source, URL_REGEX.flags)
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(value)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: value.slice(lastIndex, match.index) })
    }
    const url = match[0].replace(TRAILING_PUNCT, '')
    nodes.push({
      type: 'element',
      tagName: 'a',
      properties: { href: url },
      children: [{ type: 'text', value: url }]
    })
    lastIndex = match.index + url.length
    // 뒤에서 잘라낸 문장부호를 다음 텍스트로 다시 스캔하도록 위치 보정
    re.lastIndex = lastIndex
  }

  if (lastIndex < value.length) {
    nodes.push({ type: 'text', value: value.slice(lastIndex) })
  }
  return nodes
}

function transformChildren(
  children: Array<RootContent | ElementContent>,
  insideAnchor: boolean
): Array<RootContent | ElementContent> {
  const next: Array<RootContent | ElementContent> = []
  for (const child of children) {
    if (child.type === 'text' && !insideAnchor && HAS_URL.test(child.value)) {
      next.push(...textToNodes(child.value))
    } else {
      if (child.type === 'element') {
        child.children = transformChildren(
          child.children,
          insideAnchor || child.tagName === 'a'
        ) as ElementContent[]
      }
      next.push(child)
    }
  }
  return next
}

export const rehypeLinkifyBareUrls: Plugin<[], Root> = () => {
  return (tree: Root) => {
    tree.children = transformChildren(tree.children, false) as RootContent[]
  }
}

// Google Calendar는 설명을 <html-blob> 같은 비표준 래퍼로 감싸 보낼 때가 있다.
// sanitize가 그 래퍼를 벗겨내면 빈 <p></p>만 남아 불필요한 빈 줄이 생기고,
// 접힌 미리보기(2줄)를 통째로 잡아먹는다. 내용이 없는 문단은 제거한다.
function hasVisibleContent(node: Element): boolean {
  return node.children.some(
    (child) =>
      (child.type === 'text' && child.value.trim() !== '') || child.type === 'element'
  )
}

function pruneEmpty(
  children: Array<RootContent | ElementContent>
): Array<RootContent | ElementContent> {
  const next: Array<RootContent | ElementContent> = []
  for (const child of children) {
    if (child.type === 'element') {
      child.children = pruneEmpty(child.children) as ElementContent[]
      if (child.tagName === 'p' && !hasVisibleContent(child)) continue
    }
    next.push(child)
  }
  return next
}

export const rehypeStripEmptyParagraphs: Plugin<[], Root> = () => {
  return (tree: Root) => {
    tree.children = pruneEmpty(tree.children) as RootContent[]
  }
}

export default rehypeLinkifyBareUrls

// 테스트용으로 내부 함수 노출
export { textToNodes }
