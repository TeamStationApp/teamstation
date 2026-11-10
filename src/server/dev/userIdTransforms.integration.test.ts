import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { compareUserIds } from './userIdCompare'
import {
  type JsonObject,
  snapshotSql,
  type UserIdSnapshot
} from './userIdSnapshot'
import {
  expectedPlaceholders,
  orderSnapshotTables,
  placeholderDocumentHashes
} from './userIdTransforms'

describe('strict historical identity transformations', function () {
  this.timeout(60000)
  const name = `teamstation_identity_adapter_${process.pid}_${Date.now()}`
  let admin: Pool, pool: Pool
  let original: UserIdSnapshot, migrated: UserIdSnapshot
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    const url = new URL(testDatabaseUrl)
    url.pathname = '/' + name
    pool = new Pool({ connectionString: url.toString() })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '066')
    )
    await pool.query(`insert into users(id,"legacyId",display_name) values(123,'usr_AAAAAAAAAAAAAAAA','Hank Aaron');
      insert into teams(id,name) values('tem_away','Visitors'),('tem_home','Hosts');
      insert into games(id,home_team_id,away_team_id,start_at) values('gam_one','tem_home','tem_away',now());`)
    const setup = {
      players: {
        1: {
          id: 1,
          userId: null,
          fullName: 'Babe Ruth',
          jersey: '3',
          positions: ['P']
        },
        2: { id: 2, userId: 123, fullName: 'Hank Aaron' }
      },
      sides: {
        away: { players: [1], battingOrder: [1] },
        home: { players: [2], battingOrder: [2] }
      },
      identities: {
        sessionToSource: { 1: null, 2: 123 },
        sourceToSession: { 'number:123': 2 },
        nextId: 3
      }
    }
    const doc = {
      about: { atBatIndex: 0 },
      result: { eventType: 'game_advisory' },
      teamStation: {
        version: 1,
        setupBefore: setup,
        actions: [
          { type: 'lineup', kind: 'roster', setup },
          {
            type: 'lineup',
            kind: 'addPlayer',
            side: 'away',
            name: 'Willie Mays'
          }
        ]
      }
    }
    await pool.query('insert into events(id,"gameId",gumbo) values($1,$2,$3)', [
      'evt_one',
      'gam_one',
      doc
    ])
    await pool.query('update games set "currentPlay"=$1', [doc])
    const capture = async (): Promise<UserIdSnapshot> => {
      const c = await pool.connect()
      try {
        return { ...(await snapshotSql(c)), api: {} }
      } finally {
        c.release()
      }
    }
    original = await capture()
    await migrateUp(
      pool,
      migrations.filter(m => m.name >= '066' && m.name < '068')
    )
    migrated = await capture()
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('derives the exact SQL result from the baseline and validates the random guest identities', () => {
    const log: string[] = []
    const expected = expectedPlaceholders(original, migrated, log)
    const actual = structuredClone(migrated)
    placeholderDocumentHashes(expected)
    placeholderDocumentHashes(actual)
    orderSnapshotTables(expected)
    orderSnapshotTables(actual)
    // HTTP is exercised separately; no API request was made in this SQL fixture.
    expected.api = {}
    expect(expected).deep.equals(actual)
    expect(log).length(2)
    expect(log.join('\n')).not.contains('Babe').and.not.contains('Willie')
  })
  it('rejects missing, duplicate, reused and malformed candidate mappings', () => {
    for (const change of [
      (s: UserIdSnapshot) => {
        s.tables.game_placeholder_guests.rows.pop()
      },
      (s: UserIdSnapshot) => {
        s.tables.game_placeholder_guests.rows[1] = {
          ...s.tables.game_placeholder_guests.rows[0]
        }
      },
      (s: UserIdSnapshot) => {
        s.tables.game_placeholder_guests.rows[0].user_id = 123
      },
      (s: UserIdSnapshot) => {
        s.tables.game_placeholder_guests.rows[0].side = 'home'
      },
      (s: UserIdSnapshot) => {
        s.tables.users.rows.find(
          r => r.id === s.tables.game_placeholder_guests.rows[0].user_id
        )!.legacyId = 'bad'
      },
      (s: UserIdSnapshot) => {
        s.tables.users.rows.find(
          r => r.id === s.tables.game_placeholder_guests.rows[0].user_id
        )!.legacyId = 'usr_AAAAAAAAAAAAAAAA'
      }
    ]) {
      const broken = structuredClone(migrated)
      change(broken)
      expect(() => expectedPlaceholders(original, broken, [])).throws()
    }
  })
  it('keeps changed names, score data, actions, ordering and Gumbo hashes visible to comparison', () => {
    const expected = expectedPlaceholders(original, migrated, [])
    expected.api = {}
    placeholderDocumentHashes(expected)
    orderSnapshotTables(expected)
    for (const change of [
      (s: UserIdSnapshot) => {
        s.tables.users.rows.find(r => r.id !== 123)!.display_name = 'Changed'
      },
      (s: UserIdSnapshot) => {
        ;(s.tables.events.rows[0].gumbo as JsonObject).gumboHash = 'changed'
      },
      (s: UserIdSnapshot) => {
        ;(s.tables.events.rows[0].gumbo as any).teamStation.actions[0].kind =
          'different'
      },
      (s: UserIdSnapshot) => {
        ;(
          s.tables.events.rows[0].gumbo as any
        ).teamStation.setupBefore.sides.away.battingOrder = [2]
      },
      (s: UserIdSnapshot) => {
        ;(s.tables.games.rows[0].unrostered as JsonObject).away = [123]
      },
      (s: UserIdSnapshot) => {
        s.tables.game_guest_details.rows.push({
          game_id: 'gam_one',
          user_id: 123,
          jersey: null,
          positions: []
        })
      }
    ]) {
      const broken = structuredClone(migrated)
      change(broken)
      placeholderDocumentHashes(broken)
      orderSnapshotTables(broken)
      expect(expected).not.deep.equals(broken)
    }
  })
  it('constructs exact new endpoint fields without accepting candidate API output', () => {
    const a = structuredClone(original)
    a.api['/games/gam_one'] = { id: 'gam_one', homeScore: 4, awayScore: 2 }
    const expected = expectedPlaceholders(a, migrated, [])
    const game = expected.api['/games/gam_one'] as any
    expect(game.homeScore).equals(4)
    expect(game.awayScore).equals(2)
    expect(game.guests.away).length(2)
    expect(game.unrostered).deep.equals({ away: [], home: [] })
    expect(game.guestPlayers.away[0]).includes({
      jersey: '3',
      shortName: 'Babe R',
      avatarUrl: null,
      walkUpSong: null
    })
    expect(game.guestPlayers.away[1]).includes({
      jersey: null,
      shortName: 'Willie M'
    })
    for (const field of ['avatarUrl', 'walkUpSong']) {
      const changed = structuredClone(expected)
      ;(changed.api['/games/gam_one'] as any).guestPlayers.away[0][field] =
        'unexpected'
      expect(
        compareUserIds(a, changed, { allowPlaceholders: true }).equal
      ).equals(false)
    }
    for (const id of game.guests.away) {
      expect(expected.api[`/players/${id}/plays`]).deep.equals([])
      expect(expected.api[`/players/${id}/stats`]).includes({
        userId: id,
        games: 0,
        batting: null,
        pitching: null
      })
      expect(
        (expected.api[`/players/${id}/stats`] as JsonObject).splits
      ).deep.equals({ by: 'team', batting: [], pitching: [] })
    }
  })
})
