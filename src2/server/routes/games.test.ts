import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { seasonRoutes } from './seasons'

/**
 * Every game somebody can see, in one query, and the one another service
 * knows by an id.
 */

const adminUrl = testDatabaseUrl
const scratchName = `gamestation_games_route_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const ADMIN = 'tok_games_admin_00000000000000000000'
const MEMBER = 'tok_games_member_0000000000000000000'
const LONER = 'tok_games_loner_00000000000000000000'
const TEAMMATE = 'tok_games_teammate_0000000000000000'

const admin = mintUserId(() => false)
const member = mintUserId(id => id === admin.userId)
const loner = mintUserId(id => id === admin.userId || id === member.userId)
const teammate = mintUserId(
  id => id === admin.userId || id === member.userId || id === loner.userId
)

describe('every game somebody can see', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const spring = makeId('season')
  const fall = makeId('season')
  const hawks = makeId('team')
  const gulls = makeId('team')
  const rivals = makeId('team')
  const springGame = makeId('game')
  const olderGame = makeId('game')
  const fallGame = makeId('game')
  const looseGame = makeId('game')
  const summer = makeId('season')
  const owls = makeId('team')
  const crows = makeId('team')
  const owlsGame = makeId('game')
  const crowsGame = makeId('game')

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
      .values(
        [
          { made: admin, name: 'Ada', isAdmin: true },
          { made: member, name: 'Cam', isAdmin: false },
          { made: loner, name: 'Lou', isAdmin: false },
          { made: teammate, name: 'Tam', isAdmin: false }
        ].map(person => ({
          id: person.made.userId,
          legacyId: person.made.legacyId,
          display_name: person.name,
          is_admin: person.isAdmin,
          created_at: now,
          updated_at: now
        }))
      )
      .execute()
    await db
      .insertInto('auth_sessions')
      .values(
        (
          [
            [ADMIN, admin.userId],
            [MEMBER, member.userId],
            [LONER, loner.userId],
            [TEAMMATE, teammate.userId]
          ] as Array<[string, number]>
        ).map(([token, userId]) => ({
          id: makeId('authSession'),
          user_id: userId,
          token_hash: hashToken(token),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        }))
      )
      .execute()
    await db
      .insertInto('seasons')
      .values([
        // Open to everybody on its teams, as a schedule needs.
        {
          id: spring,
          name: 'Spring 2026',
          year: 2026,
          spectator_access: 'season'
        },
        { id: fall, name: 'Fall 2026', year: 2026 },
        // Left at `team`: each team's people see only their own games.
        { id: summer, name: 'Summer 2026', year: 2026 }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: hawks, name: 'Hawks' },
        { id: gulls, name: 'Gulls' },
        { id: rivals, name: 'Rivals', kind: 'external' },
        { id: owls, name: 'Owls' },
        { id: crows, name: 'Crows' }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values([
        { season_id: spring, team_id: hawks },
        { season_id: fall, team_id: gulls },
        { season_id: summer, team_id: owls },
        { season_id: summer, team_id: crows }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          user_id: member.userId,
          team_id: hawks
        },
        {
          id: makeId('membership'),
          user_id: teammate.userId,
          team_id: owls
        }
      ])
      .execute()
    await db
      .insertInto('games')
      .values([
        {
          id: springGame,
          season_id: spring,
          home_team_id: hawks,
          away_team_id: rivals,
          start_at: new Date('2026-05-02T17:00:00Z')
        },
        {
          id: olderGame,
          season_id: spring,
          home_team_id: rivals,
          away_team_id: hawks,
          start_at: new Date('2026-04-11T17:00:00Z'),
          home_score: 2,
          away_score: 5
        },
        {
          id: fallGame,
          season_id: fall,
          home_team_id: gulls,
          away_team_id: rivals,
          start_at: new Date('2026-09-19T17:00:00Z')
        },
        {
          id: looseGame,
          home_team_id: hawks,
          away_team_id: gulls,
          start_at: new Date('2026-06-01T17:00:00Z')
        },
        {
          id: owlsGame,
          season_id: summer,
          home_team_id: owls,
          away_team_id: rivals,
          start_at: new Date('2026-07-04T17:00:00Z'),
          home_score: 1,
          away_score: 0
        },
        {
          id: crowsGame,
          season_id: summer,
          home_team_id: crows,
          away_team_id: rivals,
          start_at: new Date('2026-07-05T17:00:00Z'),
          home_score: 3,
          away_score: 3
        }
      ])
      .execute()
    await db
      .insertInto('external_ids')
      .values([
        {
          id: makeId('externalId'),
          entity_type: 'game',
          entity_id: springGame,
          system: 'peertube',
          kind: 'event',
          external_id: 'ext-spring'
        },
        {
          id: makeId('externalId'),
          entity_type: 'game',
          entity_id: fallGame,
          system: 'peertube',
          kind: 'event',
          external_id: 'ext-fall'
        },
        {
          id: makeId('externalId'),
          entity_type: 'team',
          entity_id: hawks,
          system: 'peertube',
          kind: 'team',
          external_id: 'ext-spring-team'
        }
      ])
      .execute()

    const media: MediaContext = {
      mediaRoot: '/tmp',
      workDir: '/tmp',
      ffmpegPath: 'ffmpeg',
      mediaSecret: 'secret',
      publicUrl: 'http://127.0.0.1',
      space: {
        endpoint: '',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        pathStyle: true
      }
    }
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', seasonRoutes(db, media))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  async function games(
    token: string | null,
    query = ''
  ): Promise<{ status: number; ids: string[]; body: unknown }> {
    const response = await fetch(`${base}/games${query}`, {
      headers: token == null ? {} : { authorization: `Bearer ${token}` }
    })
    const body = await response.json().catch(() => null)
    return {
      status: response.status,
      ids: Array.isArray(body)
        ? body.map(game => (game as { id: string }).id)
        : [],
      body
    }
  }

  it('lists every game a member can see, newest first, in one answer', async function () {
    const seen = await games(MEMBER)
    expect(seen.status).equals(200)
    // The game in no season is the member's team's, so it is theirs to see.
    expect(seen.ids).deep.equals([looseGame, springGame, olderGame])
    const [, first] = seen.body as Array<Record<string, unknown>>
    expect(first).deep.include({
      homeTeamName: 'Hawks',
      awayTeamName: 'Rivals',
      awayTeamExternal: true,
      seasonId: spring,
      videoCount: 0,
      isLive: false
    })
  })

  it('lists a team’s games in a season not opened to spectators', async function () {
    // Summer is left at `team`: the Owls' people see the Owls' game, and not
    // the Crows' game in the same season.
    expect((await games(TEAMMATE)).ids).deep.equals([owlsGame])
    expect((await games(LONER)).ids).deep.equals([])
    expect((await games(MEMBER)).ids).not.include(owlsGame)
  })

  it('holds a season’s schedule among its games', async function () {
    const response = await fetch(`${base}/seasons/${spring}/games`, {
      headers: { authorization: `Bearer ${MEMBER}` }
    })
    const schedule = (await response.json()) as Array<{ seasonId: string }>
    expect(schedule).deep.equals(
      ((await games(MEMBER)).body as Array<{ seasonId: string }>).filter(
        game => game.seasonId === spring
      )
    )
  })

  it('gives an administrator every game, in a season or not', async function () {
    expect((await games(ADMIN)).ids).deep.equals([
      fallGame,
      crowsGame,
      owlsGame,
      looseGame,
      springGame,
      olderGame
    ])
  })

  it('narrows to the game another service knows by an id, if it can be seen', async function () {
    expect((await games(MEMBER, '?externalId=ext-spring')).ids).deep.equals([
      springGame
    ])
    expect((await games(MEMBER, '?externalId=ext-fall')).ids).deep.equals([])
    expect((await games(ADMIN, '?externalId=ext-fall')).ids).deep.equals([
      fallGame
    ])
    // A team's external id is not a game's.
    expect((await games(ADMIN, '?externalId=ext-spring-team')).ids).deep.equals(
      []
    )
  })

  it('refuses an externalId with no usable value, rather than every game', async function () {
    for (const query of [
      '?externalId=',
      '?externalId=ext-spring&externalId='
    ]) {
      const refused = await games(ADMIN, query)
      expect(refused.status, query).equals(400)
      expect(refused.body, query).deep.include({
        message: 'externalId must be a non-empty string'
      })
    }
  })

  it('asks after several ids at once, and says which each game has', async function () {
    const both = await games(
      ADMIN,
      '?externalId=ext-spring&externalId=ext-fall&externalId=ext-none'
    )
    expect(both.ids).deep.equals([fallGame, springGame])
    expect(
      (both.body as Array<{ externalIds: string[] }>).map(
        game => game.externalIds
      )
    ).deep.equals([['ext-fall'], ['ext-spring']])
    const all = (await games(ADMIN)).body as Array<{
      id: string
      externalIds: string[]
    }>
    expect(all.find(game => game.id === olderGame)?.externalIds).deep.equals([])
  })

  it('answers an empty list to somebody who can see nothing, and 401 to nobody', async function () {
    expect((await games(LONER)).body).deep.equals([])
    expect((await games(null)).status).equals(401)
  })

  it('finds the newest played game each person can see', async function () {
    const recent = async (token: string): Promise<unknown> =>
      await (
        await fetch(`${base}/games/recent`, {
          headers: { authorization: `Bearer ${token}` }
        })
      ).json()
    expect(await recent(ADMIN)).deep.include({ id: crowsGame, homeScore: 3 })
    // The newer spring and loose games have no score.
    expect(await recent(MEMBER)).deep.include({
      id: olderGame,
      homeTeamName: 'Rivals',
      awayScore: 5
    })
    expect(await recent(TEAMMATE)).deep.include({ id: owlsGame })
    expect(await recent(LONER)).equals(null)
  })
})
