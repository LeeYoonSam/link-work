// 작업명 선두의 대괄호 접두사(Jira 키·도메인 태그)를 제목과 분리한다.
// tasks 테이블에 이슈 키 컬럼이 없어 접두사가 name 문자열에 그대로 섞여 있으므로,
// 스키마 변경 없이 렌더 계층에서 배지/제목으로 나누기 위한 순수 파서다.

export interface ParsedTaskLabel {
  /** 선두 대괄호 토큰들. 대괄호 제거 + trim 적용. 없으면 빈 배열 */
  tags: string[]
  /** 접두사를 제거하고 남은 제목 */
  title: string
}

// 대괄호 안이 20자를 넘으면 태그가 아니라 문장의 일부로 본다.
const LEADING_TAG = /^\s*\[([^\]]{1,20})\]\s*/
// `[ICA-8681] [검색홈]`처럼 이중 접두사까지가 실 데이터의 한계였다.
const MAX_TAGS = 3
const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/

/** 작업명에서 선두 대괄호 접두사를 분리한다 */
export function parseTaskLabel(name: string): ParsedTaskLabel {
  if (name.trim() === '') return { tags: [], title: name }

  const tags: string[] = []
  let rest = name
  while (tags.length < MAX_TAGS) {
    const matched = LEADING_TAG.exec(rest)
    if (!matched) break
    const tag = matched[1].trim()
    // 빈 대괄호는 태그로 보지 않고 원문에 남겨 둔다
    if (tag === '') break
    tags.push(tag)
    rest = rest.slice(matched[0].length)
  }

  const title = rest.trim()
  // 접두사를 떼고 나면 제목이 없는 경우 — 배지만 남고 이름이 사라지는 것을 막는다
  if (title === '') return { tags: [], title: name.trim() }
  return { tags, title }
}

/** 태그가 Jira 이슈 키 형태인지 (예: ICA-8678) */
export function isIssueKey(tag: string): boolean {
  return ISSUE_KEY.test(tag)
}
