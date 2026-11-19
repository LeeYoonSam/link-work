// Jira 릴리스(Version) 이름 정렬 규칙.

/** 버전 이름 비교용 정규화 — 앞뒤 공백 제거, 선행 v/V 제거, 소문자화 */
function normalizeVersionName(name: string): string {
  return name.trim().replace(/^[vV]/, '').trim().toLowerCase()
}

/**
 * 버전 이름을 숫자 마디로 쪼갠다. `4.166.0` → `{ parts: [4, 166, 0], suffix: '' }`.
 * 선행이 숫자가 아니면(예: `Q3 릴리스`) 버전으로 보지 않고 빈 배열을 준다.
 */
function parseVersion(name: string): { parts: number[]; suffix: string } {
  const normalized = normalizeVersionName(name)
  const matched = /^(\d+(?:\.\d+)*)(.*)$/.exec(normalized)
  if (!matched) return { parts: [], suffix: normalized }
  return { parts: matched[1].split('.').map(Number), suffix: matched[2].trim() }
}

/**
 * 버전 이름 내림차순 비교자 — 높은 버전이 먼저 온다. `Array.prototype.sort`에 그대로 넘긴다.
 *
 * **문자열 비교로는 안 된다.** `4.46.0`과 `4.166.0`을 사전순으로 재면 `4.46.0`이 더 커서
 * 낮은 버전이 목록 맨 위에 앉는다. 마디를 숫자로 바꿔 앞에서부터 비교해야 한다.
 * 마디 수가 다르면(`4.166` vs `4.166.0`) 없는 자리를 0으로 채운다.
 *
 * 규칙을 좁게 잡은 곳:
 * - 마디가 같고 접미사만 다르면(`4.166.0` vs `4.166.0-rc1`) 접미사가 **없는** 쪽을 높게 본다.
 *   정식 릴리스가 후보(rc)보다 위라는 semver 규칙과 같은 방향이다.
 * - 숫자로 시작하지 않는 이름은 버전이 아니라고 보고 전부 뒤로 보낸 뒤 이름순으로 세운다.
 *   억지로 숫자를 뽑아내면 `2026 Q3` 같은 이름이 버전 4.x보다 위로 올라간다.
 */
export function compareVersionDesc(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)

  // 버전 형식이 아닌 이름은 목록 끝으로 몰고, 그들끼리는 이름순으로 둔다.
  if (left.parts.length === 0 || right.parts.length === 0) {
    if (left.parts.length === right.parts.length) return left.suffix.localeCompare(right.suffix)
    return left.parts.length === 0 ? 1 : -1
  }

  const depth = Math.max(left.parts.length, right.parts.length)
  for (let i = 0; i < depth; i++) {
    const diff = (right.parts[i] ?? 0) - (left.parts[i] ?? 0)
    if (diff !== 0) return diff
  }

  if (left.suffix === right.suffix) return 0
  if (left.suffix === '') return -1
  if (right.suffix === '') return 1
  return right.suffix.localeCompare(left.suffix)
}
