import { describe, it, expect } from 'vitest'
import { combineTwoStage } from './two-stage'
import type { DiarTurn } from '../meeting-types'

// 헬퍼: 간결하게 turn 생성
const turn = (start: number, end: number, key: string): DiarTurn => ({
  start_ms: start,
  end_ms: end,
  speaker_key: key
})

describe('combineTwoStage', () => {
  it('mic 라벨 turn은 시간·키가 불변이고, system 구간은 sherpa 클러스터별로 sys_N으로 분리한다', () => {
    // channel: mic/system 교대. system 안에 상대 A/B 두 명이 섞여 있다.
    const channelTurns: DiarTurn[] = [
      turn(0, 1000, 'mic'),
      turn(1000, 2000, 'system'), // 상대 A
      turn(2000, 3000, 'mic'),
      turn(3000, 4000, 'system'), // 상대 B
      turn(4000, 5000, 'system') // 상대 A 재등장
    ]
    // sherpa(전체 mono 클러스터): spk_0=나, spk_1=상대A, spk_2=상대B
    const sherpaTurns: DiarTurn[] = [
      turn(0, 1000, 'spk_0'),
      turn(2000, 3000, 'spk_0'),
      turn(1000, 2000, 'spk_1'),
      turn(4000, 5000, 'spk_1'),
      turn(3000, 4000, 'spk_2')
    ]

    const result = combineTwoStage(channelTurns, sherpaTurns)

    // mic turn 불변 (시간·키 그대로)
    expect(result[0]).toEqual(turn(0, 1000, 'mic'))
    expect(result[2]).toEqual(turn(2000, 3000, 'mic'))

    // system 구간이 클러스터별로 분리 + 등장 순 재번호 (spk_1→sys_0, spk_2→sys_1)
    expect(result[1].speaker_key).toBe('sys_0')
    expect(result[3].speaker_key).toBe('sys_1')
    // 같은 클러스터(spk_1)는 같은 sys 번호를 재사용
    expect(result[4].speaker_key).toBe('sys_0')

    // 시간 경계는 채널 turn 그대로 유지
    expect(result[1].start_ms).toBe(1000)
    expect(result[1].end_ms).toBe(2000)

    // 최종 화자 3명: 나 + 상대 2명
    expect(new Set(result.map((t) => t.speaker_key)).size).toBe(3)
  })

  it('system 구간의 최대 겹침이 나 클러스터면 차선(비-나) 클러스터로 귀속한다', () => {
    const channelTurns: DiarTurn[] = [
      turn(0, 2000, 'mic'),
      turn(2000, 3000, 'system'), // 나 클러스터와 더 많이 겹치지만 상대여야 함
      turn(5000, 6000, 'system')
    ]
    const sherpaTurns: DiarTurn[] = [
      turn(0, 2000, 'spk_0'), // 나 클러스터(mic 시간과 겹침 최대)
      turn(1900, 2800, 'spk_0'), // system turn과도 크게 겹침(800ms)
      turn(2800, 3200, 'spk_1'), // system turn과 차선 겹침(200ms)
      turn(5000, 6000, 'spk_2')
    ]

    const result = combineTwoStage(channelTurns, sherpaTurns)

    // t1의 최대 겹침은 나 클러스터(spk_0)지만, 차선 spk_1으로 귀속되어야 한다.
    expect(result[1].speaker_key).toBe('sys_0') // spk_1 → sys_0
    expect(result[2].speaker_key).toBe('sys_1') // spk_2 → sys_1
    expect(result[0].speaker_key).toBe('mic')
  })

  it('겹치는 sherpa 클러스터가 없는 system 구간은 "system"으로 유지한다', () => {
    const channelTurns: DiarTurn[] = [
      turn(0, 1000, 'mic'),
      turn(1000, 2000, 'system'), // spk_1과 겹침
      turn(10000, 11000, 'system') // sherpa 커버리지 밖 → 겹침 0
    ]
    const sherpaTurns: DiarTurn[] = [
      turn(0, 1000, 'spk_0'), // 나 클러스터
      turn(1000, 2000, 'spk_1')
    ]

    const result = combineTwoStage(channelTurns, sherpaTurns)

    expect(result[1].speaker_key).toBe('sys_0')
    expect(result[2].speaker_key).toBe('system') // 겹침 없음 → 유지
    // 화자 3명(mic, sys_0, system)이므로 폴백하지 않고 결과가 보존된다
    expect(new Set(result.map((t) => t.speaker_key)).size).toBe(3)
  })

  it('재정합 결과가 2화자 이하면(분리 실패) channelTurns를 그대로 반환한다', () => {
    // sherpa가 참석 인원보다 적게(1명) 클러스터링해 상대편을 못 쪼갠 경우.
    const channelTurns: DiarTurn[] = [
      turn(0, 1000, 'mic'),
      turn(1000, 2000, 'system'),
      turn(2000, 3000, 'system')
    ]
    const sherpaTurns: DiarTurn[] = [
      turn(0, 3000, 'spk_0') // 단일 클러스터 → 나 클러스터로만 식별
    ]

    const result = combineTwoStage(channelTurns, sherpaTurns)

    // 모든 system 구간의 최대 겹침이 나 클러스터뿐 → 차선 없음 → 'system' 유지
    // 결과 {mic, system} 2화자 → 무해 폴백으로 channelTurns 원본을 반환
    expect(result).toBe(channelTurns)
  })

  it('sherpa 결과가 비어 있으면 channelTurns를 그대로 반환한다', () => {
    const channelTurns: DiarTurn[] = [turn(0, 1000, 'mic'), turn(1000, 2000, 'system')]
    const result = combineTwoStage(channelTurns, [])
    expect(result).toBe(channelTurns)
  })
})
