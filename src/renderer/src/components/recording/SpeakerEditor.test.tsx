import { describe, it, expect, vi } from 'vitest'
import { isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  nextPresetName,
  buildNamePresets,
  SpeakerVoiceControls,
  speakerVoiceState,
  formatMatchScore,
  VoiceNotice
} from './SpeakerEditor'
import { voiceActionOutcome } from '../../stores/recordingStore'
import type { Attendee } from '../../types'

// 다인 면접에서 '면접관'/'지원자' 프리셋을 여러 화자에 눌렀을 때 이름이 충돌하지 않고
// '면접관 2', '면접관 3'…처럼 다음 빈 번호가 붙는지 고정한다.
describe('nextPresetName', () => {
  it('아무도 쓰지 않는 이름은 그대로 반환한다', () => {
    expect(nextPresetName('면접관', [])).toBe('면접관')
    expect(nextPresetName('지원자', ['면접관'])).toBe('지원자')
  })

  it('이미 쓰이는 이름이면 2부터 번호를 붙인다', () => {
    expect(nextPresetName('면접관', ['면접관'])).toBe('면접관 2')
    expect(nextPresetName('지원자', ['지원자', '면접관'])).toBe('지원자 2')
  })

  it('번호가 이미 쓰여 있으면 다음 빈 번호를 찾는다', () => {
    expect(nextPresetName('면접관', ['면접관', '면접관 2'])).toBe('면접관 3')
    // 중간이 비어 있으면 그 번호를 먼저 채운다
    expect(nextPresetName('면접관', ['면접관', '면접관 3'])).toBe('면접관 2')
  })

  it('공백·빈 이름은 사용 목록에서 무시한다', () => {
    expect(nextPresetName('면접관', ['', '  ', '지원자'])).toBe('면접관')
  })
})

// 화자 이름 프리셋 구성 — 회의는 참석자 이름만, 면접은 역할 프리셋 뒤에 참석자를 붙인다.
describe('buildNamePresets', () => {
  const at = (name: string): Attendee => ({ member_id: 1, name, role: null })

  it('회의는 참석자 이름만 프리셋으로 쓴다', () => {
    expect(buildNamePresets('meeting', [at('홍길동'), at('김철수')])).toEqual(['홍길동', '김철수'])
    expect(buildNamePresets('meeting', [])).toEqual([])
  })

  it('면접은 역할 프리셋 뒤에 참석자 이름을 붙인다', () => {
    expect(buildNamePresets('interview', [at('홍길동')])).toEqual(['면접관', '지원자', '홍길동'])
    // 참석자가 없어도 기존 역할 프리셋은 유지된다
    expect(buildNamePresets('interview', [])).toEqual(['면접관', '지원자'])
  })

  it('빈 이름·중복은 걸러내고 개수를 8개로 자른다', () => {
    expect(buildNamePresets('meeting', [at('홍길동'), at('  '), at('홍길동')])).toEqual(['홍길동'])
    // 역할 프리셋과 같은 이름의 참석자가 있어도 버튼이 두 번 나오지 않는다
    expect(buildNamePresets('interview', [at('면접관')])).toEqual(['면접관', '지원자'])

    const many = Array.from({ length: 12 }, (_, i) => at(`참석자${i}`))
    expect(buildNamePresets('meeting', many)).toHaveLength(8)
  })
})

// ── 목소리 자동 지정·제안·등록 ──
//
// 렌더러 테스트는 DOM 없이 돈다. SpeakerVoiceControls는 훅을 쓰지 않으므로 함수로 직접 불러
// 나온 요소 트리에서 버튼을 찾고 onClick을 호출해 클릭을 흉내 낸다. 마크업은 renderToStaticMarkup.
type Voice = Parameters<typeof SpeakerVoiceControls>[0]['speaker']

const voice = (over: Partial<Voice>): Voice => ({
  display_name: null,
  member_id: null,
  member_source: null,
  match_score: null,
  has_voice: false,
  voice_enrolled: false,
  member_name: null,
  ...over
})

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

function findButtons(node: ReactNode): ReactElement<{ onClick?: (e: unknown) => void; children?: ReactNode }>[] {
  if (node == null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(findButtons)
  if (!isValidElement(node)) return []
  const el = node as ReactElement<{ onClick?: (e: unknown) => void; children?: ReactNode }>
  const own = el.type === 'button' ? [el] : []
  return [...own, ...findButtons(el.props.children)]
}

function setup(speaker: Voice): {
  html: string
  click: (label: string) => void
  onAction: ReturnType<typeof vi.fn>
  labels: string[]
} {
  const onAction = vi.fn()
  const props = { speaker, busy: false, onAction }
  const tree = SpeakerVoiceControls(props) as ReactNode
  const buttons = findButtons(tree)
  return {
    html: renderToStaticMarkup(<SpeakerVoiceControls {...props} />),
    onAction,
    labels: buttons.map((b) => textOf(b)),
    click: (label) => {
      const b = buttons.find((x) => textOf(x) === label)
      if (!b) throw new Error(`버튼 없음: ${label}`)
      const stopPropagation = vi.fn()
      b.props.onClick?.({ stopPropagation })
      // 행 전체가 병합 대상 클릭을 받으므로 버튼 클릭은 위로 새지 않아야 한다
      expect(stopPropagation).toHaveBeenCalled()
    }
  }
}

describe('speakerVoiceState', () => {
  it('구성원 연결 방식과 목소리 유무로 상태를 가른다', () => {
    expect(speakerVoiceState(voice({ member_id: 1, member_source: 'auto', has_voice: true }))).toBe('auto')
    expect(speakerVoiceState(voice({ member_id: 1, member_source: 'suggested', has_voice: true }))).toBe(
      'suggested'
    )
    expect(
      speakerVoiceState(voice({ member_id: 1, member_source: 'manual', has_voice: true, voice_enrolled: true }))
    ).toBe('enrolled')
    // 구성원과 연결됐어도 표본이 실제로 저장되지 않았으면(발화 20초 미만 등) 등록 버튼을 준다
    expect(
      speakerVoiceState(voice({ display_name: '홍길동', member_id: 1, member_source: 'manual', has_voice: true }))
    ).toBe('enrollable')
    expect(speakerVoiceState(voice({ display_name: '홍길동', has_voice: true }))).toBe('enrollable')
    expect(speakerVoiceState(voice({}))).toBeNull()
  })

  it('formatMatchScore는 0~1 점수를 반올림한 퍼센트로 바꾼다', () => {
    expect(formatMatchScore(0.823)).toBe('82%')
    expect(formatMatchScore(1.2)).toBe('100%')
    expect(formatMatchScore(null)).toBeNull()
  })
})

describe('SpeakerVoiceControls', () => {
  it('auto: 점수 배지와 [맞음] [이 사람 아님]을 그리고 각각 confirm/reject를 부른다', () => {
    const t = setup(
      voice({ display_name: '홍길동', member_id: 3, member_source: 'auto', match_score: 0.82, has_voice: true, member_name: '홍길동' })
    )
    expect(t.html).toContain('목소리로 자동 지정 · 82%')
    expect(t.labels).toEqual(['맞음', '이 사람 아님'])
    t.click('맞음')
    expect(t.onAction).toHaveBeenLastCalledWith('confirm')
    t.click('이 사람 아님')
    expect(t.onAction).toHaveBeenLastCalledWith('reject')
    expect(t.onAction).toHaveBeenCalledTimes(2)
  })

  it('suggested: "혹시 OOO?" 문구와 [지정] [아님]을 그린다', () => {
    const t = setup(
      voice({ member_id: 3, member_source: 'suggested', match_score: 0.64, has_voice: true, member_name: '김철수' })
    )
    expect(t.html).toContain('혹시 김철수?')
    expect(t.labels).toEqual(['지정', '아님'])
    t.click('지정')
    expect(t.onAction).toHaveBeenLastCalledWith('confirm')
    t.click('아님')
    expect(t.onAction).toHaveBeenLastCalledWith('reject')
  })

  it('표본이 실제 저장됨(voice_enrolled): "목소리 등록됨"만 보이고 버튼은 없다', () => {
    const t = setup(
      voice({
        display_name: '홍길동',
        member_id: 3,
        member_source: 'manual',
        has_voice: true,
        voice_enrolled: true,
        member_name: '홍길동'
      })
    )
    expect(t.html).toContain('목소리 등록됨')
    expect(t.labels).toEqual([])
  })

  it('[목소리 등록]은 이름이 있고 목소리가 있고 아직 표본이 없을 때만 보인다', () => {
    const t = setup(voice({ display_name: '홍길동', has_voice: true }))
    expect(t.labels).toEqual(['목소리 등록'])
    t.click('목소리 등록')
    expect(t.onAction).toHaveBeenLastCalledWith('enroll')

    // 이름 없음 / 목소리 없음 / 이미 표본 저장됨 → 노출하지 않는다
    expect(setup(voice({ display_name: null, has_voice: true })).html).not.toContain('목소리 등록')
    expect(setup(voice({ display_name: '  ', has_voice: true })).html).not.toContain('목소리 등록')
    expect(setup(voice({ display_name: '홍길동', has_voice: false })).html).not.toContain('목소리 등록')
    expect(
      setup(voice({ display_name: '홍길동', member_id: 3, member_source: 'manual', has_voice: false })).html
    ).toBe('')
    expect(
      setup(voice({ display_name: '홍길동', member_id: 3, member_source: 'manual', has_voice: true, voice_enrolled: true }))
        .labels
    ).toEqual([])
    // 구성원 연결은 됐지만 표본이 없으면 등록 버튼을 준다
    expect(
      setup(voice({ display_name: '홍길동', member_id: 3, member_source: 'manual', has_voice: true })).labels
    ).toEqual(['목소리 등록'])
  })
})

// 목소리 등록·확정 결과 안내 — 발화가 짧아 등록되지 않으면 조용히 끝나지 않고 이유를 알린다.
describe('voiceActionOutcome', () => {
  const SHORT = '발화가 짧아 목소리를 등록할 수 없습니다(20초 이상 필요).'

  it('실패하면 main이 준 사유를 그대로 보여준다', () => {
    expect(voiceActionOutcome('enroll', { success: false, error: SHORT })).toEqual({
      ok: false,
      message: SHORT
    })
  })

  it('사유가 없거나 호출이 throw하면 기본 실패 문구를 쓴다', () => {
    expect(voiceActionOutcome('enroll', { success: false })).toEqual({
      ok: false,
      message: '목소리 등록 실패'
    })
    expect(voiceActionOutcome('confirm', null).ok).toBe(false)
    expect(voiceActionOutcome('reject', null).message).toBeTruthy()
  })

  it('성공했지만 표본을 저장하지 않았으면(enrolled=false) 짧은 발화 안내를 준다', () => {
    const notice = { ok: true, message: '발화가 짧아 목소리는 등록하지 않았습니다.' }
    expect(voiceActionOutcome('enroll', { success: true, enrolled: false })).toEqual(notice)
    expect(voiceActionOutcome('confirm', { success: true, enrolled: false })).toEqual(notice)
  })

  it('정상 등록·거절은 안내가 없다', () => {
    expect(voiceActionOutcome('enroll', { success: true, enrolled: true })).toEqual({ ok: true, message: null })
    expect(voiceActionOutcome('confirm', { success: true })).toEqual({ ok: true, message: null })
    // 거절은 등록과 무관하다
    expect(voiceActionOutcome('reject', { success: true, enrolled: false })).toEqual({ ok: true, message: null })
  })

  it('등록 실패 후에도 화자 상태가 그대로면 [목소리 등록] 버튼이 남고 안내가 보인다', () => {
    // 실패하면 main이 표본을 만들지 않으므로 새로고침 뒤에도 voice_enrolled=false
    const t = setup(voice({ display_name: '홍길동', has_voice: true, voice_enrolled: false }))
    expect(t.labels).toEqual(['목소리 등록'])
    const o = voiceActionOutcome('enroll', { success: false, error: SHORT })
    const html = renderToStaticMarkup(<VoiceNotice ok={o.ok} message={o.message!} />)
    expect(html).toContain(SHORT)
    expect(html).toContain('role="alert"')
    // 참고 안내는 status로 구분한다
    expect(renderToStaticMarkup(<VoiceNotice ok message="x" />)).toContain('role="status"')
  })
})
