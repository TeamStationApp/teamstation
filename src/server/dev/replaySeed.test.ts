import { spawnSync } from 'node:child_process'

import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { canScore, canSeeGame, roleScopes, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { pitchingLines } from '../stats'
import { pitchingOrder } from '../stats/boxScoreOrder'
import { statRows } from '../stats/rows'
import { REPLAY_SEED, type ReplaySeed, seedReplay } from './replaySeed'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_replayseed_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('replay seed', function () {
  this.timeout(120000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined
  let seeded: ReplaySeed

  before(async function () {
    attachInt8Parser()
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    seeded = await seedReplay(db, {
      password: 'replay-test-password',
      clock: () => new Date('2026-09-26T17:00:00Z')
    })
  })

  after(async function () {
    if (db != null) await db.destroy()
    else if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  async function game(id: string): Promise<{
    status: string
    scoringOwner: string | null
    seasonId: string | null
    homeTeamId: string
    awayTeamId: string
  }> {
    const row = await db!
      .selectFrom('games')
      .select([
        'status',
        'scoringOwner',
        'season_id',
        'home_team_id',
        'away_team_id'
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    return {
      status: row.status,
      scoringOwner: row.scoringOwner ?? null,
      seasonId: row.season_id,
      homeTeamId: row.home_team_id,
      awayTeamId: row.away_team_id
    }
  }

  it('stores the game four ways, owned and finished as production would leave them', async function () {
    expect(await game(REPLAY_SEED.games.final)).includes({
      status: 'final',
      scoringOwner: 'teamstation'
    })
    expect(await game(REPLAY_SEED.games.inProgress)).includes({
      status: 'inProgress',
      scoringOwner: 'teamstation'
    })
    expect(
      (await game(REPLAY_SEED.games.importedThenScored)).scoringOwner
    ).equals('teamstation')
    expect((await game(REPLAY_SEED.games.imported)).scoringOwner).not.equals(
      'teamstation'
    )
    const recorded = (
      await db!
        .selectFrom('events')
        .select(['gameId', 'gumbo'])
        .where('gameId', 'in', Object.values(REPLAY_SEED.games))
        .execute()
    ).filter(row => 'teamStation' in (row.gumbo as object))
    const gamesWithRecords = new Set(recorded.map(row => row.gameId))
    expect(gamesWithRecords.has(REPLAY_SEED.games.imported)).equals(false)
    expect(gamesWithRecords.has(REPLAY_SEED.games.final)).equals(true)
  })

  it('lets each member see the games, the outsider none, and only the scorer score', async function () {
    const final = await game(REPLAY_SEED.games.final)
    const scope = {
      homeTeamId: final.homeTeamId,
      awayTeamId: final.awayTeamId,
      seasonId: final.seasonId
    }
    for (const key of ['team', 'season', 'league', 'scorer'] as const)
      expect(
        canSeeGame(
          await visibleScopes(db!, seeded.accounts[key], false),
          scope
        ),
        key
      ).equals(true)
    expect(
      canSeeGame(
        await visibleScopes(db!, seeded.accounts.outsider, false),
        scope
      )
    ).equals(false)
    expect(
      canScore(
        await roleScopes(db!, seeded.accounts.scorer, false),
        final.homeTeamId
      )
    ).equals(true)
    for (const key of ['team', 'season', 'league'] as const)
      expect(
        canScore(
          await roleScopes(db!, seeded.accounts[key], false),
          final.homeTeamId
        ),
        key
      ).equals(false)
  })

  it('builds the box score, its pitchers in the order they pitched', async function () {
    const rows = await statRows(db!, { gameId: REPLAY_SEED.games.final })
    expect(rows.length).greaterThan(15)
    const ordered = await pitchingOrder(
      db!,
      REPLAY_SEED.games.final,
      pitchingLines(rows)
    )
    const names = new Map(
      rows.map(row => [row.userId, `${row.firstName} ${row.lastName}`])
    )
    expect(ordered.map(line => names.get(line.userId))).deep.equals([
      'Tyler Glasnow',
      'Gerrit Cole',
      'Luis Gil'
    ])
  })

  it('leaves the same rows when it runs again', async function () {
    const count = async (
      table: 'users' | 'memberships' | 'events'
    ): Promise<number> =>
      Number(
        (
          await db!
            .selectFrom(table)
            .select(eb => eb.fn.countAll().as('n'))
            .executeTakeFirstOrThrow()
        ).n
      )
    const before = await Promise.all(
      (['users', 'memberships', 'events'] as const).map(count)
    )
    const again = await seedReplay(db!, { password: 'replay-test-password' })
    expect(again.accounts).deep.equals(seeded.accounts)
    expect(
      await Promise.all(
        (['users', 'memberships', 'events'] as const).map(count)
      )
    ).deep.equals(before)
  })

  it('refuses to run in production', function () {
    const run = spawnSync(
      process.execPath,
      ['-r', 'sucrase/register', 'src/server/dev/replaySeed.ts'],
      { env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8' }
    )
    expect(run.status).equals(1)
    expect(run.stderr).includes('does not run in production')
  })
})
