import { describe, it, expect } from 'vitest'
import { applyGlossary, buildAliasMatchers, type GlossaryRule } from './glossary-correct'
import type { SttSegment } from '../meeting-types'

const seg = (text: string, start = 0): SttSegment => ({
  start_ms: start,
  end_ms: start + 1000,
  text
})

const textsOf = (segments: SttSegment[]): string[] => segments.map((s) => s.text)

describe('buildAliasMatchers', () => {
  it('2자 미만 alias는 무시한다', () => {
    expect(buildAliasMatchers([{ term: 'WBS', aliases: ['더', 'w', ' ', ''] }])).toEqual([])
  })

  it('term과 대소문자 무시 동일한 alias는 무시한다', () => {
    const m = buildAliasMatchers([{ term: 'Jira', aliases: ['jira', 'JIRA', '지라'] }])
    expect(m).toHaveLength(1)
    expect(m[0].term).toBe('Jira')
  })

  it('긴 alias부터 적용하도록 정렬한다', () => {
    const m = buildAliasMatchers([{ term: '스프린트 플래닝', aliases: ['스프린트', '스프린트플래닝'] }])
    expect(m.map((x) => x.regex.source)).toEqual([
      '스\\s?프\\s?린\\s?트\\s?플\\s?래\\s?닝',
      '스\\s?프\\s?린\\s?트'
    ])
  })

  it('같은 alias가 여러 term에 있으면 먼저 등록된 규칙이 이긴다', () => {
    const m = buildAliasMatchers([
      { term: 'Alpha', aliases: ['에이'] },
      { term: 'Beta', aliases: ['에이'] }
    ])
    expect(m).toHaveLength(1)
    expect(m[0].term).toBe('Alpha')
  })
})

describe('applyGlossary', () => {
  const linkwork: GlossaryRule[] = [{ term: 'LinkWork', aliases: ['링크워크', 'link'] }]

  it('라틴 alias는 단어 경계 안에서만 치환한다', () => {
    const r = applyGlossary([seg('linkage 서비스와 link 앱')], [{ term: 'LinkWork', aliases: ['link'] }])
    // "linkage" 안의 link는 다른 단어의 일부이므로 건드리지 않는다.
    expect(textsOf(r.segments)).toEqual(['linkage 서비스와 LinkWork 앱'])
    expect(r.replacements).toBe(1)
  })

  it('앞 단어의 일부인 라틴 alias는 치환하지 않는다', () => {
    // 후행 경계만으로는 못 막는 경우 — "hyperlink"/"backlink"의 link는 뒤가 공백이라
    // 선행 경계(lookbehind)가 없으면 통째로 치환된다.
    const input = [seg('hyperlink 와 backlink 를 봤다')]
    const r = applyGlossary(input, [{ term: 'LinkWork', aliases: ['link'] }])
    expect(textsOf(r.segments)).toEqual(['hyperlink 와 backlink 를 봤다'])
    expect(r.replacements).toBe(0)
  })

  it('한글 alias는 조사가 붙어도 치환한다', () => {
    const r = applyGlossary([seg('링크워크를 씁니다')], linkwork)
    expect(textsOf(r.segments)).toEqual(['LinkWork를 씁니다'])
    expect(r.replacements).toBe(1)
  })

  it('한글 alias의 띄어쓰기 변형도 치환한다', () => {
    const r = applyGlossary([seg('링크 워크에서 확인했습니다')], linkwork)
    expect(textsOf(r.segments)).toEqual(['LinkWork에서 확인했습니다'])
    expect(r.replacements).toBe(1)
  })

  it('2자 미만 alias는 무시해 아무것도 바꾸지 않는다', () => {
    const input = [seg('더블유비에스 일정')]
    const r = applyGlossary(input, [{ term: 'WBS', aliases: ['더'] }])
    expect(r.replacements).toBe(0)
    expect(r.segments).toBe(input)
  })

  it('term과 같은 alias는 무시한다(자기 자신 치환 없음)', () => {
    const input = [seg('Jira 티켓을 만들었습니다')]
    const r = applyGlossary(input, [{ term: 'Jira', aliases: ['Jira', 'JIRA'] }])
    expect(r.replacements).toBe(0)
    expect(textsOf(r.segments)).toEqual(['Jira 티켓을 만들었습니다'])
  })

  it('긴 alias를 먼저 적용해 짧은 alias가 결과를 다시 갉아먹지 않는다', () => {
    const r = applyGlossary(
      [seg('스프린트플래닝 회의를 했습니다')],
      [{ term: '스프린트 플래닝', aliases: ['스프린트', '스프린트플래닝'] }]
    )
    expect(textsOf(r.segments)).toEqual(['스프린트 플래닝 회의를 했습니다'])
    expect(r.replacements).toBe(1)
  })

  it('이미 정답 표기인 텍스트는 바꾸지 않고 원본 객체를 그대로 돌려준다', () => {
    const input = [seg('LinkWork 회의를 했습니다')]
    const r = applyGlossary(input, linkwork)
    expect(r.replacements).toBe(0)
    expect(r.segments[0]).toBe(input[0])
  })

  it('alias가 term을 부분 포함해도 이미 있는 term 쪽을 보호한다', () => {
    const input = [seg('WBS 표를 확인했습니다')]
    const r = applyGlossary(input, [{ term: 'WBS', aliases: ['WBS 표', '더블유비에스'] }])
    expect(textsOf(r.segments)).toEqual(['WBS 표를 확인했습니다'])
    expect(r.replacements).toBe(0)
  })

  it('replacements는 세그먼트·발생 횟수를 모두 합산한다', () => {
    const r = applyGlossary(
      [seg('링크워크와 링크 워크는 같은 말입니다'), seg('지라 티켓', 1000), seg('무관한 문장', 2000)],
      [
        { term: 'LinkWork', aliases: ['링크워크'] },
        { term: 'Jira', aliases: ['지라'] }
      ]
    )
    expect(textsOf(r.segments)).toEqual([
      'LinkWork와 LinkWork는 같은 말입니다',
      'Jira 티켓',
      '무관한 문장'
    ])
    expect(r.replacements).toBe(3)
  })

  it('세그먼트의 다른 필드는 보존하고 변경된 것만 새 객체로 만든다', () => {
    const input: SttSegment[] = [
      { start_ms: 100, end_ms: 900, text: '링크워크 배포', confidence: 0.87 }
    ]
    const r = applyGlossary(input, linkwork)
    expect(r.segments[0]).toEqual({
      start_ms: 100,
      end_ms: 900,
      text: 'LinkWork 배포',
      confidence: 0.87
    })
    expect(r.segments[0]).not.toBe(input[0])
  })

  it('규칙이 없으면 입력 배열을 그대로 반환한다', () => {
    const input = [seg('아무 문장')]
    expect(applyGlossary(input, []).segments).toBe(input)
    expect(applyGlossary(input, [{ term: 'X', aliases: [] }]).replacements).toBe(0)
  })
})
