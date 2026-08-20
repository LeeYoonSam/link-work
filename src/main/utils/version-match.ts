// LinkWork의 deploy_version과 Jira 릴리스(Version) 이름을 맞춰보기 위한 비교 규칙.
//
// 실측상 두 값은 접두사 없이 그대로 일치한다(`4.164.0` ↔ `4.164.0`). 아래 정규화는
// 표기 흔들림에 대한 **안전망일 뿐 추측 매칭이 아니다** — 잘못 연결되면 엉뚱한 릴리스 노트가
// 만들어지고, 그게 진짜 릴리스 노트처럼 보여서 사용자가 알아채기 어렵다.
// 그래서 `4.164.0`과 `4.164`처럼 "아마 같을 것"인 쌍은 의도적으로 다르다고 판정한다.

/** 버전 이름 비교용 정규화 — 앞뒤 공백 제거, 선행 v/V 제거, 소문자화 */
export function normalizeVersionName(name: string): string {
  return name.trim().replace(/^[vV]/, '').trim().toLowerCase()
}

/** deploy_version과 Jira 버전 이름이 같은 릴리스를 가리키는지 */
export function isSameVersion(a: string, b: string): boolean {
  const left = normalizeVersionName(a)
  // 빈 문자열끼리는 "둘 다 버전이 없다"는 뜻이지 같은 릴리스라는 뜻이 아니다.
  if (left === '') return false
  return left === normalizeVersionName(b)
}
