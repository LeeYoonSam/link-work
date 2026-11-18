import { describe, it, expect } from 'vitest'
import {
  BACKUP_GROUP_IDS,
  BACKUP_GROUPS,
  canExport,
  confirmKey,
  groupRowCount,
  isPartialSelection,
  manifestGroups,
  orderGroups,
  toggleGroup
} from './backupGroups'

describe('backupGroups', () => {
  it('그룹 정의는 main 과 같은 5개 ID 를 고정 순서로 가진다', () => {
    expect(BACKUP_GROUP_IDS).toEqual(['work', 'meetings', 'library', 'ai', 'settings'])
    expect(BACKUP_GROUPS.map((g) => g.id)).toEqual(BACKUP_GROUP_IDS)
    // 녹음·첨부 폴더가 따라가는 그룹만 파일 표시가 있다
    expect(BACKUP_GROUPS.filter((g) => g.files).map((g) => g.id)).toEqual(['meetings', 'ai'])
    // 설정만 현재·백업 건수 비교를 하지 않는다(세는 기준이 다르다)
    expect(BACKUP_GROUPS.filter((g) => !g.comparable).map((g) => g.id)).toEqual(['settings'])
  })

  it('orderGroups·toggleGroup 은 중복·모르는 값을 빼고 고정 순서를 지킨다', () => {
    expect(orderGroups(['ai', 'work', 'ai', 'nope'])).toEqual(['work', 'ai'])
    expect(toggleGroup(['ai'], 'work')).toEqual(['work', 'ai'])
    expect(toggleGroup(['work', 'ai'], 'work')).toEqual(['ai'])
  })

  it('canExport 는 그룹이 하나 이상일 때만 참이다', () => {
    expect(canExport([])).toBe(false)
    expect(canExport(['settings'])).toBe(true)
  })

  it('confirmKey 는 경로와 정렬된 그룹으로 만든다', () => {
    expect(confirmKey('/a.zip', ['ai', 'work'])).toBe('/a.zip|work,ai')
    expect(confirmKey('/a.zip', [])).toBe('/a.zip|')
  })

  it('manifestGroups: groups 가 있으면 그대로, v1 에 없으면 전체, v2 에 없으면 빈 배열', () => {
    expect(manifestGroups({ formatVersion: 2, groups: ['ai', 'meetings'] })).toEqual([
      'meetings',
      'ai'
    ])
    expect(manifestGroups({ formatVersion: 1 })).toEqual([...BACKUP_GROUP_IDS])
    expect(manifestGroups({ formatVersion: 2 })).toEqual([])
  })

  it('groupRowCount 는 대표 테이블 행 수를 더하고 없는 테이블은 0 으로 센다', () => {
    const library = BACKUP_GROUPS.find((g) => g.id === 'library')!
    expect(groupRowCount(library, { documents: 2, memos: 5 })).toBe(7)
    expect(groupRowCount(library, undefined)).toBe(0)
  })

  it('isPartialSelection 은 5개 전부가 아니면 참이다', () => {
    expect(isPartialSelection([...BACKUP_GROUP_IDS])).toBe(false)
    expect(isPartialSelection(['work'])).toBe(true)
  })
})
