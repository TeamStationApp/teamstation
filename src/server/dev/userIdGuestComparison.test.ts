import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { type asLegacyGameSetup, POSITIONS } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { createSession } from '../auth/sessions'
import { makeDatabase } from '../db/database'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { teamRoutes } from '../routes/teams'
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

type LegacySetup = ReturnType<typeof asLegacyGameSetup>

function setup(): LegacySetup {
  const player = (
    id: number,
    fullName: string,
    teamId: string
  ): LegacySetup['players'][number] => ({
    id,
    userId: null,
    fullName,
    firstName: undefined,
    lastName: undefined,
    teamId,
    jersey: String(id),
    positions: ['P'],
    bats: 'right',
    throws: null,
    local: true
  })
  const side = (ids: number[]): LegacySetup['sides']['away'] => ({
    players: ids,
    battingOrder: [...ids],
    battingIndex: 0,
    defense: Object.fromEntries(
      POSITIONS.map(position => [position, null])
    ) as LegacySetup['sides']['away']['defense'],
    pitchCounts: {}
  })
  return {
    players: {
      1: player(1, 'Hank Aaron', 'tem_away'),
      2: player(2, 'Hank Allen', 'tem_home')
    },
    sides: { away: side([1]), home: side([2]) },
    identities: {
      sessionToSource: { 1: null, 2: null },
      sourceToSession: {},
      nextId: 3
    }
  }
}

describe('historical guest comparison against migration and HTTP', function () {
  this.timeout(60000)
  const name = `guest_comparison_${process.pid}_${Date.now()}`
  let admin: Pool, pool: Pool
  let db: ReturnType<typeof makeDatabase>
  let server: ReturnType<express.Express['listen']>
  let original: UserIdSnapshot, migrated: UserIdSnapshot
  let origin: string, token: string
  const cases = ['active', 'retained', 'snapshot', 'renamed'] as const

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
    await pool.query(`insert into users(id,"legacyId",display_name,is_admin,login_enabled)
      values(123,'usr_AAAAAAAAAAAAAAAA','Jim Abbott',true,true);
      insert into teams(id,name) values('tem_away','Visitors'),('tem_home','Hosts');`)
    for (const kind of cases) {
      const current = setup()
      const prior = structuredClone(current)
      if (kind !== 'active') {
        current.sides.away.players = []
        current.sides.away.battingOrder = []
      }
      if (kind === 'snapshot') {
        // No local side evidence: ownership comes from another saved document.
        current.players[1].teamId = ''
      }
      if (kind === 'renamed') {
        Object.assign(current.players, {
          3: { ...current.players[1], id: 3, fullName: 'Babe Ruth' }
        })
        Object.assign(current.identities.sessionToSource, { 3: null })
        current.identities.nextId = 4
        current.sides.away.players = [3]
        current.sides.away.battingOrder = [3]
      }
      const doc = (held: LegacySetup, index: number): unknown => ({
        about: { atBatIndex: index },
        result: { eventType: 'game_advisory' },
        teamStation: { version: 1, setupBefore: held, actions: [] }
      })
      await pool.query(
        `insert into games(id,home_team_id,away_team_id,start_at,"currentPlay")
         values($1,'tem_home','tem_away','2026-01-01',$2)`,
        ['gam_' + kind, doc(current, 1)]
      )
      if (kind === 'snapshot' || kind === 'renamed')
        await pool.query(
          'insert into events(id,"gameId",gumbo) values($1,$2,$3)',
          ['evt_' + kind, 'gam_' + kind, doc(prior, 0)]
        )
    }
    const capture = async (): Promise<UserIdSnapshot> => {
      const client = await pool.connect()
      try {
        return { ...(await snapshotSql(client)), api: {} }
      } finally {
        client.release()
      }
    }
    original = await capture()
    await migrateUp(
      pool,
      migrations.filter(m => m.name >= '066' && m.name < '068')
    )
    migrated = await capture()
    await migrateUp(pool, migrations)
    db = makeDatabase(url.toString())
    token = (await createSession(db, userIdOfGumbo(123), 'guest-comparison'))
      .token
    const app = express()
    app.use(withActor(db))
    app.use(
      teamRoutes(db, {
        ffmpegPath: 'ffmpeg',
        mediaRoot: '/tmp',
        mediaSecret: 'synthetic',
        publicUrl: 'http://example.test',
        space: {
          endpoint: '',
          region: '',
          bucket: '',
          accessKeyId: '',
          secretAccessKey: '',
          pathStyle: false
        }
      })
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(async () => {
    if (server != null)
      await new Promise<void>((resolve, reject) =>
        server.close(error => {
          if (error == null) resolve()
          else reject(error)
        })
      )
    await db?.destroy()
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  it('predicts every stored field for active, inactive and replaced guests', () => {
    const expected = expectedPlaceholders(original, migrated, [])
    const actual = structuredClone(migrated)
    // These are SQL captures; the separate test below exercises real HTTP.
    expected.api = {}
    for (const snapshot of [expected, actual]) {
      placeholderDocumentHashes(snapshot)
      orderSnapshotTables(snapshot)
    }
    expect(expected).deep.equals(actual)
    expect(expected.tables.game_placeholder_guests.rows).length(9)
  })

  it('rejects missing or conflicting baseline ownership and corrupted migrated history', () => {
    for (const kind of [
      'missing',
      'conflicting',
      'conflicting snapshot'
    ] as const) {
      const broken = structuredClone(original)
      const game = broken.tables.games.rows.find(
        row =>
          row.id ===
          (kind === 'conflicting snapshot' ? 'gam_snapshot' : 'gam_retained')
      )!
      const held = (game.currentPlay as any).teamStation.setupBefore
      held.players[1].teamId = kind === 'conflicting' ? 'tem_away' : ''
      if (kind !== 'missing') held.sides.home.players.push(1)
      expect(() => expectedPlaceholders(broken, migrated, [])).throws(
        'Ambiguous historical placeholder'
      )
    }
    const candidate = structuredClone(migrated)
    // Only the new empty player endpoints are supplied in this SQL-only capture.
    candidate.api = expectedPlaceholders(original, migrated, []).api
    expect(
      compareUserIds(original, candidate, { allowPlaceholders: true }).equal
    ).equals(true)
    for (const change of [
      (s: UserIdSnapshot) => {
        const game = s.tables.games.rows.find(row => row.id === 'gam_retained')!
        ;(game.currentPlay as any).teamStation.setupBefore.players[1].jersey =
          '99'
      },
      (s: UserIdSnapshot) => {
        const game = s.tables.games.rows.find(row => row.id === 'gam_snapshot')!
        ;(
          game.currentPlay as any
        ).teamStation.setupBefore.sides.home.players.push(1)
      },
      (s: UserIdSnapshot) => {
        const game = s.tables.games.rows.find(row => row.id === 'gam_renamed')!
        ;(game.currentPlay as any).teamStation.actions.push({
          type: 'pitch',
          call: 'B'
        })
      }
    ]) {
      const broken = structuredClone(candidate)
      change(broken)
      expect(
        compareUserIds(original, broken, { allowPlaceholders: true }).equal
      ).equals(false)
    }
  })

  it('matches all guest fields from the real authorized API with collisions across both sides', async () => {
    const baseline = structuredClone(original)
    for (const kind of cases) baseline.api['/games/gam_' + kind] = {}
    const expected = expectedPlaceholders(baseline, migrated, [])
    for (const kind of cases) {
      const response = await fetch(origin + '/games/gam_' + kind, {
        headers: { authorization: 'Bearer ' + token }
      })
      expect(response.status).equals(200)
      const actual = await response.json()
      const game = expected.api['/games/gam_' + kind] as JsonObject
      const players = game.guestPlayers as Record<string, JsonObject[]>
      for (const side of ['away', 'home']) {
        expect(actual.guestPlayers[side]).deep.equals(
          players[side].map(row => ({
            ...row,
            userId: userIdOfGumbo(Number(row.userId)),
            gumboId: row.userId
          }))
        )
      }
      expect(actual.guestPlayers.away[0].shortName).equals('Hank Aa')
      expect(actual.guestPlayers.home[0].shortName).equals('Hank Al')
      expect(JSON.stringify(actual.guestPlayers))
        .not.includes('Hank Aaron')
        .and.not.includes('Hank Allen')
    }
  })
})
