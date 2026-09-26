import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { asGumboPlay, asPostEventsBody } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { halfOutcomes } from '../../common/scoring/linescore'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { replaceGameEvents } from '../events/eventWrite'
import { postGamePlays } from '../events/postPlays'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import {
  eventRoutes,
  statusAfterLivePost,
  statusAfterPost,
  unknownUser
} from './events'

const adminUrl = testDatabaseUrl
const scratchName = `gamestation_events_route_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const TOKEN = 'tok_events_000000000000000000000000'
const STRANGER = 'tok_stranger_00000000000000000000'
const MEMBER = 'tok_member_000000000000000000000000'
const MANAGER = 'tok_manager_00000000000000000000000'

const admin = mintUserId(() => false)
const stranger = mintUserId(id => id === admin.userId)
const member = mintUserId(id => id === admin.userId || id === stranger.userId)
const manager = mintUserId(
  id => id === admin.userId || id === stranger.userId || id === member.userId
)

function play(input: {
  atBatIndex: number
  awayScore: number
  homeScore: number
  inning?: number
  halfInning?: 'top' | 'bottom'
  outs?: number
  halfOuts?: number
  eventType?: string
  playEvents?: unknown[]
  credits?: Array<{ teamId?: string | null; name?: string }>
  startTime?: string
}): Record<string, unknown> {
  return {
    about: {
      atBatIndex: input.atBatIndex,
      inning: input.inning ?? 1,
      halfInning: input.halfInning ?? 'top',
      isScoringPlay: input.awayScore + input.homeScore > 0,
      ...(input.halfOuts == null ? {} : { halfOuts: input.halfOuts }),
      ...(input.startTime == null ? {} : { startTime: input.startTime })
    },
    count: { outs: input.outs ?? 3 },
    result: {
      eventType: input.eventType ?? 'single',
      awayScore: input.awayScore,
      homeScore: input.homeScore,
      description: 'Single'
    },
    ...(input.playEvents == null ? {} : { playEvents: input.playEvents }),
    ...(input.credits == null ? {} : { credits: input.credits })
  }
}

describe('posting and reading plays', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const home = makeId('team')
  const away = makeId('team')
  const gameId = makeId('game')
  const lockedId = makeId('game')
  const mismatchId = makeId('game')
  const openId = makeId('game')
  const driftId = makeId('game')
  const markerId = makeId('game')
  const halvesId = makeId('game')
  const refusedId = makeId('game')
  const raceId = makeId('game')
  const unscoredId = makeId('game')
  const cancelledId = makeId('game')
  const pendingId = makeId('game')
  const outsideId = makeId('game')
  const ownId = makeId('game')
  const twiceId = makeId('game')
  const liveId = makeId('game')
  const liveAtBatId = makeId('game')
  const liveFinalId = makeId('game')
  const liveCancelledId = makeId('game')
  const liveRefusedId = makeId('game')
  const ownerlessFinalId = makeId('game')

  before(async function () {
    adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
      return
    }
    await adminPool.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    const now = new Date()
    await db
      .insertInto('users')
      .values([
        {
          id: admin.userId,
          legacyId: admin.legacyId,
          display_name: 'Ada',
          is_admin: true,
          created_at: now,
          updated_at: now
        },
        {
          id: stranger.userId,
          legacyId: stranger.legacyId,
          display_name: 'Bea',
          created_at: now,
          updated_at: now
        },
        {
          id: member.userId,
          legacyId: member.legacyId,
          display_name: 'Cam',
          created_at: now,
          updated_at: now
        },
        {
          id: manager.userId,
          legacyId: manager.legacyId,
          display_name: 'Dee',
          created_at: now,
          updated_at: now
        }
      ])
      .execute()
    await db
      .insertInto('auth_sessions')
      .values([
        {
          id: 'ses_events_admin',
          user_id: admin.userId,
          token_hash: hashToken(TOKEN),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        },
        {
          id: 'ses_events_stranger',
          user_id: stranger.userId,
          token_hash: hashToken(STRANGER),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        },
        {
          id: 'ses_events_member',
          user_id: member.userId,
          token_hash: hashToken(MEMBER),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        },
        {
          id: 'ses_events_manager',
          user_id: manager.userId,
          token_hash: hashToken(MANAGER),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Home', kind: 'full' },
        { id: away, name: 'Away', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values([
        {
          id: gameId,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        },
        {
          id: lockedId,
          home_team_id: home,
          away_team_id: away,
          start_at: now,
          scoringOwner: 'gamestation'
        },
        {
          id: mismatchId,
          home_team_id: home,
          away_team_id: away,
          start_at: now,
          away_score: 2,
          home_score: 0,
          ingest_status: 'scoreMismatch',
          ingest_message: 'already withheld'
        },
        {
          id: openId,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        },
        {
          id: driftId,
          home_team_id: home,
          away_team_id: away,
          start_at: now,
          away_score: 2,
          home_score: 0
        },
        {
          id: markerId,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        },
        {
          id: halvesId,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        },
        {
          id: refusedId,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        },
        {
          id: raceId,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        },
        {
          id: unscoredId,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        },
        {
          id: cancelledId,
          home_team_id: home,
          away_team_id: away,
          start_at: now,
          status: 'cancelled'
        },
        {
          id: pendingId,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        },
        ...[
          outsideId,
          ownId,
          twiceId,
          liveId,
          liveAtBatId,
          liveFinalId,
          liveRefusedId
        ].map(id => ({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: now
        })),
        {
          id: liveCancelledId,
          home_team_id: home,
          away_team_id: away,
          start_at: now,
          status: 'cancelled'
        },
        {
          id: ownerlessFinalId,
          home_team_id: home,
          away_team_id: away,
          start_at: now,
          status: 'final'
        }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          user_id: member.userId,
          team_id: home,
          role: 'member'
        },
        {
          id: makeId('membership'),
          user_id: manager.userId,
          team_id: home,
          role: 'manager'
        }
      ])
      .execute()

    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', eventRoutes(db))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    const address = server.address() as AddressInfo
    base = `http://127.0.0.1:${address.port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(`drop database if exists ${scratchName}`)
      await adminPool.end()
    }
  })

  async function ask(
    path: string,
    method = 'GET',
    body?: unknown,
    token: string | null = TOKEN
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json'
    }
    if (token != null) headers.authorization = `Bearer ${token}`
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
    }
  }

  it('posts a play, replaces it, and reads the half', async function () {
    const first = await ask(`/games/${gameId}/events`, 'POST', {
      plays: [
        play({
          atBatIndex: 0,
          awayScore: 2,
          homeScore: 0,
          credits: [{ teamId: 'away', name: 'Ada' }],
          startTime: '2026-05-01T18:00:00.000Z'
        })
      ],
      source: { system: 'gamestation' }
    })
    expect(first.status).equals(200)
    const plays = first.body.plays as Array<{
      id: string
      gameId: string
      gumbo: {
        about: { halfOuts?: number; atBatIndex: number }
        credits?: Array<{ teamId: string | null }>
      }
    }>
    expect(plays).to.have.length(1)
    expect(plays[0]?.gameId).equals(gameId)
    expect(plays[0]?.gumbo.about.atBatIndex).equals(0)
    expect(plays[0]?.gumbo.about.halfOuts).equals(3)
    expect(plays[0]?.gumbo.credits?.[0]?.teamId).equals(away)

    const read = await ask(`/games/${gameId}/events`)
    expect(read.status).equals(200)
    expect(read.body.plays).to.have.length(1)

    const halves = await ask(`/games/${gameId}/halves`)
    expect(halves.status).equals(200)
    expect(halves.body.halves).deep.equals([
      {
        inning: 1,
        half: 'top',
        awayScore: 2,
        homeScore: 0,
        outs: 3,
        runs: 2
      }
    ])

    const row = await db!
      .selectFrom('games')
      .select([
        'scoringOwner',
        'away_score',
        'home_score',
        'status',
        'ingest_status'
      ])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(row.scoringOwner).equals('gamestation')
    expect(row.away_score).equals(2)
    expect(row.home_score).equals(0)
    expect(row.status).equals('final')
    expect(row.ingest_status).equals('ok')

    const again = await ask(`/games/${gameId}/events`, 'POST', {
      plays: [play({ atBatIndex: 0, awayScore: 9, homeScore: 9 })],
      source: { system: 'gamestation' }
    })
    expect(again.status).equals(409)
    const still = await db!
      .selectFrom('games')
      .select(['away_score'])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(still.away_score).equals(2)

    const stored = await db!
      .selectFrom('events')
      .select(['startTime', 'source'])
      .where('gameId', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(stored.source).equals('gamestation')
    expect(stored.startTime).to.be.instanceOf(Date)
  })

  it('rejects an outside post onto a GameStation-owned game', async function () {
    const rejected = await ask(`/games/${lockedId}/events`, 'POST', {
      plays: [play({ atBatIndex: 0, awayScore: 1, homeScore: 0 })],
      source: { system: 'acme' }
    })
    expect(rejected.status).equals(409)
  })

  it('lets a scorer post and refuses a teammate who cannot score', async function () {
    const refused = await ask(
      `/games/${openId}/events`,
      'POST',
      {
        plays: [play({ atBatIndex: 0, awayScore: 1, homeScore: 0 })],
        source: { system: 'manual' }
      },
      MEMBER
    )
    expect(refused.status).equals(403)
    const posted = await ask(
      `/games/${openId}/events`,
      'POST',
      {
        plays: [play({ atBatIndex: 0, awayScore: 1, homeScore: 0 })],
        source: { system: 'manual' }
      },
      MANAGER
    )
    expect(posted.status).equals(200)
  })

  it('refuses a source system that is not spelled as one', async function () {
    const rejected = await ask(`/games/${lockedId}/events`, 'POST', {
      plays: [play({ atBatIndex: 0, awayScore: 1, homeScore: 0 })],
      source: { system: 'Acme Scorer' }
    })
    expect(rejected.status).equals(400)
  })

  it('treats any other system as an outside scorer', async function () {
    const rejected = await ask(`/games/${lockedId}/events`, 'POST', {
      plays: [play({ atBatIndex: 0, awayScore: 1, homeScore: 0 })],
      source: { system: 'teamScorer2' }
    })
    expect(rejected.status).equals(409)
  })

  it('answers 400 naming the play for a value Postgres could not store', async function () {
    const cast = await ask(`/games/${refusedId}/events`, 'POST', {
      plays: [
        {
          ...play({ atBatIndex: 3, awayScore: 1, homeScore: 0 }),
          result: { eventType: 'single', awayScore: '3a', homeScore: 0 }
        }
      ],
      source: { system: 'manual' }
    })
    expect(cast.status).equals(400)
    expect(String(cast.body.message)).contains('play 3')

    // A credit names its person by user id, never by another service's id.
    for (const credit of [
      { name: 'Ada', externalPlayerId: 'p-ada' },
      { name: 'Ada', acmePlayerId: 'p-ada' }
    ]) {
      const external = await ask(`/games/${refusedId}/events`, 'POST', {
        plays: [
          {
            ...play({ atBatIndex: 4, awayScore: 1, homeScore: 0 }),
            credits: [{ creditUserId: null, label: 'Single: Ada', credit }]
          }
        ],
        source: { system: 'manual' }
      })
      expect(external.status).equals(400)
      expect(String(external.body.message)).contains(
        'play 4: credits name people by creditUserId'
      )
    }

    // Nobody has this id, so the credit's foreign key fails in the trigger.
    const nobody = 9_007_199_254_740_000
    const ghost = await ask(`/games/${refusedId}/events`, 'POST', {
      plays: [
        play({ atBatIndex: 0, awayScore: 0, homeScore: 0 }),
        {
          ...play({ atBatIndex: 5, awayScore: 1, homeScore: 0 }),
          credits: [{ creditUserId: nobody, label: 'Ghost' }]
        }
      ],
      source: { system: 'manual' }
    })
    expect(ghost.status).equals(400)
    expect(String(ghost.body.message)).equals(
      `play 5 credits user ${nobody}, who does not exist`
    )

    // The batter, pitcher and runners go into event_players, whose user
    // foreign key fails the same way.
    const named = [
      { matchup: { batter: { id: nobody } } },
      { matchup: { batter: { id: admin.userId }, pitcher: { id: nobody } } },
      { runners: [{ details: { runner: { id: nobody } } }] }
    ]
    for (const extra of named) {
      const refused = await ask(`/games/${refusedId}/events`, 'POST', {
        plays: [
          play({ atBatIndex: 0, awayScore: 0, homeScore: 0 }),
          { ...play({ atBatIndex: 6, awayScore: 1, homeScore: 0 }), ...extra }
        ],
        source: { system: 'manual' }
      })
      expect(refused.status, JSON.stringify(extra)).equals(400)
      expect(String(refused.body.message)).equals(
        `play 6 names user ${nobody}, who does not exist`
      )
    }
    const stored = await db!
      .selectFrom('events')
      .select('id')
      .where('gameId', '=', refusedId)
      .execute()
    expect(stored).deep.equals([])
  })

  it('runs two posts to one game one after the other', async function () {
    // Both would make the game final. The second waits for the first's lock,
    // then sees a final game, instead of colliding with its plays.
    const post = async (): Promise<{ status: number }> =>
      await ask(`/games/${raceId}/events`, 'POST', {
        plays: [
          play({ atBatIndex: 0, awayScore: 0, homeScore: 0 }),
          play({ atBatIndex: 1, awayScore: 2, homeScore: 1 })
        ],
        source: { system: 'manual' }
      })
    const answers = await Promise.all([post(), post()])
    expect(
      answers.map(answer => answer.status).sort((a, b) => a - b)
    ).deep.equals([200, 409])
  })

  it('treats a post with no source as an outside scorer', async function () {
    const rejected = await ask(`/games/${lockedId}/events`, 'POST', {
      plays: [play({ atBatIndex: 0, awayScore: 1, homeScore: 0 })]
    })
    expect(rejected.status).equals(409)
  })

  it('keeps scoreMismatch when the posted totals match, and sets it when they do not', async function () {
    const same = await ask(`/games/${mismatchId}/events`, 'POST', {
      plays: [play({ atBatIndex: 0, awayScore: 2, homeScore: 0 })],
      source: { system: 'manual' }
    })
    expect(same.status).equals(200)
    const kept = await db!
      .selectFrom('games')
      .select(['ingest_status', 'ingest_message'])
      .where('id', '=', mismatchId)
      .executeTakeFirstOrThrow()
    expect(kept.ingest_status).equals('scoreMismatch')
    expect(kept.ingest_message).equals('already withheld')

    const changed = await ask(`/games/${driftId}/events`, 'POST', {
      plays: [play({ atBatIndex: 0, awayScore: 9, homeScore: 1 })],
      source: { system: 'manual' }
    })
    expect(changed.status).equals(200)
    const broken = await db!
      .selectFrom('games')
      .select(['ingest_status', 'ingest_message'])
      .where('id', '=', driftId)
      .executeTakeFirstOrThrow()
    expect(broken.ingest_status).equals('scoreMismatch')
    expect(broken.ingest_message).equals('Posted 9-1, stored 2-0')
  })

  it('uses an Inning Ended marker, keeps a posted halfOuts, and omits a final score', async function () {
    const marked = await ask(`/games/${markerId}/events`, 'POST', {
      plays: [
        play({
          atBatIndex: 0,
          awayScore: 4,
          homeScore: 0,
          outs: 1,
          playEvents: [{ type: 'inning_ended', outs: 3 }]
        }),
        play({
          atBatIndex: 1,
          awayScore: 6,
          homeScore: 0,
          inning: 2,
          outs: 1,
          halfOuts: 3
        }),
        {
          about: { atBatIndex: 2, isScoringPlay: false },
          result: {
            eventType: 'score_correction',
            awayScore: 7,
            homeScore: 0,
            description: 'Plus 1'
          }
        }
      ],
      source: { system: 'gamestation' }
    })
    expect(marked.status).equals(200)
    const halves = await ask(`/games/${markerId}/halves`)
    const list = halves.body.halves as Array<{
      inning: number
      half: string
      outs: number
      runs: number
      awayScore: number
    }>
    expect(list).to.have.length(2)
    expect(list[0]).deep.equals({
      inning: 1,
      half: 'top',
      awayScore: 4,
      homeScore: 0,
      outs: 3,
      runs: 4
    })
    expect(list[1]?.inning).equals(2)
    expect(list[1]?.runs).equals(2)
    expect(list[1]?.outs).equals(3)

    const game = await db!
      .selectFrom('games')
      .select(['linescore', 'away_score'])
      .where('id', '=', markerId)
      .executeTakeFirstOrThrow()
    expect(game.away_score).equals(7)
    const linescore = game.linescore as {
      away: { r: number; runs: number[]; h: number | null }
      home: { r: number; runs: number[]; h: number | null }
    }
    expect(linescore.away.r).equals(7)
    expect(linescore.away.runs.reduce((sum, n) => sum + n, 0)).equals(7)
    expect(linescore.home.runs).deep.equals([0])
    expect(linescore.away.h).equals(2)
    // Gumbo's innings beside the totals; nobody is counted left on base
    // without GameStation's record of every runner.
    const gumbo = game.linescore as {
      innings: Array<{ num: number; away: { runs: number } }>
      teams: { away: { runs: number; leftOnBase: number | null } }
    }
    expect(gumbo.innings.map(inning => inning.num)).deep.equals([1, 2])
    expect(gumbo.innings.map(inning => inning.away.runs)).deep.equals([4, 3])
    expect(gumbo.teams.away).deep.equals({
      runs: 7,
      hits: 2,
      errors: 0,
      leftOnBase: null
    })
  })

  it("reads each half's outs from halfOuts, else its last play's count (U21)", async function () {
    // Rows stored some way other than a post, so nothing wrote halfOuts.
    const row = (
      atBatIndex: number,
      inning: number,
      halfInning: 'top' | 'bottom',
      extra: Record<string, unknown>
    ): { gumbo: Record<string, unknown>; source: string } => ({
      gumbo: {
        about: { atBatIndex, inning, halfInning, isScoringPlay: false },
        result: { eventType: 'field_out', awayScore: 0, homeScore: 0 },
        ...extra
      },
      source: 'external'
    })
    await replaceGameEvents(db!, {
      gameId: halvesId,
      homeTeamId: home,
      awayTeamId: away,
      plays: [
        row(0, 1, 'top', { count: { outs: 1 } }),
        row(1, 1, 'top', {
          about: {
            atBatIndex: 1,
            inning: 1,
            halfInning: 'top',
            halfOuts: 3,
            isScoringPlay: false
          },
          count: { outs: 2 }
        }),
        row(2, 1, 'bottom', { count: { outs: 2 } }),
        row(3, 2, 'top', {})
      ]
    })
    const halves = await ask(`/games/${halvesId}/halves`)
    expect(halves.status).equals(200)
    const list = halves.body.halves as Array<{ outs: number }>
    expect(list.map(half => half.outs)).deep.equals([3, 2, 0])
  })

  it('writes through postGamePlays exactly what the route writes', async function () {
    const bodies: Array<Record<string, unknown>> = [
      {
        plays: [
          play({
            atBatIndex: 0,
            awayScore: 4,
            homeScore: 0,
            outs: 1,
            playEvents: [{ type: 'inning_ended', outs: 3 }],
            credits: [{ teamId: 'away', name: 'Ada' }],
            startTime: '2026-05-01T18:00:00.000Z'
          }),
          play({
            atBatIndex: 1,
            awayScore: 6,
            homeScore: 0,
            inning: 2,
            outs: 1,
            halfOuts: 3
          }),
          play({
            atBatIndex: 2,
            awayScore: 6,
            homeScore: 1,
            halfInning: 'bottom',
            inning: 2,
            outs: 2,
            eventType: 'catcher_interference'
          })
        ],
        source: { system: 'gamestation' }
      },
      {
        mode: 'live',
        source: { system: 'gamestation' },
        plays: [
          play({ atBatIndex: 0, awayScore: 1, homeScore: 0, outs: 1 }),
          play({ atBatIndex: 1, awayScore: 1, homeScore: 0, outs: 2 })
        ],
        remove: [],
        currentPlay: {
          about: {
            atBatIndex: 2,
            inning: 1,
            halfInning: 'top',
            isComplete: false
          }
        }
      }
    ]
    const now = new Date()
    let replaced = ''
    for (const body of bodies) {
      const [viaRoute, viaFunction] = [makeId('game'), makeId('game')]
      replaced ||= viaFunction
      await db!
        .insertInto('games')
        .values(
          [viaRoute, viaFunction].map(id => ({
            id,
            home_team_id: home,
            away_team_id: away,
            start_at: now
          }))
        )
        .execute()
      const posted = await ask(`/games/${viaRoute}/events`, 'POST', body)
      expect(posted.status).equals(200)
      const returned = await postGamePlays(
        db!,
        viaFunction,
        asPostEventsBody(body)
      )
      const written = async (id: string): Promise<unknown> => ({
        events: await db!
          .selectFrom('events')
          .select([
            'atBatIndex',
            'eventType',
            'startTime',
            'endTime',
            'source',
            'battingTeamId',
            'gumbo'
          ])
          .where('gameId', '=', id)
          .orderBy('atBatIndex')
          .execute(),
        game: await db!
          .selectFrom('games')
          .select([
            'linescore',
            'status',
            'away_score',
            'home_score',
            'ingest_status',
            'scoringOwner',
            'currentPlay'
          ])
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      })
      expect(await written(viaFunction)).deep.equals(await written(viaRoute))
      const gumbos = (list: unknown): unknown =>
        (list as Array<{ gumbo: unknown }>).map(row => row.gumbo)
      expect(gumbos(returned.plays)).deep.equals(gumbos(posted.body.plays))
      expect(returned.currentPlay).deep.equals(posted.body.currentPlay)
    }
    // The half's outs, the credits' teams and the listed codes it writes.
    const events = await db!
      .selectFrom('events')
      .select(['eventType', 'gumbo'])
      .where('gameId', '=', replaced)
      .orderBy('atBatIndex')
      .execute()
    const gumbo = events.map(
      row =>
        row.gumbo as {
          about: { halfOuts?: number }
          credits?: Array<{ teamId: string }>
        }
    )
    expect(gumbo.map(doc => doc.about.halfOuts)).deep.equals([3, 3, 2])
    expect(gumbo[0].credits?.[0].teamId).equals(away)
    expect(events[2].eventType).equals('catcher_interf')
  })

  it('rejects a missing atBatIndex and hides a game from a stranger', async function () {
    const missing = await ask(`/games/${gameId}/events`, 'POST', {
      plays: [{ result: { eventType: 'single' } }]
    })
    expect(missing.status).equals(400)
    const hidden = await ask(
      `/games/${gameId}/events`,
      'GET',
      undefined,
      STRANGER
    )
    expect(hidden.status).equals(404)
    const absent = await ask('/games/gam_missing/halves')
    expect(absent.status).equals(404)
    const anon = await ask(`/games/${gameId}/events`, 'GET', undefined, null)
    expect(anon.status).equals(401)
  })

  it('stores a final_score with no half and leaves hits unset', async function () {
    const only = await ask(`/games/${lockedId}/events`, 'POST', {
      plays: [
        {
          about: { atBatIndex: 0 },
          result: { eventType: 'final_score', awayScore: 5, homeScore: 2 }
        }
      ],
      source: { system: 'gamestation' }
    })
    expect(only.status).equals(200)
    expect(only.body.plays).to.have.length(1)
    const halves = await ask(`/games/${lockedId}/halves`)
    expect(halves.body.halves).deep.equals([])
    const game = await db!
      .selectFrom('games')
      .select(['linescore', 'status', 'ingest_status'])
      .where('id', '=', lockedId)
      .executeTakeFirstOrThrow()
    expect(game.status).equals('final')
    expect(game.ingest_status).equals('ok')
    const linescore = game.linescore as {
      away: { runs: number[]; h: number | null; r: number }
    }
    expect(linescore.away.runs).deep.equals([5])
    expect(linescore.away.h).equals(null)
    expect(linescore.away.r).equals(5)
  })

  it('keeps the last score a play carried when the last play carries none', async function () {
    const posted = await ask(`/games/${unscoredId}/events`, 'POST', {
      plays: [
        play({ atBatIndex: 0, awayScore: 2, homeScore: 0 }),
        play({
          atBatIndex: 1,
          awayScore: 2,
          homeScore: 1,
          halfInning: 'bottom'
        }),
        {
          about: { atBatIndex: 2, inning: 2, halfInning: 'top' },
          result: { eventType: 'stolen_base', awayScore: null, homeScore: null }
        }
      ],
      source: { system: 'manual' }
    })
    expect(posted.status).equals(200)
    const game = await db!
      .selectFrom('games')
      .select(['away_score', 'home_score', 'status'])
      .where('id', '=', unscoredId)
      .executeTakeFirstOrThrow()
    expect([game.away_score, game.home_score]).deep.equals([2, 1])
    expect(game.status).equals('final')
    const halves = await ask(`/games/${unscoredId}/halves`)
    expect(
      (halves.body.halves as Array<{ runs: number }>).map(half => half.runs)
    ).deep.equals([2, 1, 0])
  })

  it('keeps a cancelled game cancelled and starts a scheduled one', async function () {
    const stolen = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'stolen_base', awayScore: null, homeScore: null }
    }
    const statusOf = async (id: string): Promise<string> =>
      (
        await db!
          .selectFrom('games')
          .select('status')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).status
    const onCancelled = await ask(`/games/${cancelledId}/events`, 'POST', {
      plays: [stolen],
      source: { system: 'manual' }
    })
    expect(onCancelled.status).equals(200)
    expect(await statusOf(cancelledId)).equals('cancelled')
    const scored = await ask(`/games/${cancelledId}/events`, 'POST', {
      plays: [
        {
          about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
          result: { eventType: 'single', awayScore: 1, homeScore: 0 }
        }
      ],
      source: { system: 'manual' }
    })
    expect(scored.status).equals(200)
    expect(await statusOf(cancelledId)).equals('cancelled')

    const nothing = await ask(`/games/${pendingId}/events`, 'POST', {
      plays: [],
      source: { system: 'manual' }
    })
    expect(nothing.status).equals(200)
    expect(await statusOf(pendingId)).equals('scheduled')
    const started = await ask(`/games/${pendingId}/events`, 'POST', {
      plays: [stolen],
      source: { system: 'manual' }
    })
    expect(started.status).equals(200)
    expect(await statusOf(pendingId)).equals('inProgress')
  })

  it("drops an outside sender's play text and keeps GameStation's own", async function () {
    const worded = {
      ...play({ atBatIndex: 0, awayScore: 1, homeScore: 0 }),
      playEvents: [{ type: 'pitch', description: 'Ball 1' }],
      source: { id: 'kept nowhere' }
    }
    const described = async (
      id: string,
      source?: { system: string }
    ): Promise<unknown[]> => {
      const posted = await ask(`/games/${id}/events`, 'POST', {
        plays: [worded],
        ...(source == null ? {} : { source })
      })
      expect(posted.status).equals(200)
      const read = await ask(`/games/${id}/events`)
      const [stored] = read.body.plays as Array<{
        gumbo: {
          result: { description?: string }
          playEvents: Array<{ description?: string }>
          source?: unknown
        }
      }>
      expect(stored.gumbo.source).equals(undefined)
      return [
        stored.gumbo.result.description,
        stored.gumbo.playEvents[0].description
      ]
    }
    // No source counts as an outside sender, like `acme`.
    expect(await described(outsideId)).deep.equals([undefined, undefined])
    expect(await described(ownId, { system: 'gamestation' })).deep.equals([
      'Single',
      'Ball 1'
    ])
    const row = await db!
      .selectFrom('events')
      .select('gumbo')
      .where('gameId', '=', outsideId)
      .executeTakeFirstOrThrow()
    expect(JSON.stringify(row.gumbo)).not.contains('description')
  })

  it('refuses a GameStation record in a version it cannot read, naming the play, and writes nothing', async function () {
    const record = (version: unknown): unknown => ({
      version,
      setupBefore: {},
      actions: []
    })
    for (const [body, message] of [
      [
        {
          plays: [
            play({ atBatIndex: 1, awayScore: 0, homeScore: 0 }),
            {
              ...play({ atBatIndex: 2, awayScore: 0, homeScore: 0 }),
              gameStation: record(2)
            }
          ]
        },
        'Play 2: gameStation.version must be 1'
      ],
      [
        {
          plays: [],
          currentPlay: {
            about: {
              atBatIndex: 5,
              inning: 1,
              halfInning: 'top',
              isComplete: false
            },
            gameStation: record('2')
          }
        },
        'Play 5: gameStation.version must be 1'
      ],
      [
        {
          plays: [
            {
              ...play({ atBatIndex: 0, awayScore: 0, homeScore: 0 }),
              gameStation: { setupBefore: {}, actions: [] }
            }
          ]
        },
        'Play 0: gameStation.version must be 1'
      ]
    ] as const) {
      const refused = await ask(`/games/${twiceId}/events`, 'POST', {
        ...body,
        source: { system: 'gamestation' },
        mode: 'live'
      })
      expect(refused.status).equals(400)
      expect(refused.body.message).equals(message)
    }
    const stored = await db!
      .selectFrom('events')
      .select('id')
      .where('gameId', '=', twiceId)
      .execute()
    expect(stored).deep.equals([])
  })

  it('refuses two plays at one atBatIndex and writes nothing', async function () {
    const refused = await ask(`/games/${twiceId}/events`, 'POST', {
      plays: [
        play({ atBatIndex: 4, awayScore: 0, homeScore: 0 }),
        play({ atBatIndex: 4, awayScore: 1, homeScore: 0 })
      ],
      source: { system: 'manual' }
    })
    expect(refused.status).equals(400)
    expect(refused.body.message).equals('Two plays share an about.atBatIndex')
    const stored = await db!
      .selectFrom('events')
      .select('id')
      .where('gameId', '=', twiceId)
      .execute()
    expect(stored).deep.equals([])
    const game = await db!
      .selectFrom('games')
      .select(['status', 'away_score'])
      .where('id', '=', twiceId)
      .executeTakeFirstOrThrow()
    expect(game).deep.equals({ status: 'scheduled', away_score: null })
  })

  it('leaves the game owed in game_stats_state after a post', async function () {
    if (db == null) this.skip()
    const posted = await ask(`/games/${pendingId}/events`, 'POST', {
      plays: [play({ atBatIndex: 0, awayScore: 0, homeScore: 0 })],
      source: { system: 'manual' }
    })
    expect(posted.status).equals(200)
    const owed = await db
      .selectFrom('game_stats_state')
      .select(['requested_generation', 'built_generation', 'status'])
      .where('game_id', '=', pendingId)
      .executeTakeFirstOrThrow()
    expect(Number(owed.requested_generation)).greaterThan(
      Number(owed.built_generation)
    )
    expect(owed.status).equals('pending')
  })

  const live = async (
    gameId: string,
    body: Record<string, unknown>,
    token: string | null = TOKEN
  ): Promise<{ status: number; body: Record<string, unknown> }> =>
    await ask(
      `/games/${gameId}/events`,
      'POST',
      {
        mode: 'live',
        source: { system: 'gamestation' },
        plays: [],
        ...body
      },
      token
    )
  const gameRow = async (
    id: string
  ): Promise<{
    status: string
    ingest_status: string
    away_score: number | null
    currentPlay: unknown
    scoringOwner: string | null
  }> =>
    await db!
      .selectFrom('games')
      .select([
        'status',
        'ingest_status',
        'away_score',
        'currentPlay',
        'scoringOwner'
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const rows = async (
    id: string
  ): Promise<Array<{ id: string; atBatIndex: number; hidden: boolean }>> =>
    await db!
      .selectFrom('events')
      .select(['id', 'atBatIndex', 'hidden'])
      .where('gameId', '=', id)
      .orderBy('atBatIndex')
      .execute()
  const current = (
    atBatIndex: number,
    pitches = 1
  ): Record<string, unknown> => ({
    about: { atBatIndex, inning: 1, halfInning: 'top', isComplete: false },
    matchup: { batter: { id: member.userId, fullName: 'Cam' } },
    playEvents: Array.from({ length: pitches }, (_, index) => ({
      index,
      isPitch: true,
      details: { code: 'B' }
    }))
  })

  it('scores a game live without making it final or a mismatch', async function () {
    const first = await live(liveId, {
      plays: [play({ atBatIndex: 0, awayScore: 0, homeScore: 0, outs: 1 })]
    })
    expect(first.status).equals(200)
    expect(await gameRow(liveId)).deep.include({
      status: 'inProgress',
      ingest_status: 'ok',
      scoringOwner: 'gamestation'
    })
    const second = await live(liveId, {
      plays: [play({ atBatIndex: 1, awayScore: 1, homeScore: 0, outs: 1 })]
    })
    expect(second.status).equals(200)
    expect(await gameRow(liveId)).deep.include({
      status: 'inProgress',
      ingest_status: 'ok',
      away_score: 1
    })
    expect((await rows(liveId)).map(row => row.atBatIndex)).deep.equals([0, 1])
  })

  it('rewrites a play in place, keeping its row, its hidden flag and its fielder', async function () {
    const [before] = await rows(liveId)
    await db!
      .updateTable('events')
      .set({ hidden: true })
      .where('id', '=', before.id)
      .execute()
    await db!
      .insertInto('event_players')
      .values({
        id: makeId('eventPlayer'),
        event_id: before.id,
        user_id: manager.userId,
        team_id: home,
        role: 'fielder'
      })
      .execute()
    const again = await live(liveId, {
      plays: [
        play({
          atBatIndex: 0,
          awayScore: 0,
          homeScore: 0,
          outs: 2,
          eventType: 'double'
        })
      ]
    })
    expect(again.status).equals(200)
    const [after] = await rows(liveId)
    expect(after).deep.equals({ id: before.id, atBatIndex: 0, hidden: true })
    const stored = await db!
      .selectFrom('events')
      .select(['eventType'])
      .where('id', '=', before.id)
      .executeTakeFirstOrThrow()
    expect(stored.eventType).equals('double')
    const fielders = await db!
      .selectFrom('event_players')
      .select('role')
      .where('event_id', '=', before.id)
      .where('role', '=', 'fielder')
      .execute()
    expect(fielders).length(1)
  })

  const statsAsked = async (id: string): Promise<number> => {
    const row = await db!
      .selectFrom('game_stats_state')
      .select('requested_generation')
      .where('game_id', '=', id)
      .executeTakeFirst()
    return row == null ? 0 : Number(row.requested_generation)
  }

  it('deletes exactly the indexes named in remove, and nothing when none are', async function () {
    await live(liveId, {
      plays: [
        play({ atBatIndex: 2, awayScore: 1, homeScore: 0, outs: 3 }),
        play({
          atBatIndex: 9999,
          awayScore: 1,
          homeScore: 0,
          eventType: 'final_score'
        })
      ]
    })
    expect(await gameRow(liveId)).deep.include({ status: 'final' })
    expect((await rows(liveId)).map(row => row.atBatIndex)).deep.equals([
      0, 1, 2, 9999
    ])
    const correction = await live(liveId, {
      plays: [play({ atBatIndex: 1, awayScore: 1, homeScore: 0, outs: 2 })]
    })
    expect(correction.status).equals(200)
    expect((await rows(liveId)).map(row => row.atBatIndex)).deep.equals([
      0, 1, 2, 9999
    ])
    expect(await gameRow(liveId)).deep.include({ status: 'final' })
    const asked = await statsAsked(liveId)
    expect(asked).greaterThan(0)
    const removed = await live(liveId, { remove: [2] })
    expect(removed.status).equals(200)
    expect(await statsAsked(liveId)).equals(asked + 1)
    expect((await rows(liveId)).map(row => row.atBatIndex)).deep.equals([
      0, 1, 9999
    ])
    const reopened = await live(liveId, { remove: [9999] })
    expect(reopened.status).equals(200)
    expect(await gameRow(liveId)).deep.include({ status: 'inProgress' })
  })

  it('refuses an outside scorer on a game GameStation scored, final or not', async function () {
    await live(liveId, {
      plays: [
        play({
          atBatIndex: 9999,
          awayScore: 1,
          homeScore: 0,
          eventType: 'final_score'
        })
      ]
    })
    const outsider = await ask(`/games/${liveId}/events`, 'POST', {
      plays: [play({ atBatIndex: 0, awayScore: 1, homeScore: 0 })]
    })
    expect(outsider.status).equals(409)
    const ownerless = await live(ownerlessFinalId, {
      plays: [play({ atBatIndex: 0, awayScore: 1, homeScore: 0 })]
    })
    expect(ownerless.status).equals(409)
  })

  it('keeps the at-bat in progress on the game, never as a row', async function () {
    const posted = await live(liveAtBatId, { currentPlay: current(0) })
    expect(posted.status).equals(200)
    expect(posted.body.currentPlay).deep.include({ about: current(0).about })
    expect(await rows(liveAtBatId)).deep.equals([])
    const players = await db!
      .selectFrom('event_players')
      .innerJoin('events', 'events.id', 'event_players.event_id')
      .select('event_players.id')
      .where('events.gameId', '=', liveAtBatId)
      .execute()
    expect(players).deep.equals([])
    expect(await gameRow(liveAtBatId)).deep.include({ status: 'inProgress' })
    const read = await ask(`/games/${liveAtBatId}/events`)
    expect(read.body).deep.equals({ plays: [], currentPlay: current(0) })
    await live(liveAtBatId, { plays: [] })
    expect((await gameRow(liveAtBatId)).currentPlay).deep.equals(current(0))
    await live(liveAtBatId, { currentPlay: current(0, 2) })
    expect((await gameRow(liveAtBatId)).currentPlay).deep.equals(current(0, 2))
    await live(liveAtBatId, { currentPlay: null })
    expect((await gameRow(liveAtBatId)).currentPlay).equals(null)
    // An at-bat in progress changes no stats, so none are asked for.
    expect(await statsAsked(liveAtBatId)).equals(0)
  })

  it('leaves a cancelled game cancelled and refuses a teammate who cannot score', async function () {
    const cancelled = await live(liveCancelledId, {
      plays: [play({ atBatIndex: 0, awayScore: 1, homeScore: 0 })],
      currentPlay: current(1)
    })
    expect(cancelled.status).equals(200)
    expect(await gameRow(liveCancelledId)).deep.include({ status: 'cancelled' })
    const refused = await live(
      liveRefusedId,
      { currentPlay: current(0) },
      MEMBER
    )
    expect(refused.status).equals(403)
  })

  it('answers 400 to a replace post with live fields, and to a play both posted and removed', async function () {
    const withCurrent = await ask(`/games/${liveRefusedId}/events`, 'POST', {
      plays: [],
      currentPlay: current(0)
    })
    expect(withCurrent.status).equals(400)
    const withRemove = await ask(`/games/${liveRefusedId}/events`, 'POST', {
      plays: [],
      remove: [0]
    })
    expect(withRemove.status).equals(400)
    const both = await live(liveRefusedId, {
      plays: [play({ atBatIndex: 0, awayScore: 0, homeScore: 0 })],
      remove: [0]
    })
    expect(both.status).equals(400)
    expect(both.body.message).equals('A play is both posted and removed')
  })
})

describe('the status a live post leaves', function () {
  it('is final with a final score, under way with plays or an at-bat, and cancelled stays', function () {
    const final = [{ eventType: 'single' }, { eventType: 'final_score' }]
    expect(statusAfterLivePost('inProgress', final, false)).equals('final')
    expect(
      statusAfterLivePost('final', [{ eventType: 'single' }], false)
    ).equals('inProgress')
    expect(statusAfterLivePost('scheduled', [], true)).equals('inProgress')
    expect(statusAfterLivePost('scheduled', [], false)).equals('scheduled')
    expect(statusAfterLivePost('cancelled', final, true)).equals('cancelled')
  })
})

describe('the status a post leaves', function () {
  it('finishes a game only when both scores are known', function () {
    const both = { away: 3, home: 2 }
    const one = { away: 3, home: null }
    expect(statusAfterPost('scheduled', both, 4)).equals('final')
    expect(statusAfterPost('inProgress', both, 4)).equals('final')
    expect(statusAfterPost('scheduled', one, 4)).equals('inProgress')
    expect(statusAfterPost('scheduled', one, 0)).equals('scheduled')
    expect(statusAfterPost('inProgress', one, 0)).equals('inProgress')
  })

  it('leaves a cancelled game cancelled', function () {
    expect(statusAfterPost('cancelled', { away: 3, home: 2 }, 4)).equals(
      'cancelled'
    )
    expect(statusAfterPost('cancelled', { away: 3, home: null }, 4)).equals(
      'cancelled'
    )
    expect(statusAfterPost('cancelled', { away: null, home: null }, 0)).equals(
      'cancelled'
    )
  })
})

describe('the outcome of each half', function () {
  const row = (
    atBatIndex: number,
    inning: number,
    halfInning: 'top' | 'bottom',
    awayScore: number | null,
    homeScore: number | null
  ): Parameters<typeof halfOutcomes>[0][number] =>
    asGumboPlay({
      about: { atBatIndex, inning, halfInning },
      result: { eventType: 'single', awayScore, homeScore }
    })

  it('scores no runs for a half whose last play carries no score', function () {
    const halves = halfOutcomes([
      row(0, 1, 'top', 3, 0),
      row(1, 1, 'bottom', null, null),
      row(2, 2, 'top', null, null),
      row(3, 2, 'bottom', 3, 2)
    ])
    expect(halves.map(half => half.runs)).deep.equals([3, 0, 0, 2])
  })
})

describe('a play naming a user who does not exist', function () {
  const plays = [
    asGumboPlay({
      about: { atBatIndex: 2 },
      result: { eventType: 'single' },
      credits: [{ creditUserId: 11 }],
      matchup: { batter: { id: 12 } }
    })
  ]
  const missing = (
    table: string,
    detail: string
  ): { code: string; table: string; detail: string } => ({
    code: '23503',
    table,
    detail
  })

  it('names the play when it can find it', function () {
    expect(
      unknownUser(
        missing('eventCredits', 'Key (creditUserId)=(11) is not present'),
        plays
      )?.message
    ).equals('play 2 credits user 11, who does not exist')
    expect(
      unknownUser(
        missing('event_players', 'Key (user_id)=(12) is not present'),
        plays
      )?.message
    ).equals('play 2 names user 12, who does not exist')
  })

  it('still answers 400 when it cannot', function () {
    const credit = unknownUser(
      missing('eventCredits', 'Key (creditUserId)=(99) is not present'),
      plays
    )
    expect(credit?.message).equals('A credit names a user who does not exist')
    expect(credit).to.have.property('status', 400)
    expect(
      unknownUser(missing('eventCredits', 'something else'), plays)?.message
    ).equals('A credit names a user who does not exist')
    expect(
      unknownUser(
        missing('event_players', 'Key (user_id)=(99) is not present'),
        plays
      )?.message
    ).equals('A play names user 99, who does not exist')
  })

  it('leaves every other failure alone', function () {
    expect(
      unknownUser(
        missing('event_players', 'Key (team_id)=(tea_x) is not present'),
        plays
      )
    ).equals(undefined)
    expect(unknownUser(missing('games', 'Key (id)=(1)'), plays)).equals(
      undefined
    )
    expect(unknownUser({ code: '22003' }, plays)).equals(undefined)
    expect(unknownUser(new Error('boom'), plays)).equals(undefined)
    expect(unknownUser(null, plays)).equals(undefined)
  })
})
