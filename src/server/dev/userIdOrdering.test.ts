import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { compareUserIds } from './userIdCompare'
import {
  expectedStableApiOrder,
  normalizeLegacyApiTies
} from './userIdOrdering'
import {
  identityKey,
  type Json,
  type JsonObject,
  type TableSnapshot,
  type UserIdSnapshot
} from './userIdSnapshot'
import { expectedPlaceholders } from './userIdTransforms'

const teamStats = '/teams/tem_one/stats'
const roster = '/teams/tem_one/roster'
const seasonStats = '/seasons/sea_one/stats'
const plays = (after: boolean): string =>
  `/players/${after ? userIdOfGumbo(1) : 1}/plays`
const table = (rows: JsonObject[], keys = ['id']): TableSnapshot => ({
  columns: [...new Set(rows.flatMap(row => Object.keys(row)))].sort(),
  keys,
  rows
})
function fixture(after: boolean): UserIdSnapshot {
  const user = (id: number): Json => (after ? userIdOfGumbo(id) : id)
  const stats = (rank: 'pa' | 'outs'): JsonObject[] =>
    (after ? [3, 1, 2, 4] : [3, 2, 1, 4]).map(id => ({
      userId: user(id),
      [rank]: id === 3 ? 5 : id === 4 ? 1 : 3,
      h: id,
      nested: { sequence: [2, 1] }
    }))
  const people = (after ? [3, 1, 2, 4, 5] : [3, 2, 1, 4, 5]).map(id => ({
    userId: user(id),
    ...(after ? { gumboId: id } : {}),
    section: id === 3 ? 'admin' : id === 5 ? 'spectator' : 'player',
    inheritedFrom: null,
    shortName: id === 4 ? 'Zack W' : 'Mookie B'
  }))
  const play = (
    gameId: string,
    atBatIndex: number,
    role = 'batter'
  ): JsonObject => ({
    gameId,
    atBatIndex,
    role,
    eventId: `evt_${gameId}_${atBatIndex}`,
    rbi: 1
  })
  const played = after
    ? [
        play('null', 0),
        play('A', 1),
        play('A', 1, 'pitcher'),
        play('A', 3),
        play('Z', 2),
        play('old', 0)
      ]
    : [
        play('null', 0),
        play('Z', 2),
        play('A', 3),
        play('A', 1, 'pitcher'),
        play('A', 1),
        play('old', 0)
      ]
  const api: Record<string, Json> = {
    [teamStats]: stats('pa'),
    [teamStats + '?kind=pitching']: stats('outs'),
    [seasonStats]: { batting: stats('pa'), pitching: stats('outs') },
    [seasonStats + '?kind=pitching']: { batting: [], pitching: stats('outs') },
    [roster]: people,
    [plays(after)]: played,
    '/unknown': [2, 1],
    '/games/gam_one/box-score': {
      batting: [{ userId: user(2) }, { userId: user(1) }],
      pitching: stats('outs'),
      sequence: [2, 1]
    }
  }
  return {
    version: 1,
    userIdType: after ? 'text' : 'bigint',
    migrations: after
      ? ['067gameUnroster', '068gumboIds', '069userIds', '070playerGumboIds']
      : ['067gameUnroster'],
    captureStartedAt: after ? '2026-01-02T00:00:00Z' : '2026-01-01T00:00:00Z',
    captureFinishedAt: after ? '2026-01-02T00:00:00Z' : '2026-01-01T00:00:00Z',
    userColumns: after ? { gumbo_ids: ['user_id'] } : {},
    tables: {
      users: table([1, 2, 3, 4, 5].map(id => ({ id: user(id) }))),
      games: table([
        { id: 'null', start_at: null },
        { id: 'A', start_at: '2026-01-01T00:00:00Z' },
        { id: 'Z', start_at: '2026-01-01T00:00:00Z' },
        { id: 'old', start_at: '2025-01-01T00:00:00Z' }
      ]),
      ...(after
        ? {
            gumbo_ids: table(
              [1, 2, 3, 4, 5].map(id => ({
                gumbo_id: id,
                user_id: user(id),
                created_at: '2026-01-01T12:00:00Z'
              })),
              ['gumbo_id']
            )
          }
        : {})
    },
    api,
    apiInventory: Object.fromEntries(
      Object.entries(api)
        .filter(([path, body]) => path !== '/unknown' && Array.isArray(body))
        .map(([path, body]) => [
          path,
          {
            status: 200,
            pages: 1,
            total: null,
            itemIds: (body as JsonObject[]).map(row =>
              row.eventId == null
                ? identityKey(row.userId)
                : `${identityKey(row.eventId)}:${identityKey(row.role)}`
            )
          }
        ])
    ),
    preserved: {}
  }
}
const rows = (s: UserIdSnapshot, path: string): JsonObject[] =>
  s.api[path] as JsonObject[]

describe('approved migration API ordering', function () {
  it('derives only the approved permutations from B, preserving every row and inventory', function () {
    const before = fixture(false)
    const after = fixture(true)
    const original = structuredClone(before)
    const result = compareUserIds(before, after)
    expect(result.equal, result.differences.join('\n')).equals(true)
    expect(
      result.transformations.filter(rule => rule.startsWith('ordering '))
    ).has.length(8)
    expect(before).deep.equals(original)
    // Inventory is optional in old synthetic fixtures, not inferred from C.
    delete before.apiInventory
    delete after.apiInventory
    expect(compareUserIds(before, after).equal).equals(true)
    const empty = fixture(false)
    empty.api = {}
    delete empty.tables.games
    expect(() => {
      expectedStableApiOrder(empty, [])
    }).not.throws()
  })

  it('rejects incorrect target order, changed values, lost/duplicate rows and undeclared sequences', function () {
    const changes: Array<(s: UserIdSnapshot) => void> = [
      s => {
        rows(s, teamStats).reverse()
      },
      s => {
        rows(s, teamStats)[1].pa = 9
      },
      s => {
        rows(s, teamStats)[1].h = 99
      },
      s => {
        rows(s, teamStats)[1].userId = userIdOfGumbo(5)
      },
      s => {
        rows(s, roster).splice(1, 1)
      },
      s => {
        rows(s, roster).push(rows(s, roster)[1])
      },
      s => {
        rows(s, plays(true)).reverse()
      },
      s => {
        rows(s, plays(true))[1].rbi = 9
      },
      s => {
        rows(s, plays(true))[1].atBatIndex = 99
      },
      s => {
        rows(s, plays(true))[1].role = 'runner'
      },
      s => {
        rows(s, teamStats)[1].nested = { sequence: [1, 2] }
      },
      s => {
        s.api['/unknown'] = [1, 2]
      },
      s => {
        ;(s.api['/games/gam_one/box-score'] as JsonObject).sequence = [1, 2]
      },
      s => {
        ;(
          (s.api['/games/gam_one/box-score'] as JsonObject).batting as Json[]
        ).reverse()
      },
      s => {
        ;(
          (s.api['/games/gam_one/box-score'] as JsonObject).pitching as Json[]
        ).reverse()
      },
      s => {
        s.apiInventory![teamStats].itemIds.reverse()
      }
    ]
    for (const change of changes) {
      const after = fixture(true)
      change(after)
      expect(compareUserIds(fixture(false), after).equal).equals(false)
    }
    const before = fixture(false)
    before.apiInventory![teamStats].itemIds.reverse()
    expect(() => compareUserIds(before, fixture(true))).throws('inventory')
  })

  it('keeps same-schema comparisons strict, including ties and chronological groups', function () {
    for (const after of [false, true]) {
      const before = fixture(after)
      const changed = structuredClone(before)
      rows(changed, teamStats).reverse()
      expect(compareUserIds(before, changed).equal).equals(false)
    }
    const before = fixture(false)
    // An invalid primary order cannot be repaired by this tie-only adapter.
    rows(before, teamStats).reverse()
    delete before.apiInventory
    const after = fixture(true)
    delete after.apiInventory
    expect(compareUserIds(before, after).equal).equals(false)
    const chronological = fixture(true)
    const list = rows(chronological, plays(true))
    list.unshift(list.pop()!)
    expect(compareUserIds(fixture(false), chronological).equal).equals(false)
  })

  it('compares legacy tied rows exactly only across the explicit A to B transition', function () {
    const before = fixture(false)
    before.migrations = ['065radarReadings']
    before.tables.games.rows.forEach(row => {
      row.currentPlay = null
    })
    before.tables.games.columns.push('currentPlay')
    const candidate = structuredClone(before)
    candidate.tables.game_placeholder_guests = table([])
    const after = expectedPlaceholders(before, candidate, [])
    const swap = (list: Json[]): void => {
      ;[list[1], list[2]] = [list[2], list[1]]
    }
    for (const path of [teamStats, teamStats + '?kind=pitching', roster]) {
      swap(rows(after, path))
      swap(after.apiInventory![path].itemIds)
    }
    for (const path of [seasonStats, seasonStats + '?kind=pitching']) {
      const body = after.api[path] as JsonObject
      if ((body.batting as Json[]).length > 0) swap(body.batting as Json[])
      swap(body.pitching as Json[])
    }
    swap(
      (after.api['/games/gam_one/box-score'] as JsonObject).pitching as Json[]
    )
    const result = compareUserIds(before, after, { allowPlaceholders: true })
    expect(result.equal, result.differences.join('\n')).equals(true)
    expect(
      result.transformations.some(line => line.startsWith('legacy-ties '))
    ).equals(true)
    const changes: Array<(s: UserIdSnapshot) => void> = [
      s => {
        rows(s, teamStats)[1].h = 99
      },
      s => {
        rows(s, teamStats)[1].pa = 99
      },
      s => {
        rows(s, teamStats).reverse()
        s.apiInventory![teamStats].itemIds.reverse()
      },
      s => {
        rows(s, roster)[1].section = 'admin'
      },
      s => {
        rows(s, roster)[1].shortName = 'Different label'
      },
      s => {
        rows(s, roster)[1].inheritedFrom = 'league'
      },
      s => {
        rows(s, teamStats)[1].nested = { sequence: [1, 2] }
      },
      s => {
        rows(s, roster).pop()
        s.apiInventory![roster].itemIds.pop()
      },
      s => {
        rows(s, roster).push(rows(s, roster)[1])
        s.apiInventory![roster].itemIds.push('1')
      },
      s => {
        rows(s, plays(false)).reverse()
      },
      s => {
        ;(
          (s.api['/games/gam_one/box-score'] as JsonObject).batting as Json[]
        ).reverse()
      },
      s => {
        s.api['/unknown'] = [1, 2]
      }
    ]
    for (const change of changes) {
      const changed = structuredClone(after)
      change(changed)
      expect(
        compareUserIds(before, changed, { allowPlaceholders: true }).equal
      ).equals(false)
    }
    const restored = structuredClone(before)
    swap(rows(restored, teamStats))
    swap(restored.apiInventory![teamStats].itemIds)
    expect(compareUserIds(before, restored).equal).equals(false)
    expect(() => {
      normalizeLegacyApiTies(fixture(true), [])
    }).throws('numeric')
  })

  it('fails closed on incomplete ordering evidence and malformed rows', function () {
    const changes: Array<(s: UserIdSnapshot) => void> = [
      s => {
        delete s.tables.games
      },
      s => {
        delete s.tables.games.rows[1].start_at
      },
      s => {
        s.tables.games.rows[1].start_at = 7
      },
      s => {
        s.api[seasonStats] = null
      },
      s => {
        s.api[teamStats] = {}
      },
      s => {
        ;(s.api[teamStats] as Json[])[0] = null
      },
      s => {
        rows(s, teamStats)[0].pa = '5'
      },
      s => {
        rows(s, roster)[0].section = null
      },
      s => {
        rows(s, plays(false))[1].gameId = 'missing'
      }
    ]
    for (const change of changes) {
      const before = fixture(false)
      delete before.apiInventory
      change(before)
      expect(() => compareUserIds(before, fixture(true))).throws()
    }
  })
})
