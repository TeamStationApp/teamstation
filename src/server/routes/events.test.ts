import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import {
  type TagDocument,
  tagMetadata,
  tagTargets
} from '../../common/eventTags'
import {
  asGumboPlay,
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import type { ScoringAction } from '../../common/scoring/actions'
import { halfOutcomes } from '../../common/scoring/linescore'
import { newSetup } from '../../common/scoring/lineup'
import {
  type EventStore,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { type PlayWrite, replaceGameEvents } from '../events/eventWrite'
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
const scratchName = `teamstation_events_route_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

/** Scoring equivalence excludes opaque annotation identities, tested separately. */
function withoutTagTargets(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) =>
      key === 'tagTargets' ? undefined : item
    )
  )
}

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
/** One person per role flag on the home team, each a member of it. */
const FLAGS = ['scorekeeper', 'coach', 'songkeeper', 'videographer'] as const
const flagged = new Map<
  (typeof FLAGS)[number],
  { userId: number; legacyId: string; token: string }
>()
for (const flag of FLAGS) {
  const taken = new Set([
    admin.userId,
    stranger.userId,
    member.userId,
    manager.userId,
    ...[...flagged.values()].map(one => one.userId)
  ])
  flagged.set(flag, {
    ...mintUserId(id => taken.has(id)),
    token: `tok_${flag}_`.padEnd(35, '0')
  })
}
function flagUser(flag: (typeof FLAGS)[number]): {
  userId: number
  legacyId: string
  token: string
} {
  const held = flagged.get(flag)
  if (held == null) throw new Error(flag)
  return held
}

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
    playEvents: input.playEvents ?? [{ isPitch: true }],
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
  const flagsId = makeId('game')
  const staleId = makeId('game')

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
          display_name: 'Adam Dunn',
          is_admin: true,
          created_at: now,
          updated_at: now
        },
        {
          id: stranger.userId,
          legacyId: stranger.legacyId,
          display_name: 'Babe Ruth',
          created_at: now,
          updated_at: now
        },
        {
          id: member.userId,
          legacyId: member.legacyId,
          display_name: 'Cam Bedrosian',
          created_at: now,
          updated_at: now
        },
        {
          id: manager.userId,
          legacyId: manager.legacyId,
          display_name: 'Dee Gordon',
          created_at: now,
          updated_at: now
        },
        ...FLAGS.map(flag => ({
          id: flagUser(flag).userId,
          legacyId: flagUser(flag).legacyId,
          display_name: flag,
          created_at: now,
          updated_at: now
        }))
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
        },
        ...FLAGS.map(flag => ({
          id: `ses_events_${flag}`,
          user_id: flagUser(flag).userId,
          token_hash: hashToken(flagUser(flag).token),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        }))
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
          scoringOwner: 'teamstation'
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
          liveRefusedId,
          flagsId,
          staleId
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
        },
        ...FLAGS.map(flag => ({
          id: makeId('membership'),
          user_id: flagUser(flag).userId,
          team_id: home,
          role: 'member' as const
        }))
      ])
      .execute()
    await db
      .insertInto('scope_roles')
      .values(
        FLAGS.map(flag => ({
          id: makeId('scopeRole'),
          user_id: flagUser(flag).userId,
          scope_type: 'team' as const,
          scope_id: home,
          role: flag
        }))
      )
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
          credits: [{ teamId: 'away', name: 'Adam Dunn' }],
          startTime: '2026-05-01T18:00:00.000Z'
        })
      ],
      source: { system: 'teamstation' }
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
    expect(row.scoringOwner).equals('teamstation')
    expect(row.away_score).equals(2)
    expect(row.home_score).equals(0)
    expect(row.status).equals('final')
    expect(row.ingest_status).equals('ok')

    const again = await ask(`/games/${gameId}/events`, 'POST', {
      plays: [play({ atBatIndex: 0, awayScore: 9, homeScore: 9 })],
      source: { system: 'teamstation' }
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
    expect(stored.source).equals('teamstation')
    expect(stored.startTime).to.be.instanceOf(Date)
  })

  it('rejects an outside post onto a TeamStation-owned game', async function () {
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

  it('lets a scorekeeper post, and refuses a coach, a songkeeper and a videographer', async function () {
    const body = {
      plays: [play({ atBatIndex: 0, awayScore: 1, homeScore: 0 })],
      source: { system: 'manual' }
    }
    for (const flag of ['coach', 'songkeeper', 'videographer'] as const) {
      const refused = await ask(
        `/games/${flagsId}/events`,
        'POST',
        body,
        flagUser(flag).token
      )
      expect(refused.status, flag).equals(403)
    }
    const posted = await ask(
      `/games/${flagsId}/events`,
      'POST',
      body,
      flagUser('scorekeeper').token
    )
    // An administrator of the team, who holds every flag, still may: the
    // test above has the manager posting.
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
      { name: 'Adam Dunn', externalPlayerId: 'p-ada' },
      { name: 'Adam Dunn', acmePlayerId: 'p-ada' }
    ]) {
      const external = await ask(`/games/${refusedId}/events`, 'POST', {
        plays: [
          {
            ...play({ atBatIndex: 4, awayScore: 1, homeScore: 0 }),
            credits: [
              { creditUserId: null, label: 'Single: Adam Dunn', credit }
            ]
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
      source: { system: 'teamstation' }
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
    // without TeamStation's record of every runner.
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
      extra: Partial<GumboPlay>
    ): PlayWrite => ({
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
            credits: [{ teamId: 'away', name: 'Adam Dunn' }],
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
        source: { system: 'teamstation' }
      },
      {
        mode: 'live',
        source: { system: 'teamstation' },
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
      expect(withoutTagTargets(await written(viaFunction))).deep.equals(
        withoutTagTargets(await written(viaRoute))
      )
      const gumbos = (list: unknown): unknown =>
        (list as Array<{ gumbo: unknown }>).map(row => row.gumbo)
      expect(withoutTagTargets(gumbos(returned.plays))).deep.equals(
        withoutTagTargets(gumbos(posted.body.plays))
      )
      expect(withoutTagTargets(returned.currentPlay)).deep.equals(
        withoutTagTargets(posted.body.currentPlay)
      )
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
      source: { system: 'teamstation' }
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

  it("stores older imports' own names as the listed codes (U26)", async function () {
    const legacyId = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id: legacyId,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const codes = [
      'runner_out',
      'batter_out',
      'catcher_s_interference',
      'fc_double_play',
      'offensive_interference',
      'batter_put_on_base',
      'inning_changed_by_scorekeeper'
    ]
    const posted = await ask(`/games/${legacyId}/events`, 'POST', {
      plays: codes.map((eventType, atBatIndex) =>
        play({ atBatIndex, awayScore: 0, homeScore: 0, eventType })
      )
    })
    expect(posted.status).equals(200)
    const rows = await db!
      .selectFrom('events')
      .select('eventType')
      .where('gameId', '=', legacyId)
      .orderBy('atBatIndex')
      .execute()
    expect(rows.map(row => row.eventType)).deep.equals([
      'other_out',
      'field_out',
      'catcher_interf',
      'double_play',
      'batter_interference',
      'ts_manual_placement',
      'final_score'
    ])
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
    expect(await statusOf(pendingId)).equals('scheduled')
  })

  it('keeps an attributed withdrawal cancelled when a delayed score update arrives', async function () {
    const game = await db!
      .selectFrom('games')
      .selectAll()
      .where('id', '=', cancelledId)
      .executeTakeFirstOrThrow()
    const when = new Date()
    await db!
      .updateTable('games')
      .set({
        cancellation_reason: 'withdrawal',
        withdrawn_by_team_id: game.home_team_id,
        withdrawn_by_user_id: admin.userId,
        withdrawn_at: when
      })
      .where('id', '=', cancelledId)
      .execute()
    const scored = await ask(`/games/${cancelledId}/events`, 'POST', {
      plays: [
        {
          about: { atBatIndex: 0 },
          result: { eventType: 'final_score', awayScore: 1, homeScore: 2 }
        }
      ],
      source: { system: 'manual' }
    })
    expect(scored.status).equals(200)
    const retained = await db!
      .selectFrom('games')
      .selectAll()
      .where('id', '=', cancelledId)
      .executeTakeFirstOrThrow()
    expect(retained.status).equals('cancelled')
    expect(retained.cancellation_reason).equals('withdrawal')
    expect(retained.withdrawn_by_team_id).equals(game.home_team_id)
    expect(retained.withdrawn_by_user_id).equals(admin.userId)
    expect(retained.withdrawn_at!.getTime()).equals(when.getTime())
    await db!
      .updateTable('games')
      .set({
        cancellation_reason: null,
        withdrawn_by_team_id: null,
        withdrawn_by_user_id: null,
        withdrawn_at: null
      })
      .where('id', '=', cancelledId)
      .execute()
  })

  it("drops an outside sender's play text and keeps TeamStation's own", async function () {
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
    expect(await described(ownId, { system: 'teamstation' })).deep.equals([
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

  it('refuses malformed or unsupported TeamStation records, naming the play, and writes nothing', async function () {
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
              teamStation: record(2)
            }
          ]
        },
        'Play 2: teamStation must be a valid version 1 or 2 record'
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
            teamStation: record('2')
          }
        },
        'Play 5: teamStation must be a valid version 1 or 2 record'
      ],
      [
        {
          plays: [
            {
              ...play({ atBatIndex: 0, awayScore: 0, homeScore: 0 }),
              teamStation: { setupBefore: {}, actions: [] }
            }
          ]
        },
        'Play 0: teamStation must be a valid version 1 or 2 record'
      ]
    ] as const) {
      const refused = await ask(`/games/${twiceId}/events`, 'POST', {
        ...body,
        source: { system: 'teamstation' },
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
        source: { system: 'teamstation' },
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
    matchup: { batter: { id: member.userId, fullName: 'Cam Bedrosian' } },
    playEvents: Array.from({ length: pitches }, (_, index) => ({
      index,
      pitchNumber: index + 1,
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
      scoringOwner: 'teamstation'
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

  it('refuses an outside scorer on a game TeamStation scored, final or not', async function () {
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
    const { lineupsDigest, playsDigest, ...events } = read.body
    expect(withoutTagTargets(events)).deep.equals({
      plays: [],
      currentPlay: current(0)
    })
    expect(lineupsDigest).equals(posted.body.lineupsDigest)
    expect(playsDigest).equals(posted.body.playsDigest)
    await live(liveAtBatId, { plays: [] })
    expect(
      withoutTagTargets((await gameRow(liveAtBatId)).currentPlay)
    ).deep.equals(current(0))
    await live(liveAtBatId, { currentPlay: current(0, 2) })
    expect(
      withoutTagTargets((await gameRow(liveAtBatId)).currentPlay)
    ).deep.equals(current(0, 2))
    await live(liveAtBatId, { currentPlay: null })
    expect((await gameRow(liveAtBatId)).currentPlay).equals(null)
    // An at-bat in progress changes no stats, so none are asked for.
    expect(await statsAsked(liveAtBatId)).equals(0)
  })

  it('answers a digest of the plays, and of the game as each live post found it', async function () {
    const id = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const read = await ask(`/games/${id}/events`)
    const opened = read.body.playsDigest as string
    expect(opened).match(/^[0-9a-f]{64}$/)
    const first = await live(id, { currentPlay: current(0) })
    expect(first.body.priorPlaysDigest).equals(opened)
    const mine = first.body.playsDigest as string
    expect(mine).not.equals(opened)
    expect((await ask(`/games/${id}/events`)).body.playsDigest).equals(mine)
    // Another post in between: the next one finds a game it did not leave.
    const theirs = await live(id, { currentPlay: current(0, 2) })
    expect(theirs.body.priorPlaysDigest).equals(mine)
    const next = await live(id, { currentPlay: current(0, 3) })
    expect(next.body.priorPlaysDigest).equals(theirs.body.playsDigest)
    expect(next.body.priorPlaysDigest).not.equals(mine)
    // A replace post answers the digest, and found nothing it compares.
    const replaced = await ask(`/games/${id}/events`, 'POST', {
      source: { system: 'teamstation' },
      plays: []
    })
    expect(replaced.body.priorPlaysDigest).equals(null)
    expect(replaced.body.playsDigest).equals(
      (await ask(`/games/${id}/events`)).body.playsDigest
    )
  })

  it('refuses a live post built on lineups that have changed since, and writes nothing (stale)', async function () {
    // A game no live post has written yet keeps no digest: it is worked out.
    const read = await ask(`/games/${staleId}/events`)
    expect(read.status).equals(200)
    const base = read.body.lineupsDigest as string
    expect(base).match(/^[0-9a-f]{64}$/)
    const stale = await live(staleId, {
      currentPlay: current(0),
      lineupsBase: 'not-the-lineups'
    })
    expect(stale.status).equals(409)
    expect(stale.body).deep.equals({
      code: 'conflict',
      message: 'Somebody else changed the lineups since this game was read',
      details: { stale: true }
    })
    expect((await gameRow(staleId)).currentPlay).equals(null)
    // Built on the lineups as they stand, it is written, and its answer
    // carries the digest the next post names.
    const matching = await live(staleId, {
      currentPlay: current(0),
      lineupsBase: base
    })
    expect(matching.status).equals(200)
    const kept = await db!
      .selectFrom('games')
      .select('lineups_digest')
      .where('id', '=', staleId)
      .executeTakeFirstOrThrow()
    expect(matching.body.lineupsDigest).equals(kept.lineups_digest)
    expect((await ask(`/games/${staleId}/events`)).body.lineupsDigest).equals(
      kept.lineups_digest
    )
    // A post that names none is written as before.
    expect((await live(staleId, { currentPlay: current(0, 2) })).status).equals(
      200
    )
    // A replace post is never checked.
    const replaced = await ask(`/games/${staleId}/events`, 'POST', {
      source: { system: 'teamstation' },
      plays: [],
      lineupsBase: 'not-the-lineups'
    })
    expect(replaced.status).equals(200)
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
  it('retains surviving pitch tags through metadata-free Undo with or without removing the completed row', async () => {
    for (const remove of [false, true]) {
      const id = makeId('game')
      await db!
        .insertInto('games')
        .values({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date()
        })
        .execute()
      const events = current(0, 4).playEvents as unknown[]
      const walk = play({
        atBatIndex: 0,
        awayScore: 0,
        homeScore: 0,
        outs: 0,
        eventType: 'walk',
        playEvents: events
      })
      const posted = await live(id, { plays: [walk], currentPlay: null })
      const targets = tagTargets(
        (posted.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
      )
      const first = targets[0]
      const last = targets[3]
      await ask(`/games/${id}/tags/${first.id}`, 'PUT', {
        tag: 'surviving pitch'
      })
      await ask(`/games/${id}/tags/${last.id}`, 'PUT', { tag: 'removed pitch' })
      const undone = await live(id, {
        plays: [],
        remove: remove ? [0] : [],
        currentPlay: current(0, 3)
      })
      expect(undone.status).equals(200)
      expect(
        tagTargets(undone.body.currentPlay as TagDocument)[0]
      ).deep.includes({ id: first.id, tag: 'surviving pitch' })
      expect((await ask('/tags')).body.popular).not.deep.includes({
        tag: 'removed pitch',
        count: 1
      })
      const again = await live(id, { plays: [walk], currentPlay: null })
      const after = tagTargets(
        (again.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
      )
      expect(after[0]).deep.includes({ id: first.id, tag: 'surviving pitch' })
      expect(after[3].id).not.equals(last.id)
      expect(after[3].tag).equals(null)
      await ask(`/games/${id}/tags/${first.id}`, 'DELETE')
    }
  })

  it('keeps a tagged current pitch when an older client completes without metadata', async () => {
    const id = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const ongoing = current(0)
    const posted = await live(id, { currentPlay: ongoing })
    const pitch = tagTargets(posted.body.currentPlay as TagDocument)[0]
    expect(
      (
        await ask(`/games/${id}/tags/${pitch.id}`, 'PUT', {
          tag: 'great pitch'
        })
      ).status
    ).equals(200)
    const completed = play({
      atBatIndex: 0,
      awayScore: 0,
      homeScore: 0,
      playEvents: ongoing.playEvents as unknown[]
    })
    const answer = await live(id, { plays: [completed], currentPlay: null })
    expect(answer.status).equals(200)
    const saved = (answer.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
    expect(tagTargets(saved)[0]).deep.includes({
      id: pitch.id,
      tag: 'great pitch'
    })
    expect((await ask('/tags')).body.popular).deep.includes({
      tag: 'great pitch',
      count: 1
    })
    expect(
      (await ask(`/games/${id}/tags/${pitch.id}`, 'DELETE')).status
    ).equals(200)
  })

  for (const [beforeCalls, afterCalls] of [
    [
      ['B', 'C', 'B'],
      ['C', 'C', 'B']
    ],
    [
      ['B', 'F', 'B'],
      ['F', 'F', 'B', 'F', 'B']
    ]
  ])
    it(`keeps unchanged later pitch tags after metadata-free ${beforeCalls.join(',')} to ${afterCalls.join(',')}`, async () => {
      const id = makeId('game')
      await db!
        .insertInto('games')
        .values({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date()
        })
        .execute()
      const document = (calls: string[]): ReturnType<typeof play> =>
        play({
          atBatIndex: 0,
          awayScore: 0,
          homeScore: 0,
          playEvents: calls.map((code, index) => ({
            index,
            pitchNumber: index + 1,
            type: 'pitch',
            isPitch: true,
            details: { code }
          }))
        })
      const first = await live(id, { plays: [document(beforeCalls)] })
      const before = tagTargets(
        (first.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
      )
      for (let index = 0; index < 3; index++) {
        expect(
          (
            await ask(`/games/${id}/tags/${before[index].id}`, 'PUT', {
              tag: `corrected pitch ${index}`
            })
          ).status
        ).equals(200)
      }
      const changed = await live(id, { plays: [document(afterCalls)] })
      expect(changed.status).equals(200)
      const after = tagTargets(
        (changed.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
      )
      expect(after[0].id).not.equals(before[0].id)
      expect(after[0].tag).equals(null)
      for (const target of after
        .slice(3)
        .filter(target => target.eventIndex != null)) {
        expect(before.map(original => original.id)).not.includes(target.id)
        expect(target.tag).equals(null)
      }
      expect(after[1]).deep.includes({
        id: before[1].id,
        tag: 'corrected pitch 1'
      })
      expect(after[2]).deep.includes({
        id: before[2].id,
        tag: 'corrected pitch 2'
      })
      const assignments = await db!
        .selectFrom('event_tags')
        .select(['target_id', 'tag'])
        .where('game_id', '=', id)
        .orderBy('tag')
        .execute()
      expect(assignments).deep.equals([
        { target_id: before[1].id, tag: 'corrected pitch 1' },
        { target_id: before[2].id, tag: 'corrected pitch 2' }
      ])
      await db!.deleteFrom('games').where('id', '=', id).execute()
    })

  for (const complete of [true, false])
    it(`preserves numbered pitch tags through metadata-free action insertion/removal in ${complete ? 'completed' : 'current'} plays`, async () => {
      const id = makeId('game')
      await db!
        .insertInto('games')
        .values({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date()
        })
        .execute()
      const pitchEvents = [1, 2].map(pitchNumber => ({
        index: pitchNumber - 1,
        type: 'pitch',
        isPitch: true,
        pitchNumber,
        details: { code: 'B', description: 'Ball outside.' }
      }))
      const original = play({
        atBatIndex: 0,
        awayScore: 0,
        homeScore: 0,
        playEvents: pitchEvents
      })
      original.about = {
        ...(original.about as Record<string, unknown>),
        isComplete: complete
      }
      const write = async (
        document: ReturnType<typeof play>
      ): Promise<{ status: number; body: Record<string, unknown> }> =>
        await live(
          id,
          complete
            ? { plays: [document] }
            : { plays: [], currentPlay: document }
        )
      const read = (response: {
        body: Record<string, unknown>
      }): TagDocument =>
        complete
          ? (response.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
          : (response.body.currentPlay as TagDocument)
      const first = await write(original)
      expect(first.status).equals(200)
      const pitches = tagTargets(read(first)).filter(
        target => target.eventIndex != null
      )
      for (let index = 0; index < pitches.length; index++)
        expect(
          (
            await ask(`/games/${id}/tags/${pitches[index].id}`, 'PUT', {
              tag: `numbered pitch ${index}`
            })
          ).status
        ).equals(200)
      const inserted = await write({
        ...original,
        playEvents: [
          {
            index: 0,
            type: 'action',
            isPitch: false,
            details: { eventType: 'pickoff', description: 'Pickoff attempt.' }
          },
          ...pitchEvents.map((event, index) => ({
            ...event,
            index: index + 1
          }))
        ]
      })
      expect(inserted.status).equals(200)
      const after = tagTargets(read(inserted)).filter(
        target => target.eventIndex != null
      )
      expect(after[0].tag).equals(null)
      for (let index = 0; index < pitches.length; index++)
        expect(after[index + 1]).deep.includes({
          id: pitches[index].id,
          tag: `numbered pitch ${index}`
        })
      expect(
        (
          await ask(`/games/${id}/tags/${after[0].id}`, 'PUT', {
            tag: 'prefix action'
          })
        ).status
      ).equals(200)
      const removed = await write(original)
      expect(removed.status).equals(200)
      expect(
        tagTargets(read(removed))
          .filter(target => target.eventIndex != null)
          .map(target => ({ id: target.id, tag: target.tag }))
      ).deep.equals(
        pitches.map((target, index) => ({
          id: target.id,
          tag: `numbered pitch ${index}`
        }))
      )
      expect(
        (await ask(`/games/${id}/tags/${after[0].id}`, 'DELETE')).status
      ).equals(404)
      expect(
        await db!
          .selectFrom('event_tags')
          .select('target_id')
          .where('game_id', '=', id)
          .execute()
      ).has.length(2)
      await db!.deleteFrom('games').where('id', '=', id).execute()
    })

  it('retains substitution tags when unchanged position keys and legacy signatures reorder across JSONB', async () => {
    const id = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const position = {
      code: '1',
      name: 'Pitcher',
      type: 'Pitcher',
      abbreviation: 'P'
    }
    const action = {
      index: 0,
      type: 'action',
      isPitch: false,
      details: {
        eventType: 'pitching_substitution',
        description: 'Pitching substitution.'
      },
      position,
      player: { id: member.userId }
    }
    const original = play({
      atBatIndex: 0,
      awayScore: 0,
      homeScore: 0,
      playEvents: [action]
    })
    const posted = await live(id, { plays: [original] })
    const document = (posted.body.plays as Array<{ gumbo: TagDocument }>)[0]
      .gumbo
    const target = tagTargets(document)[0]
    expect(
      (
        await ask(`/games/${id}/tags/${target.id}`, 'PUT', {
          tag: 'great relief'
        })
      ).status
    ).equals(200)
    const stored = await db!
      .selectFrom('events')
      .select(['id', 'gumbo'])
      .where('gameId', '=', id)
      .executeTakeFirstOrThrow()
    const gumbo = stored.gumbo as TagDocument
    const legacy = tagMetadata(gumbo)
    const signature = JSON.parse(legacy.events[0].signature) as unknown[]
    signature[6] = position
    legacy.events[0].signature = JSON.stringify(signature)
    await db!
      .updateTable('events')
      .set({ gumbo: { ...gumbo, tagTargets: legacy } })
      .where('id', '=', stored.id)
      .execute()
    const reordered = {
      ...action,
      position: {
        abbreviation: 'P',
        type: 'Pitcher',
        name: 'Pitcher',
        code: '1'
      }
    }
    const saved = await live(id, {
      plays: [{ ...original, playEvents: [reordered] }]
    })
    expect(saved.status).equals(200)
    expect(
      tagTargets(
        (saved.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
      )[0]
    ).deep.includes({ id: target.id, tag: 'great relief' })
    expect(
      await db!
        .selectFrom('event_tags')
        .select(['target_id', 'tag'])
        .where('game_id', '=', id)
        .execute()
    ).deep.equals([{ target_id: target.id, tag: 'great relief' }])
    await db!.deleteFrom('games').where('id', '=', id).execute()
  })

  for (const complete of [true, false])
    it(`preserves a tagged substitution through pickoff insertion/removal in ${complete ? 'completed' : 'current'} legacy saves`, async () => {
      const id = makeId('game')
      await db!
        .insertInto('games')
        .values({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date()
        })
        .execute()
      const substitution = {
        index: 0,
        type: 'action',
        isPitch: false,
        details: {
          eventType: 'pitching_substitution',
          description: 'Pitching substitution.'
        },
        player: { id: member.userId },
        position: {
          code: '1',
          name: 'Pitcher',
          type: 'Pitcher',
          abbreviation: 'P'
        }
      }
      const original = play({
        atBatIndex: 0,
        awayScore: 0,
        homeScore: 0,
        playEvents: [substitution]
      })
      original.about = {
        ...(original.about as Record<string, unknown>),
        isComplete: complete
      }
      const write = async (
        document: ReturnType<typeof play>
      ): Promise<{ status: number; body: Record<string, unknown> }> =>
        await live(
          id,
          complete
            ? { plays: [document] }
            : { plays: [], currentPlay: document }
        )
      const read = (response: {
        body: Record<string, unknown>
      }): TagDocument =>
        complete
          ? (response.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
          : (response.body.currentPlay as TagDocument)
      const first = await write(original)
      const target = tagTargets(read(first))[0]
      expect(
        (
          await ask(`/games/${id}/tags/${target.id}`, 'PUT', {
            tag: 'great relief'
          })
        ).status
      ).equals(200)
      const changed = {
        ...substitution,
        index: 1,
        position: {
          code: '1',
          name: 'Localized pitcher',
          type: 'Localized role',
          abbreviation: 'P'
        }
      }
      const inserted = await write({
        ...original,
        playEvents: [
          {
            index: 0,
            type: 'action',
            isPitch: false,
            details: { eventType: 'pickoff', description: 'Pickoff attempt.' }
          },
          changed
        ]
      })
      expect(inserted.status).equals(200)
      const after = tagTargets(read(inserted))
      expect(after[0].id).not.equals(target.id)
      expect(after[0].tag).equals(null)
      expect(after[1]).deep.includes({ id: target.id, tag: 'great relief' })
      expect(
        (
          await db!
            .selectFrom('event_tags')
            .select('event_index')
            .where('game_id', '=', id)
            .executeTakeFirstOrThrow()
        ).event_index
      ).equals(1)
      const removed = await write(original)
      expect(removed.status).equals(200)
      expect(tagTargets(read(removed))[0]).deep.includes({
        id: target.id,
        tag: 'great relief'
      })
      expect(
        (
          await db!
            .selectFrom('event_tags')
            .select('event_index')
            .where('game_id', '=', id)
            .executeTakeFirstOrThrow()
        ).event_index
      ).equals(0)
      expect(
        await db!
          .selectFrom('event_tags')
          .select(['target_id', 'tag'])
          .where('game_id', '=', id)
          .execute()
      ).deep.equals([{ target_id: target.id, tag: 'great relief' }])
      await db!.deleteFrom('games').where('id', '=', id).execute()
    })

  it('rejects ambiguous tagged metadata-free activity edits without changing events or assignments', async () => {
    const id = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const pickoff = {
      type: 'action',
      isPitch: false,
      details: { eventType: 'pickoff' }
    }
    const original = play({
      atBatIndex: 0,
      awayScore: 0,
      homeScore: 0,
      playEvents: [
        { ...pickoff, index: 0 },
        { ...pickoff, index: 1 }
      ]
    })
    const first = await live(id, { plays: [original] })
    const document = (first.body.plays as Array<{ gumbo: TagDocument }>)[0]
      .gumbo
    const targets = tagTargets(document)
    expect(
      (
        await ask(`/games/${id}/tags/${targets[0].id}`, 'PUT', {
          tag: 'quick throw'
        })
      ).status
    ).equals(200)
    const before = await ask(`/games/${id}/events`)
    const altered = {
      ...original,
      playEvents: [
        {
          type: 'action',
          isPitch: false,
          index: 0,
          details: { eventType: 'stolen_base' }
        },
        { ...pickoff, index: 1 },
        { ...pickoff, index: 2 }
      ]
    }
    const rejected = await live(id, { plays: [altered] })
    expect(rejected.status).equals(409)
    expect(rejected.body.message).includes('action history changed')
    expect((await ask(`/games/${id}/events`)).body).deep.equals(before.body)
    expect(
      await db!
        .selectFrom('event_tags')
        .select(['target_id', 'tag'])
        .where('game_id', '=', id)
        .execute()
    ).deep.equals([{ target_id: targets[0].id, tag: 'quick throw' }])
    await db!.deleteFrom('games').where('id', '=', id).execute()
  })

  it('rejects first-removal or first-insertion of same-kind timed activities but preserves proven append/tail Undo', async () => {
    const id = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const activities = [1, 2].map(second => ({
      type: 'action',
      isPitch: false,
      index: second - 1,
      startTime: `2026-10-08T20:00:0${second}Z`,
      details: { eventType: 'pickoff' }
    }))
    const original = play({
      atBatIndex: 0,
      awayScore: 0,
      homeScore: 0,
      playEvents: activities
    })
    const first = await live(id, { plays: [original] })
    const targets = tagTargets(
      (first.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
    )
    for (let index = 0; index < 2; index++)
      expect(
        (
          await ask(`/games/${id}/tags/${targets[index].id}`, 'PUT', {
            tag: `timed throw ${index}`
          })
        ).status
      ).equals(200)
    const before = await ask(`/games/${id}/events`)
    for (const changed of [
      [activities[1]],
      [{ ...activities[0], startTime: '2026-10-08T20:00:00Z' }, ...activities]
    ]) {
      expect(
        (await live(id, { plays: [{ ...original, playEvents: changed }] }))
          .status
      ).equals(409)
      expect((await ask(`/games/${id}/events`)).body).deep.equals(before.body)
    }
    const appended = await live(id, {
      plays: [
        {
          ...original,
          playEvents: [
            ...activities,
            { ...activities[0], index: 2, startTime: '2026-10-08T20:00:03Z' }
          ]
        }
      ]
    })
    expect(appended.status).equals(200)
    const after = tagTargets(
      (appended.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
    )
    expect(after.slice(0, 2).map(target => target.id)).deep.equals(
      targets.slice(0, 2).map(target => target.id)
    )
    const undone = await live(id, {
      plays: [{ ...original, playEvents: [activities[0]] }]
    })
    expect(undone.status).equals(200)
    expect(
      tagTargets(
        (undone.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
      )[0]
    ).deep.includes({ id: targets[0].id, tag: 'timed throw 0' })
    expect(
      await db!
        .selectFrom('event_tags')
        .select(['target_id', 'tag'])
        .where('game_id', '=', id)
        .execute()
    ).deep.equals([{ target_id: targets[0].id, tag: 'timed throw 0' }])
    await db!.deleteFrom('games').where('id', '=', id).execute()
  })

  it('repairs stale-index and present malformed current-play identity metadata before writing', async () => {
    const id = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const pitches = [1, 2].map(pitchNumber => ({
      type: 'pitch',
      isPitch: true,
      index: pitchNumber - 1,
      pitchNumber,
      details: { code: 'B' }
    }))
    const original = {
      ...play({
        atBatIndex: 0,
        awayScore: 0,
        homeScore: 0,
        playEvents: pitches
      }),
      about: { atBatIndex: 0, inning: 1, halfInning: 'top', isComplete: false }
    }
    const first = await live(id, { plays: [], currentPlay: original })
    const current = first.body.currentPlay as TagDocument
    const targets = tagTargets(current)
    for (let index = 0; index < 2; index++)
      expect(
        (
          await ask(`/games/${id}/tags/${targets[index].id}`, 'PUT', {
            tag: `current pitch ${index}`
          })
        ).status
      ).equals(200)
    for (const tagTargetsHint of [
      current.tagTargets,
      { version: 1, play: null, events: [] },
      {}
    ]) {
      const saved = await live(id, {
        plays: [],
        currentPlay: {
          ...original,
          tagTargets: tagTargetsHint,
          playEvents: [
            {
              index: 0,
              type: 'action',
              details: { eventType: 'pitching_substitution' },
              player: { id: member.userId },
              position: { code: '1' }
            },
            ...pitches.map((pitch, index) => ({ ...pitch, index: index + 1 }))
          ]
        }
      })
      expect(saved.status).equals(200)
      const after = tagTargets(saved.body.currentPlay as TagDocument)
      expect(
        after.slice(1).map(target => ({ id: target.id, tag: target.tag }))
      ).deep.equals(
        targets.map((target, index) => ({
          id: target.id,
          tag: `current pitch ${index}`
        }))
      )
      expect(
        await db!
          .selectFrom('event_tags')
          .select('target_id')
          .where('game_id', '=', id)
          .execute()
      ).has.length(2)
    }
    await db!.deleteFrom('games').where('id', '=', id).execute()
  })

  it('rejects first-removal/insertion among tagged unnumbered identical pitches without mutating assignments', async () => {
    const id = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const pitches = [1, 2].map(second => ({
      type: 'pitch',
      index: second - 1,
      startTime: `2026-10-08T20:00:0${second}Z`,
      details: { code: 'B' }
    }))
    const original = play({
      atBatIndex: 0,
      awayScore: 0,
      homeScore: 0,
      playEvents: pitches
    })
    const first = await live(id, { plays: [original] })
    const targets = tagTargets(
      (first.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
    )
    for (let index = 0; index < 2; index++)
      expect(
        (
          await ask(`/games/${id}/tags/${targets[index].id}`, 'PUT', {
            tag: `unnumbered pitch ${index}`
          })
        ).status
      ).equals(200)
    const before = await ask(`/games/${id}/events`)
    for (const altered of [
      [pitches[1]],
      [{ ...pitches[0], startTime: '2026-10-08T20:00:00Z' }, ...pitches]
    ]) {
      expect(
        (await live(id, { plays: [{ ...original, playEvents: altered }] }))
          .status
      ).equals(409)
      expect((await ask(`/games/${id}/events`)).body).deep.equals(before.body)
      expect(
        await db!
          .selectFrom('event_tags')
          .select(['target_id', 'tag'])
          .where('game_id', '=', id)
          .orderBy('tag')
          .execute()
      ).deep.equals(
        targets.slice(0, 2).map((target, index) => ({
          target_id: target.id,
          tag: `unnumbered pitch ${index}`
        }))
      )
    }
    const appended = await live(id, {
      plays: [
        {
          ...original,
          playEvents: [
            ...pitches,
            { ...pitches[0], index: 2, startTime: '2026-10-08T20:00:03Z' }
          ]
        }
      ]
    })
    expect(appended.status).equals(200)
    const undone = await live(id, {
      plays: [{ ...original, playEvents: [pitches[0]] }]
    })
    expect(undone.status).equals(200)
    expect(
      tagTargets(
        (undone.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
      )[0]
    ).deep.includes({ id: targets[0].id, tag: 'unnumbered pitch 0' })
    await db!.deleteFrom('games').where('id', '=', id).execute()
  })

  it('atomically rejects same-length partial-timestamp current pitch reorders and marker removal', async () => {
    const id = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const pitches = [
      { index: 0, type: 'pitch', details: { code: 'B' } },
      {
        index: 1,
        type: 'pitch',
        startTime: '2026-10-08T20:00:02Z',
        details: { code: 'B' }
      }
    ]
    const currentPlay = {
      ...play({
        atBatIndex: 0,
        awayScore: 0,
        homeScore: 0,
        playEvents: pitches
      }),
      about: { atBatIndex: 0, inning: 1, halfInning: 'top', isComplete: false }
    }
    const first = await live(id, { plays: [], currentPlay })
    const targets = tagTargets(first.body.currentPlay as TagDocument)
    for (let index = 0; index < 2; index++)
      expect(
        (
          await ask(`/games/${id}/tags/${targets[index].id}`, 'PUT', {
            tag: `partial timestamp ${index}`
          })
        ).status
      ).equals(200)
    const before = await ask(`/games/${id}/events`)
    for (const changed of [
      [
        { ...pitches[1], index: 0 },
        { ...pitches[0], index: 1 }
      ],
      [pitches[0], { ...pitches[0], index: 1 }]
    ]) {
      expect(
        (
          await live(id, {
            plays: [],
            currentPlay: { ...currentPlay, playEvents: changed }
          })
        ).status
      ).equals(409)
      expect((await ask(`/games/${id}/events`)).body).deep.equals(before.body)
      expect(
        await db!
          .selectFrom('event_tags')
          .select(['target_id', 'tag'])
          .where('game_id', '=', id)
          .orderBy('tag')
          .execute()
      ).deep.equals(
        targets.map((target, index) => ({
          target_id: target.id,
          tag: `partial timestamp ${index}`
        }))
      )
    }
    await db!.deleteFrom('games').where('id', '=', id).execute()
  })

  it('rejects numbered-pitch renumbering and repeated-substitution occurrence replacement atomically', async () => {
    for (const scenario of ['numbered', 'repeated', 'unique']) {
      const substitutions = scenario !== 'numbered'
      const id = makeId('game')
      await db!
        .insertInto('games')
        .values({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date()
        })
        .execute()
      const switchAt = (
        index: number,
        code: number
      ): Record<string, unknown> => ({
        index,
        type: 'action',
        details: { eventType: 'defensive_switch' },
        position: { code },
        startTime: `2026-10-08T20:00:0${index}Z`
      })
      const pitches = substitutions
        ? scenario === 'unique'
          ? [switchAt(0, 8), switchAt(1, 7)]
          : [switchAt(0, 8), switchAt(1, 7), switchAt(2, 8)]
        : [
            {
              index: 0,
              pitchNumber: 1,
              type: 'pitch',
              startTime: '2026-10-08T20:00:01Z',
              details: { code: 'B' }
            },
            {
              index: 1,
              pitchNumber: 2,
              type: 'pitch',
              startTime: '2026-10-08T20:00:02Z',
              details: { code: 'B' }
            }
          ]
      const currentPlay = {
        ...play({
          atBatIndex: 0,
          awayScore: 0,
          homeScore: 0,
          playEvents: pitches
        }),
        about: {
          atBatIndex: 0,
          inning: 1,
          halfInning: 'top',
          isComplete: false
        }
      }
      const first = await live(id, { plays: [], currentPlay })
      const targets = tagTargets(first.body.currentPlay as TagDocument)
      for (let index = 0; index < targets.length; index++)
        expect(
          (
            await ask(`/games/${id}/tags/${targets[index].id}`, 'PUT', {
              tag: `partial timestamp ${index}`
            })
          ).status
        ).equals(200)
      const before = await ask(`/games/${id}/events`)
      for (const changed of [
        substitutions
          ? (scenario === 'unique'
              ? [pitches[1], switchAt(2, 8)]
              : [pitches[1], pitches[2], switchAt(3, 7), switchAt(4, 8)]
            ).map((event, index) => ({ ...event, index }))
          : [{ ...pitches[1], index: 0, pitchNumber: 1 }]
      ]) {
        expect(
          (
            await live(id, {
              plays: [],
              currentPlay: { ...currentPlay, playEvents: changed }
            })
          ).status
        ).equals(409)
        expect((await ask(`/games/${id}/events`)).body).deep.equals(before.body)
        expect(
          await db!
            .selectFrom('event_tags')
            .select(['target_id', 'tag'])
            .where('game_id', '=', id)
            .orderBy('tag')
            .execute()
        ).deep.equals(
          targets.map((target, index) => ({
            target_id: target.id,
            tag: `partial timestamp ${index}`
          }))
        )
      }
      await db!.deleteFrom('games').where('id', '=', id).execute()
    }
  })

  it('validates all legacy pitch provenance and canonicalizes redundant pitch flags', async () => {
    for (const scenario of [
      'count',
      'mixed',
      'mode',
      'flag',
      'mixed-numbered',
      'correction',
      'subappend',
      'numbered-remove',
      'disjoint-numbering'
    ]) {
      const id = makeId('game')
      await db!
        .insertInto('games')
        .values({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date()
        })
        .execute()
      const pitches: Array<Record<string, unknown>> = [
        {
          index: 0,
          type: 'pitch',
          count: { balls: 1, strikes: 0, outs: 0 },
          details: { code: 'B' }
        },
        {
          index: 1,
          type: 'pitch',
          count: { balls: 2, strikes: 0, outs: 0 },
          details: { code: 'B' }
        }
      ]
      if (
        [
          'count',
          'mixed-numbered',
          'correction',
          'numbered-remove',
          'disjoint-numbering'
        ].includes(scenario)
      )
        pitches.forEach((event, index) => {
          event.pitchNumber = index + 1
        })
      if (
        [
          'mode',
          'correction',
          'numbered-remove',
          'disjoint-numbering'
        ].includes(scenario)
      )
        pitches.forEach((event, index) => {
          event.startTime = `2026-10-08T20:00:0${index + 1}Z`
        })
      if (['mixed', 'mixed-numbered'].includes(scenario))
        pitches.push({
          index: 2,
          type: 'pitch',
          count: { balls: 2, strikes: 1, outs: 0 },
          details: { code: 'C' }
        })
      if (scenario === 'mixed-numbered') {
        pitches[1].details = { code: 'C' }
        pitches[1].count = { balls: 1, strikes: 1, outs: 0 }
        pitches[2].details = { code: 'B' }
        pitches[2].count = { balls: 2, strikes: 1, outs: 0 }
        pitches[2].pitchNumber = 3
      }
      if (scenario === 'correction') {
        pitches[1].details = { code: 'C' }
        pitches[1].count = { balls: 1, strikes: 1, outs: 0 }
      }
      if (scenario === 'subappend')
        pitches.splice(0, pitches.length, {
          index: 0,
          type: 'action',
          details: { eventType: 'pitching_substitution' },
          position: { code: 1 }
        })
      const currentPlay = {
        ...play({
          atBatIndex: 0,
          awayScore: 0,
          homeScore: 0,
          playEvents: pitches
        }),
        about: {
          atBatIndex: 0,
          inning: 1,
          halfInning: 'top',
          isComplete: false
        }
      }
      const first = await live(id, { plays: [], currentPlay })
      const targets = tagTargets(first.body.currentPlay as TagDocument)
      for (let index = 0; index < targets.length; index++)
        expect(
          (
            await ask(`/games/${id}/tags/${targets[index].id}`, 'PUT', {
              tag: `partial timestamp ${index}`
            })
          ).status
        ).equals(200)
      const before = await ask(`/games/${id}/events`)
      const changed =
        scenario === 'disjoint-numbering'
          ? pitches.map((event, index) => ({
              ...event,
              pitchNumber: index + 3
            }))
          : scenario === 'numbered-remove'
            ? [{ ...pitches[1], index: 0 }]
            : scenario === 'correction'
              ? pitches.map((event, index) => ({
                  ...event,
                  details: { code: 'C' },
                  count: { balls: 0, strikes: index + 1, outs: 0 }
                }))
              : scenario === 'subappend'
                ? [
                    ...pitches,
                    { ...pitches[0], index: 1, position: { code: 4 } }
                  ]
                : scenario === 'mixed-numbered'
                  ? [
                      pitches[1],
                      pitches[2],
                      {
                        ...pitches[1],
                        count: { balls: 2, strikes: 2, outs: 0 }
                      }
                    ].map((event, index) => ({
                      ...event,
                      index,
                      pitchNumber: index + 1
                    }))
                  : scenario === 'count'
                    ? [{ ...pitches[1], index: 0, pitchNumber: 1 }]
                    : scenario === 'mode'
                      ? pitches.map((event, index) => ({
                          ...event,
                          pitchNumber: index + 2
                        }))
                      : scenario === 'flag'
                        ? pitches.map(event => ({ ...event, isPitch: true }))
                        : [
                            pitches[1],
                            pitches[2],
                            {
                              ...pitches[0],
                              count: { balls: 3, strikes: 1, outs: 0 }
                            }
                          ].map((event, index) => ({ ...event, index }))
      {
        expect(
          (
            await live(id, {
              plays: [],
              currentPlay: { ...currentPlay, playEvents: changed }
            })
          ).status
        ).equals(
          ['flag', 'correction', 'subappend', 'numbered-remove'].includes(
            scenario
          )
            ? 200
            : 409
        )
        const after = await ask(`/games/${id}/events`)
        if (
          ['flag', 'correction', 'subappend', 'numbered-remove'].includes(
            scenario
          )
        ) {
          const surviving = ['correction', 'numbered-remove'].includes(scenario)
            ? targets.slice(1)
            : targets
          for (const target of surviving)
            expect(
              tagTargets(after.body.currentPlay as TagDocument).find(
                item => item.id === target.id
              )?.tag
            ).equals(`partial timestamp ${targets.indexOf(target)}`)
        } else expect(after.body).deep.equals(before.body)
        expect(
          await db!
            .selectFrom('event_tags')
            .select(['target_id', 'tag'])
            .where('game_id', '=', id)
            .orderBy('tag')
            .execute()
        ).deep.equals(
          targets.flatMap((target, index) =>
            ['correction', 'numbered-remove'].includes(scenario) && index === 0
              ? []
              : [
                  {
                    target_id: target.id,
                    tag: `partial timestamp ${index}`
                  }
                ]
          )
        )
      }
      await db!.deleteFrom('games').where('id', '=', id).execute()
    }
  })

  it('persists independent play and pitch tags, normalizes retries and keeps original text', async () => {
    const id = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const posted = await live(id, {
      plays: [
        play({
          atBatIndex: 0,
          awayScore: 0,
          homeScore: 0,
          playEvents: [
            {
              index: 0,
              type: 'pitch',
              isPitch: true,
              details: { code: 'B', description: 'Ball outside.' }
            }
          ]
        })
      ]
    })
    expect(posted.status).equals(200)
    const document = (posted.body.plays as Array<{ gumbo: TagDocument }>)[0]
      .gumbo
    const [pitchTarget, playTarget] = tagTargets(document)
    const put = async (
      target: string,
      tag: unknown,
      token = TOKEN
    ): Promise<{ status: number; body: Record<string, unknown> }> =>
      await ask(`/games/${id}/tags/${target}`, 'PUT', { tag }, token)
    const firstWrite = await put(pitchTarget.id, '  GREAT   Pitch ')
    expect(firstWrite.body.tag).equals('great pitch')
    expect(firstWrite.body.revision).matches(/^[0-9]+$/)
    expect((await put(playTarget.id, 'great catch')).status).equals(200)
    const before = await db!
      .selectFrom('user_tags')
      .selectAll()
      .where('user_id', '=', admin.userId)
      .execute()
    const retryWrites = await Promise.all([
      put(pitchTarget.id, 'great pitch'),
      put(pitchTarget.id, 'GREAT PITCH')
    ])
    const revisions = retryWrites.map(result =>
      BigInt(String(result.body.revision))
    )
    expect(
      revisions.every(
        revision => revision > BigInt(String(firstWrite.body.revision))
      )
    ).equals(true)
    expect(revisions[0]).not.equals(revisions[1])
    const afterHistory = await db!
      .selectFrom('user_tags')
      .selectAll()
      .where('user_id', '=', admin.userId)
      .execute()
    expect(afterHistory.map(row => row.tag).sort()).deep.equals(
      before.map(row => row.tag).sort()
    )
    const reread = await ask(`/games/${id}/events`)
    const saved = (reread.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
    expect(tagTargets(saved).map(row => row.tag)).deep.equals([
      'great pitch',
      'great catch'
    ])
    expect(saved.result?.description).equals('Single')
    expect(
      (saved.playEvents as Array<{ details: { description: string } }>)[0]
        .details.description
    ).equals('Ball outside.')
    const replacement = await put(playTarget.id, 'new tag')
    expect(replacement.status).equals(200)
    for (const invalid of [null, undefined, 7])
      expect((await put(playTarget.id, invalid)).status).equals(400)
    expect(
      tagTargets(
        (
          (await ask(`/games/${id}/events`)).body.plays as Array<{
            gumbo: TagDocument
          }>
        )[0].gumbo
      ).at(-1)?.tag
    ).equals('new tag')
    const removed = await ask(`/games/${id}/tags/${playTarget.id}`, 'DELETE')
    expect(removed.status).equals(200)
    expect(removed.body.tag).equals(null)
    expect(
      BigInt(String(removed.body.revision)) >
        BigInt(String(replacement.body.revision))
    ).equals(true)
    expect((await ask('/tags')).body.popular).not.deep.includes({
      tag: 'great catch',
      count: 1
    })
    expect((await put(playTarget.id, '')).status).equals(400)
    expect((await put(playTarget.id, 'x'.repeat(65))).status).equals(400)
    expect((await put('missing_target', 'tag')).status).equals(404)
    expect((await put(playTarget.id, 'forbidden', MEMBER)).status).equals(403)
    expect((await put(playTarget.id, 'hidden', STRANGER)).status).equals(404)
    expect((await ask('/tags', 'GET', undefined, null)).status).equals(401)
    expect(
      (await ask('/tags', 'GET', undefined, STRANGER)).body.recent
    ).deep.equals([])
    // A scoring retry may carry stale or forged labels; storage owns labels.
    const spoofed = JSON.parse(JSON.stringify(saved)) as TagDocument
    ;(spoofed.tagTargets as { play: { tag: string } }).play.tag = 'spoofed'
    await live(id, { plays: [spoofed] })
    const after = await ask(`/games/${id}/events`)
    expect(
      tagTargets(
        (after.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
      ).at(-1)?.tag
    ).equals(null)
    await live(id, { remove: [0] })
    expect(
      await db!
        .selectFrom('event_tags')
        .selectAll()
        .where('game_id', '=', id)
        .execute()
    ).deep.equals([])
    expect((await put(pitchTarget.id, 'stale')).status).equals(404)
    expect((await ask('/tags?includeUnused=true')).body.popular).deep.includes({
      tag: 'great pitch',
      count: 0
    })
    expect((await ask('/tags?includeUnused=false')).status).equals(200)
    expect((await ask('/tags?includeUnused=invalid')).status).equals(400)
  })

  it('retains all account history with ten distinct recents and accurate concurrent popularity', async () => {
    const ids = [makeId('game'), makeId('game')]
    const targets: string[] = []
    for (const id of ids) {
      await db!
        .insertInto('games')
        .values({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date()
        })
        .execute()
      const response = await live(id, {
        plays: [play({ atBatIndex: 0, awayScore: 0, homeScore: 0 })]
      })
      targets.push(
        tagTargets(
          (response.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
        )[0].id
      )
    }
    const put = async (
      at: number,
      tag: string,
      token = TOKEN
    ): Promise<{ status: number; body: Record<string, unknown> }> =>
      await ask(`/games/${ids[at]}/tags/${targets[at]}`, 'PUT', { tag }, token)
    for (let at = 0; at < 11; at++) await put(0, `choice ${at}`)
    expect((await ask('/tags')).body.recent).deep.equals(
      Array.from({ length: 10 }, (_, at) => `choice ${10 - at}`)
    )
    expect(
      await db!
        .selectFrom('user_tags')
        .select('tag')
        .where('user_id', '=', admin.userId)
        .where('tag', '=', 'choice 0')
        .execute()
    ).has.length(1)
    await put(1, 'retained label')
    for (let at = 0; at < 11; at++) await put(0, `fresh ${at}`)
    expect((await ask('/tags')).body.recent).not.includes('retained label')
    await put(1, 'retained label')
    expect(((await ask('/tags')).body.recent as string[])[0]).equals(
      'retained label'
    )
    await put(0, 'choice 0')
    expect(((await ask('/tags')).body.recent as string[])[0]).equals('choice 0')
    await Promise.all([put(0, 'shared label'), put(1, 'shared label')])
    expect((await ask('/tags')).body.popular).deep.includes({
      tag: 'shared label',
      count: 2
    })
    await Promise.all([put(0, 'winner one'), put(0, 'winner two')])
    const rows = await db!
      .selectFrom('event_tags')
      .selectAll()
      .where('game_id', 'in', ids)
      .execute()
    expect(rows).has.length(2)
    expect(rows.find(row => row.game_id === ids[0])?.tag).oneOf([
      'winner one',
      'winner two'
    ])
    await put(1, 'shared label', MANAGER)
    expect(
      (
        (await ask('/tags', 'GET', undefined, MANAGER)).body.recent as string[]
      )[0]
    ).equals('shared label')
    expect((await ask('/tags')).body.popular).deep.includes({
      tag: 'shared label',
      count: 1
    })
  })
  it('retains the global catalog after assignment removal and account history deletion', async () => {
    const actor = mintUserId(id =>
      [
        admin.userId,
        stranger.userId,
        member.userId,
        manager.userId,
        ...[...flagged.values()].map(user => user.userId)
      ].includes(id)
    )
    const token = 'tok_catalog_actor_000000000000000000'
    await db!
      .insertInto('users')
      .values({
        id: actor.userId,
        legacyId: actor.legacyId,
        display_name: 'Mookie Betts',
        is_admin: true
      })
      .execute()
    await db!
      .insertInto('auth_sessions')
      .values({
        id: makeId('authSession'),
        user_id: actor.userId,
        token_hash: hashToken(token),
        expires_at: new Date(Date.now() + 3600000)
      })
      .execute()
    const id = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const posted = await live(id, {
      plays: [play({ atBatIndex: 0, awayScore: 0, homeScore: 0 })]
    })
    const target = tagTargets(
      (posted.body.plays as Array<{ gumbo: TagDocument }>)[0].gumbo
    )[0]
    expect(
      (
        await ask(
          `/games/${id}/tags/${target.id}`,
          'PUT',
          { tag: 'retained globally' },
          token
        )
      ).status
    ).equals(200)
    expect(
      (await ask(`/games/${id}/tags/${target.id}`, 'DELETE', undefined, token))
        .status
    ).equals(200)
    await db!.deleteFrom('users').where('id', '=', actor.userId).execute()
    expect(
      await db!
        .selectFrom('user_tags')
        .selectAll()
        .where('user_id', '=', actor.userId)
        .execute()
    ).deep.equals([])
    expect((await ask('/tags?includeUnused=true')).body.popular).deep.includes({
      tag: 'retained globally',
      count: 0
    })
  })
})

describe('the status a live post leaves', function () {
  it('requires a pitch or ball in play, with final and cancelled taking priority', function () {
    const final = [{ eventType: 'single' }, { eventType: 'final_score' }]
    expect(statusAfterLivePost('inProgress', final, false)).equals('final')
    expect(
      statusAfterLivePost('final', [{ eventType: 'single' }], true)
    ).equals('inProgress')
    expect(statusAfterLivePost('scheduled', [], true)).equals('inProgress')
    expect(statusAfterLivePost('scheduled', [], false)).equals('scheduled')
    expect(statusAfterLivePost('inProgress', [], false)).equals('scheduled')
    expect(statusAfterLivePost('final', [], false)).equals('scheduled')
    expect(
      statusAfterLivePost(
        'inProgress',
        [{ eventType: 'defensive_switch' }],
        false
      )
    ).equals('scheduled')
    expect(statusAfterLivePost('cancelled', final, true)).equals('cancelled')
  })
})

describe('the status a post leaves', function () {
  it('finishes a game only when both scores are known', function () {
    const both = { away: 3, home: 2 }
    const one = { away: 3, home: null }
    expect(statusAfterPost('scheduled', both, true)).equals('final')
    expect(statusAfterPost('inProgress', both, true)).equals('final')
    expect(statusAfterPost('scheduled', one, true)).equals('inProgress')
    expect(statusAfterPost('scheduled', one, false)).equals('scheduled')
    expect(statusAfterPost('inProgress', one, false)).equals('scheduled')
    expect(statusAfterPost('final', one, false)).equals('final')
  })

  it('leaves a cancelled game cancelled', function () {
    expect(statusAfterPost('cancelled', { away: 3, home: 2 }, true)).equals(
      'cancelled'
    )
    expect(statusAfterPost('cancelled', { away: 3, home: null }, true)).equals(
      'cancelled'
    )
    expect(
      statusAfterPost('cancelled', { away: null, home: null }, false)
    ).equals('cancelled')
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

/**
 * U10: the default lineup a live post keeps. Every game here is scored by a
 * real `ScoringSession` whose store is `POST /games/:gameId/events`.
 */
describe('the team default lineup a live post keeps (U10)', function () {
  this.timeout(60000)

  const name = `teamstation_lineup_defaults_${Date.now()}`
  const url = adminUrl.replace(/\/[^/]*$/, `/${name}`)
  const OWNER = 'tok_lineups_0000000000000000000000'
  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const owner = mintUserId(() => false)
  const taken = new Set([owner.userId])
  const mint = (): number => {
    const minted = mintUserId(id => taken.has(id))
    taken.add(minted.userId)
    players.push(minted)
    return minted.userId
  }
  const players: Array<{ userId: number; legacyId: string }> = []
  const awayIds = Array.from({ length: 10 }, mint)
  const homeIds = Array.from({ length: 9 }, mint)
  const awayTeam = makeId('team')
  const homeTeam = makeId('team')
  const TEAMS = {
    away: { id: awayTeam, name: 'Away' },
    home: { id: homeTeam, name: 'Home' }
  }
  const rosterOf = (
    ids: number[]
  ): Array<{ userId: number; shortName: string; jersey: string }> =>
    ids.map((userId, i) => ({
      userId,
      shortName: `P${i + 1}`,
      jersey: String(i + 1)
    }))
  const setup = newSetup(TEAMS, {
    away: rosterOf(awayIds),
    home: rosterOf(homeIds)
  })
  setup.sides.away.battingOrder = setup.sides.away.battingOrder.slice(0, 9)
  const games = Array.from({ length: 8 }, () => makeId('game'))

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
    await adminPool.query(`create database ${name}`)
    const pool = new Pool({ connectionString: url })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(url)
    const now = new Date()
    await db
      .insertInto('users')
      .values(
        [{ ...owner, is_admin: true }, ...players].map(user => ({
          id: user.userId,
          legacyId: user.legacyId,
          display_name: `User ${user.userId}`,
          is_admin: 'is_admin' in user,
          created_at: now,
          updated_at: now
        }))
      )
      .execute()
    await db
      .insertInto('auth_sessions')
      .values({
        id: 'ses_lineups_owner',
        user_id: owner.userId,
        token_hash: hashToken(OWNER),
        created_at: now,
        expires_at: new Date(now.getTime() + 3_600_000)
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: homeTeam, name: 'Home', kind: 'full' },
        { id: awayTeam, name: 'Away', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values(
        games.map(id => ({
          id,
          home_team_id: homeTeam,
          away_team_id: awayTeam,
          start_at: now
        }))
      )
      .execute()
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', eventRoutes(db))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(`drop database if exists ${name}`)
      await adminPool.end()
    }
  })

  async function post(
    gameId: string,
    body: Record<string, unknown>
  ): Promise<{ status: number; body: StoredGame & { plays: unknown[] } }> {
    const response = await fetch(`${base}/games/${gameId}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${OWNER}`
      },
      body: JSON.stringify(body)
    })
    return {
      status: response.status,
      body: (await response.json()) as StoredGame & { plays: unknown[] }
    }
  }

  /** The route, as the scoring screen's store. */
  const store = (gameId: string): EventStore => ({
    load: async () => {
      const response = await fetch(`${base}/games/${gameId}/events`, {
        headers: { authorization: `Bearer ${OWNER}` }
      })
      const read = (await response.json()) as {
        plays: Array<{ gumbo: GumboPlay }>
        currentPlay: CurrentPlay | null
      }
      return {
        plays: read.plays.map(row => row.gumbo),
        currentPlay: read.currentPlay
      }
    },
    save: async (_gameId, change) => {
      const answer = await post(gameId, {
        mode: 'live',
        source: { system: 'teamstation' },
        plays: change.plays,
        remove: change.remove,
        ...(change.currentPlay === undefined
          ? {}
          : { currentPlay: change.currentPlay })
      })
      expect(answer.status, JSON.stringify(answer.body)).equals(200)
      const plays = answer.body.plays as Array<{ gumbo: GumboPlay }>
      return {
        plays: plays.map(row => row.gumbo),
        currentPlay: answer.body.currentPlay
      }
    }
  })
  async function scoring(gameId: string): Promise<ScoringSession> {
    return await ScoringSession.open(store(gameId), gameId, {
      gamePk: gameId,
      teams: TEAMS,
      setup
    })
  }
  async function apply(
    session: ScoringSession,
    ...actions: ScoringAction[]
  ): Promise<void> {
    for (const action of actions)
      expect(
        session.apply(action).problems,
        JSON.stringify(action)
      ).deep.equals([])
    await session.flush()
    expect(session.problem).equals(null)
  }
  const ball: ScoringAction = { type: 'pitch', call: 'B' }
  const strike: ScoringAction = { type: 'pitch', call: 'C' }
  const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
  const reorder = (slots: number[]): ScoringAction => ({
    type: 'lineup',
    kind: 'battingOrder',
    side: 'away',
    order: slots.map(slot => awayIds[slot - 1] ?? slot)
  })
  async function gameRow(gameId: string): Promise<{
    lineup_started_at: Date | null
    lineups_digest: string | null
  }> {
    return await db!
      .selectFrom('games')
      .select(['lineup_started_at', 'lineups_digest'])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
  }
  async function defaultOf(teamId: string): Promise<{
    lineup: { batters: Array<{ userId: number | null }> }
    fromGameId: string
    setAt: string
  } | null> {
    const row = await db!
      .selectFrom('teams')
      .select('default_lineup')
      .where('id', '=', teamId)
      .executeTakeFirstOrThrow()
    return row.default_lineup as never
  }
  const battersOf = (value: Awaited<ReturnType<typeof defaultOf>>): unknown =>
    value?.lineup.batters.map(person => person.userId)

  it('takes both starting lineups once the game begins, and keeps a default that is the same', async function () {
    const [g1, g2] = games
    const first = await scoring(g1)
    await apply(first, reorder([2, 1, 3, 4, 5, 6, 7, 8, 9]))
    expect((await gameRow(g1)).lineup_started_at).equals(null)
    const before = (await gameRow(g1)).lineups_digest
    expect(before).a('string')
    expect(await defaultOf(awayTeam)).equals(null)
    await apply(first, ball)
    expect((await gameRow(g1)).lineup_started_at).instanceOf(Date)
    const away = await defaultOf(awayTeam)
    expect(away?.fromGameId).equals(g1)
    expect(battersOf(away)).deep.equals([
      awayIds[1],
      awayIds[0],
      ...awayIds.slice(2, 9)
    ])
    expect(battersOf(await defaultOf(homeTeam))).deep.equals(homeIds)
    expect((await defaultOf(homeTeam))?.fromGameId).equals(g1)

    // The same arrangement in the next game keeps the default's setAt.
    const second = await scoring(g2)
    await apply(second, reorder([2, 1, 3, 4, 5, 6, 7, 8, 9]), ball)
    expect((await gameRow(g2)).lineup_started_at).instanceOf(Date)
    expect(await defaultOf(awayTeam)).deep.equals(away)
  })

  it('takes the lineup again after an undo back to before the first pitch', async function () {
    const g3 = games[2]
    const session = await scoring(g3)
    await apply(session, ball)
    const taken = await defaultOf(awayTeam)
    expect((await gameRow(g3)).lineup_started_at).instanceOf(Date)
    session.undo()
    await session.flush()
    expect((await gameRow(g3)).lineup_started_at).equals(null)
    // The default stays as the first pitch left it.
    expect(await defaultOf(awayTeam)).deep.equals(taken)
    await apply(session, reorder([9, 8, 7, 6, 5, 4, 3, 2, 1]), ball)
    const retaken = await defaultOf(awayTeam)
    expect(retaken?.fromGameId).equals(g3)
    expect(battersOf(retaken)).deep.equals(awayIds.slice(0, 9).reverse())
    expect((await gameRow(g3)).lineup_started_at).instanceOf(Date)

    // Later changes, however many, leave it alone.
    await apply(
      session,
      strike,
      strike,
      strike,
      close,
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'away',
        player: awayIds[9],
        replaces: awayIds[7]
      },
      reorder([10, 9, 7, 6, 5, 4, 3, 2, 1])
    )
    expect(await defaultOf(awayTeam)).deep.equals(retaken)
  })

  it('is never taken by a replace post or an outside post', async function () {
    const [, , , g4, g5, g6] = games
    const session = await scoring(g4)
    await apply(
      session,
      reorder([3, 1, 2, 4, 5, 6, 7, 8, 9]),
      strike,
      strike,
      strike,
      close,
      ball
    )
    const kept = await defaultOf(awayTeam)
    expect(battersOf(kept)).deep.equals([
      awayIds[2],
      awayIds[0],
      awayIds[1],
      ...awayIds.slice(3, 9)
    ])
    // With no default kept, either post would take one if it could.
    await db!
      .updateTable('teams')
      .set({ default_lineup: null })
      .where('id', '=', awayTeam)
      .execute()
    const stored = await store(g4).load(g4)
    const replaced = await post(g5, {
      mode: 'replace',
      source: { system: 'teamstation' },
      plays: stored.plays
    })
    expect(replaced.status).equals(200)
    const outside = await post(g6, {
      mode: 'live',
      source: { system: 'acme' },
      plays: stored.plays,
      currentPlay: stored.currentPlay
    })
    expect(outside.status).equals(200)
    for (const gameId of [g5, g6]) {
      expect((await gameRow(gameId)).lineup_started_at, gameId).equals(null)
    }
    expect((await gameRow(g5)).lineups_digest).equals(null)
    expect((await gameRow(g6)).lineups_digest).a('string')
    expect(await defaultOf(awayTeam)).equals(null)
  })

  it('leaves the default alone, answers 200 and warns once when the record does not replay', async function () {
    const g7 = games[6]
    const session = await scoring(g7)
    await apply(session, ball)
    const stored = await store(g7).load(g7)
    // With no default kept and the game not marked, a post that replayed
    // would take one.
    await db!
      .updateTable('teams')
      .set({ default_lineup: null })
      .where('id', '=', awayTeam)
      .execute()
    await db!
      .updateTable('games')
      .set({ lineup_started_at: null })
      .where('id', '=', g7)
      .execute()
    const broken = JSON.parse(JSON.stringify(stored.currentPlay)) as {
      teamStation: { actions: unknown[] }
    }
    broken.teamStation.actions = [reorder([99, 1, 2, 3, 4, 5, 6, 7, 8]), ball]
    const warned: unknown[][] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => {
      warned.push(args)
    }
    let answer
    try {
      answer = await post(g7, {
        mode: 'live',
        source: { system: 'teamstation' },
        plays: [],
        currentPlay: broken
      })
    } finally {
      console.warn = warn
    }
    expect(answer.status).equals(200)
    expect(warned).length(1)
    expect(String(warned[0][0])).includes(g7)
    expect(await defaultOf(awayTeam)).equals(null)
    expect((await gameRow(g7)).lineup_started_at).equals(null)
  })
})
