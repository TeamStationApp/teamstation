import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { compareUserIds } from './userIdCompare'
import type { JsonObject, UserIdSnapshot } from './userIdSnapshot'
import {
  expectedMergedApi,
  expectedPlaceholders,
  normalizeTransport,
  validateNewGumboMappings
} from './userIdTransforms'

function mergedFixture(): UserIdSnapshot {
  const batting = (userId: number, h: number, pa: number): JsonObject => ({
    userId,
    teamId: 'tem_one',
    g: 1,
    pa,
    ab: pa,
    h,
    singles: h,
    doubles: 0,
    triples: 0,
    hr: 0,
    bb: 0,
    k: 0,
    kl: 1,
    r: 0,
    rbi: 0,
    hbp: 0,
    sb: 0,
    cs: 0,
    sf: 0,
    sh: 0,
    roe: 0,
    fc: 0,
    pik: 0,
    firstPa: userId,
    rates: { avg: h / pa, slg: h / pa, obp: h / pa, ops: (2 * h) / pa },
    shortName: 'Old'
  })
  const pitching = (
    userId: number,
    outs: number,
    eraInnings: number
  ): JsonObject => ({
    userId,
    teamId: 'tem_one',
    g: 1,
    outs,
    bf: 4,
    h: 1,
    hr: 0,
    hbp: 0,
    r: 1,
    er: 1,
    bb: 1,
    k: 1,
    gs: 1,
    pitches: 10,
    strikes: 6,
    kl: 0,
    pitchAb: 3,
    wp: 0,
    lob: 0,
    bk: 0,
    pik: 0,
    cs: 0,
    sb: 0,
    eraInnings,
    ip: '1.0',
    rates: {},
    shortName: 'Old'
  })
  return {
    version: 1,
    userIdType: 'bigint',
    migrations: ['065radarReadings'],
    userColumns: {},
    preserved: {},
    tables: {
      users: {
        columns: [
          'id',
          'merged_into',
          'first_name',
          'last_name',
          'display_name'
        ],
        keys: ['id'],
        rows: [
          {
            id: 1,
            merged_into: 2,
            first_name: 'Babe',
            last_name: 'Ruth',
            display_name: 'Babe Ruth'
          },
          {
            id: 2,
            merged_into: 3,
            first_name: 'Willie',
            last_name: 'Mays',
            display_name: 'Willie Mays'
          },
          {
            id: 3,
            merged_into: null,
            first_name: 'Hank',
            last_name: 'Aaron',
            display_name: 'Hank Aaron'
          }
        ]
      }
    },
    api: {
      '/teams/tem_one/stats': {
        batting: [batting(1, 1, 2), batting(2, 2, 4)],
        pitching: [pitching(1, 3, 6), pitching(2, 6, 9)]
      }
    }
  }
}
describe('independent merged aggregate expectations', () => {
  it('preserves already-resolved endpoint ordering and labels and handles array stats endpoints', () => {
    const snapshot = mergedFixture()
    expectedMergedApi(snapshot, [])
    const before = structuredClone(snapshot)
    expectedMergedApi(snapshot, [])
    expect(snapshot).deep.equals(before)
    const arrays = mergedFixture()
    const body = arrays.api['/teams/tem_one/stats'] as JsonObject
    arrays.api['/teams/tem_one/stats'] = body.batting
    arrays.api['/teams/tem_one/stats?kind=pitching'] = body.pitching
    expectedMergedApi(arrays, [])
    expect(arrays.api['/teams/tem_one/stats']).deep.equals(
      (before.api['/teams/tem_one/stats'] as JsonObject).batting
    )
    expect(arrays.api['/teams/tem_one/stats?kind=pitching']).deep.equals(
      (before.api['/teams/tem_one/stats'] as JsonObject).pitching
    )
  })
  it('sums counts and recomputes batting, innings, weighted ERA and survivor labels', () => {
    const fixture = mergedFixture()
    const log: string[] = []
    expectedMergedApi(fixture, log)
    const body = fixture.api['/teams/tem_one/stats'] as any
    expect(body.batting).length(1)
    expect(body.batting[0]).includes({
      userId: 3,
      shortName: 'Hank A',
      h: 3,
      ab: 6,
      pa: 6,
      g: 2,
      kl: 2,
      firstPa: 1
    })
    expect(body.batting[0].rates).deep.equals({
      avg: 0.5,
      slg: 0.5,
      obp: 0.5,
      ops: 1
    })
    expect(body.pitching[0]).includes({
      outs: 9,
      ip: '3.0',
      eraInnings: 8,
      er: 2,
      bf: 8,
      strikes: 12,
      userId: 3
    })
    expect(body.pitching[0].rates).deep.equals({
      baa: 0.333,
      era: 5.33,
      whip: 1.33
    })
    expect(log).length(4)
  })
  it('preserves unknown-data failures, null counts and mixed-team dimensions', () => {
    const fixture = mergedFixture()
    const body = fixture.api['/teams/tem_one/stats'] as any
    body.batting[0].kl = null
    body.pitching[0].strikes = null
    body.batting[0].roe = null
    body.batting[0].teamId = 'tem_two'
    body.pitching[0].pitches = null
    expectedMergedApi(fixture, [])
    expect(body.batting[0]).includes({ roe: null, kl: null, teamId: null })
    expect(body.pitching[0].pitches).equals(null)
    expect(body.pitching[0].strikes).equals(null)
    const unknown = mergedFixture()
    ;(unknown.api['/teams/tem_one/stats'] as any).batting[0].unknown = 9
    expect(() => {
      expectedMergedApi(unknown, [])
    }).throws('Unknown aggregate field')
    const missing = mergedFixture()
    delete (missing.api['/teams/tem_one/stats'] as any).batting[0].h
    expect(() => {
      expectedMergedApi(missing, [])
    }).throws('Incomplete aggregate')
  })
  it('fails closed on cycles and missing survivors and leaves unrelated API data untouched', () => {
    const cyclic = mergedFixture()
    cyclic.tables.users.rows[2].merged_into = 1
    expect(() => {
      expectedMergedApi(cyclic, [])
    }).throws('Cyclic')
    const missing = mergedFixture()
    missing.tables.users.rows[2].merged_into = 4
    expect(() => {
      expectedMergedApi(missing, [])
    }).throws('Missing')
    const fixture = mergedFixture()
    fixture.api['/unknown'] = { batting: [{ userId: 1, h: 999 }] }
    expectedMergedApi(fixture, [])
    expect(fixture.api['/unknown']).deep.equals({
      batting: [{ userId: 1, h: 999 }]
    })
  })
})

describe('transport volatility allowlist', () => {
  it('normalizes only media signatures, retaining resource, lifetime and business timestamps', () => {
    const a = mergedFixture()
    const b = mergedFixture()
    const media = (date: string, sig: string): string =>
      `https://media.example.test/image.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=${date}&X-Amz-Signature=${sig.repeat(64)}&X-Amz-Credential=key%2F20260101%2Fregion%2Fs3%2Faws4_request&X-Amz-Expires=21600`
    a.api['/games/gam_one'] = {
      logoUrl: media('20260101T010101Z', 'a'),
      posterUrl: `https://example.test/api/v1/videos/vid_one/stills/1.jpg?t=100.${'x'.repeat(43)}`,
      startAt: '2026-01-01',
      unknown: media('20260101T010101Z', 'a')
    }
    b.api['/games/gam_one'] = {
      logoUrl: media('20260101T020202Z', 'b'),
      posterUrl: `https://example.test/api/v1/videos/vid_one/stills/1.jpg?t=200.${'y'.repeat(43)}`,
      startAt: '2026-01-01',
      unknown: media('20260101T010101Z', 'a')
    }
    const log: string[] = []
    normalizeTransport(a, log)
    normalizeTransport(b, [])
    expect(a).deep.equals(b)
    expect(log).length(2)
    expect((a.api['/games/gam_one'] as any).logoUrl)
      .contains('21600')
      .and.contains('image.jpg')
    expect((a.api['/games/gam_one'] as any).startAt).equals('2026-01-01')
    expect((a.api['/games/gam_one'] as any).unknown).contains('010101')
    const bad = mergedFixture()
    bad.api['/games/gam_one'] = {
      posterUrl: 'https://example.test/api/v1/videos/vid_one/stills/1.jpg?t=bad'
    }
    expect(() => {
      normalizeTransport(bad, [])
    }).throws('Malformed still')
  })
})

describe('strict comparison acceptance boundaries', () => {
  it('rejects changed counts, rates, denominators and grouping even when merge transformations are allowed', () => {
    const before = mergedFixture()
    // The combined batting/pitching envelope is a season response.
    before.api['/seasons/sea_one/stats'] = before.api['/teams/tem_one/stats']
    delete before.api['/teams/tem_one/stats']
    before.tables.games = {
      columns: ['id', 'currentPlay'],
      keys: ['id'],
      rows: []
    }
    before.tables.events = {
      columns: ['id', 'gameId', 'gumbo'],
      keys: ['id'],
      rows: []
    }
    const candidate = structuredClone(before)
    candidate.tables.game_placeholder_guests = {
      columns: ['game_id', 'session_id', 'side', 'user_id'],
      keys: ['game_id', 'session_id'],
      rows: []
    }
    const after = expectedPlaceholders(before, candidate, [])
    expectedMergedApi(after, [])
    const options = { allowPlaceholders: true, allowMerged: true }
    expect(compareUserIds(before, after, options).equal).equals(true)
    for (const change of [
      (body: any) => {
        body.batting[0].h++
      },
      (body: any) => {
        body.batting[0].rates.avg = 0.7
      },
      (body: any) => {
        body.pitching[0].eraInnings = 9
      },
      (body: any) => {
        body.pitching[0].outs = 10
      },
      (body: any) => {
        body.batting[0].teamId = 'tem_changed'
      },
      (body: any) => {
        body.batting = []
      }
    ]) {
      const broken = structuredClone(after)
      change(broken.api['/seasons/sea_one/stats'])
      expect(compareUserIds(before, broken, options).equal).equals(false)
    }
  })
  it('requires exact initial mappings and timestamps inside the captured cutover interval', () => {
    const before = mergedFixture()
    before.captureFinishedAt = '2026-01-01T00:00:00Z'
    const after = structuredClone(before)
    after.userIdType = 'text'
    after.captureStartedAt = '2026-01-01T01:00:00Z'
    after.tables.gumbo_ids = {
      columns: ['created_at', 'gumbo_id', 'user_id'],
      keys: ['gumbo_id'],
      rows: [1, 2, 3].map(id => ({
        gumbo_id: id,
        user_id: userIdOfGumbo(id),
        created_at: '2026-01-01T00:30:00Z'
      }))
    }
    validateNewGumboMappings(before, after)
    for (const change of [
      (s: UserIdSnapshot) => {
        delete s.captureStartedAt
      },
      (s: UserIdSnapshot) => {
        s.tables.gumbo_ids.rows.pop()
      },
      (s: UserIdSnapshot) => {
        s.tables.gumbo_ids.rows[1].gumbo_id = 1
      },
      (s: UserIdSnapshot) => {
        s.tables.gumbo_ids.rows[0].user_id = userIdOfGumbo(2)
      },
      (s: UserIdSnapshot) => {
        s.tables.gumbo_ids.rows[0].created_at = '2025-12-31T23:59:59Z'
      },
      (s: UserIdSnapshot) => {
        s.tables.gumbo_ids.rows[0].created_at = '2026-01-01T01:00:01Z'
      },
      (s: UserIdSnapshot) => {
        s.tables.gumbo_ids.rows[0].created_at = null
      },
      (s: UserIdSnapshot) => {
        s.tables.gumbo_ids.rows[0].unexpected = 1
      }
    ]) {
      const broken = structuredClone(after)
      change(broken)
      expect(() => {
        validateNewGumboMappings(before, broken)
      }).throws()
    }
  })
})

describe('rebuilt statistics storage metadata', () => {
  function fixture(): UserIdSnapshot {
    const snapshot = mergedFixture()
    snapshot.userIdType = 'text'
    snapshot.migrations = ['070playerGumboIds']
    snapshot.captureFinishedAt = '2026-01-01T00:00:00Z'
    snapshot.tables.game_player_stats = {
      columns: [
        'id',
        'game_id',
        'gumbo_id',
        'team_id',
        'computed_at',
        'h',
        'extra'
      ],
      keys: ['id'],
      rows: [
        {
          id: 'gps_AAAAAAAAAAAAAAAA',
          game_id: 'gam_one',
          gumbo_id: 1,
          team_id: 'tem_one',
          computed_at: '2025-01-01T00:00:00Z',
          h: 2,
          extra: { rbi: 3 }
        }
      ]
    }
    return snapshot
  }
  function rebuilt(before: UserIdSnapshot): UserIdSnapshot {
    const after = structuredClone(before)
    after.captureStartedAt = '2026-01-01T01:00:00Z'
    Object.assign(after.tables.game_player_stats.rows[0], {
      id: 'gps_BBBBBBBBBBBBBBBB',
      computed_at: '2026-01-01T00:30:00Z'
    })
    return after
  }
  it('retains full raw snapshots and requires an explicit same-schema rebuild mode', () => {
    const before = fixture()
    const after = rebuilt(before)
    const raw = JSON.stringify(before)
    expect(compareUserIds(before, after).equal).equals(false)
    const result = compareUserIds(before, after, { allowRebuiltStats: true })
    expect(result.equal).equals(true)
    expect(result.transformations).deep.equals([
      'stats-rebuild ["gam_one",1,"tem_one"]: id,computed_at'
    ])
    expect(JSON.stringify(before)).equals(raw)
    const unchanged = structuredClone(before)
    unchanged.captureStartedAt = after.captureStartedAt
    expect(
      compareUserIds(before, unchanged, { allowRebuiltStats: true }).equal
    ).equals(true)
    expect(() =>
      compareUserIds(before, after, {
        allowRebuiltStats: true,
        allowMerged: true
      })
    ).throws('cannot combine')
  })
  it('refuses row loss, duplicated or altered identities, malformed metadata and outside-window timestamps', () => {
    const before = fixture()
    for (const change of [
      (s: UserIdSnapshot) => {
        s.userIdType = 'bigint'
      },
      (s: UserIdSnapshot) => {
        s.migrations.push('999unexpected')
      },
      (s: UserIdSnapshot) => {
        delete s.captureStartedAt
      },
      (s: UserIdSnapshot) => {
        s.captureStartedAt = '2025-01-01T00:00:00Z'
      },
      (s: UserIdSnapshot) => {
        delete s.tables.game_player_stats
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows = []
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows[0].id = 'invalid'
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows[0].gumbo_id = 2
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows[0].gumbo_id = '1'
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows[0].gumbo_id = 0
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows[0].team_id = 1
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows[0].computed_at = null
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows[0].computed_at = '2025-01-01T00:00:00Z'
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows[0].computed_at = '2026-01-02T00:00:00Z'
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows.push({
          ...s.tables.game_player_stats.rows[0]
        })
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows.push({
          ...s.tables.game_player_stats.rows[0],
          id: 'gps_CCCCCCCCCCCCCCCC'
        })
      }
    ]) {
      const after = rebuilt(before)
      change(after)
      expect(() =>
        compareUserIds(before, after, { allowRebuiltStats: true })
      ).throws()
    }
  })
  it('validates the exact box-score build timestamp without relaxing status, statistics or other timestamps', () => {
    const before = fixture()
    const path = '/games/gam_one/box-score'
    before.api[path] = {
      batting: [],
      stats: { status: 'built', detail: null, builtAt: '2025-01-01T00:00:00Z' }
    }
    const after = rebuilt(before)
    const status = (after.api[path] as JsonObject).stats as JsonObject
    status.builtAt = '2026-01-01T00:30:00Z'
    const result = compareUserIds(before, after, { allowRebuiltStats: true })
    expect(result.equal).equals(true)
    expect(result.transformations).includes(
      `stats-rebuild api:${path}.stats.builtAt`
    )
    expect(compareUserIds(before, after).equal).equals(false)
    for (const value of [
      null,
      1,
      'invalid',
      '2025-01-01T00:00:01Z',
      '2026-01-02T00:00:00Z'
    ]) {
      const changed = structuredClone(after)
      ;((changed.api[path] as JsonObject).stats as JsonObject).builtAt = value
      expect(() =>
        compareUserIds(before, changed, { allowRebuiltStats: true })
      ).throws('outside rebuild window')
    }
    for (const change of [
      (s: JsonObject) => {
        ;(s.stats as JsonObject).status = 'failed'
      },
      (s: JsonObject) => {
        ;(s.stats as JsonObject).detail = 'unexpected'
      },
      (s: JsonObject) => {
        s.batting = [{ h: 1 }]
      },
      (s: JsonObject) => {
        s.updatedAt = '2026-01-01T00:30:00Z'
      },
      (s: JsonObject) => {
        delete (s.stats as JsonObject).builtAt
      },
      (s: JsonObject) => {
        s.stats = null
      }
    ]) {
      const changed = structuredClone(after)
      change(changed.api[path] as JsonObject)
      expect(
        compareUserIds(before, changed, { allowRebuiltStats: true }).equal
      ).equals(false)
    }
    before.api['/other'] = { stats: { builtAt: 'old' } }
    after.api['/other'] = { stats: { builtAt: '2026-01-01T00:30:00Z' } }
    expect(
      compareUserIds(before, after, { allowRebuiltStats: true }).equal
    ).equals(false)
  })
  it('keeps every statistic, extra field, API response and gumbo mapping in the comparison', () => {
    const before = fixture()
    for (const change of [
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows[0].h = 3
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows[0].extra = { rbi: 4 }
      },
      (s: UserIdSnapshot) => {
        s.tables.game_player_stats.rows[0].newField = 1
      },
      (s: UserIdSnapshot) => {
        delete s.api['/teams/tem_one/stats']
      },
      (s: UserIdSnapshot) => {
        s.tables.users.rows[0].merged_into = 99
      }
    ]) {
      const after = rebuilt(before)
      change(after)
      expect(
        compareUserIds(before, after, { allowRebuiltStats: true }).equal
      ).equals(false)
    }
  })
})
