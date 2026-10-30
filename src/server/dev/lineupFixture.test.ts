import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { asStoredDefaultLineup } from '../../common/scoring/lineupHistory'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { resolvedDefaultOf } from '../events/teamLineups'
import {
  LINEUP_NAMES,
  type LineupFixture,
  runLineupFixture
} from './lineupFixture'
import { runScoringGame } from './scoringGame'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_lineup_fixture_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)
const PASSWORD = 'fixture-password-0000'

/** Runs `run` with NODE_ENV set to production, then puts NODE_ENV back. */
async function inProduction<T>(run: () => Promise<T>): Promise<T> {
  const was = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    return await run()
  } finally {
    if (was == null) delete process.env.NODE_ENV
    else process.env.NODE_ENV = was
  }
}

/** The message `run` rejects with, or fails when it resolves. */
async function rejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a rejection')
}

describe('development game fixtures', function () {
  this.timeout(120000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined

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
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(`drop database if exists ${scratchName}`)
      await adminPool.end()
    }
  })

  const gameCount = async (): Promise<number> =>
    (await db!.selectFrom('games').select('id').execute()).length

  describe('lineup-fixture', function () {
    let printed: string[] = []
    let fixture: LineupFixture

    before(async function () {
      if (db == null) this.skip()
      printed = []
      fixture = await runLineupFixture(db, ['--password', PASSWORD], text =>
        printed.push(text)
      )
    })

    /** Each team role `userId` holds, as `side:role`, in a stable order. */
    const rolesOf = async (userId: string): Promise<string[]> => {
      const rows = await db!
        .selectFrom('scope_roles')
        .select(['scope_type', 'scope_id', 'role'])
        .where('user_id', '=', userId)
        .execute()
      return rows
        .filter(row => row.scope_type === 'team')
        .filter(row => Object.values(fixture.teams).includes(row.scope_id))
        .map(
          row =>
            `${row.scope_id === fixture.teams.home ? 'home' : 'away'}:${row.role}`
        )
        .sort()
    }

    /** The sides of this run's game whose team `userId` belongs to. */
    const sidesOf = async (userId: string): Promise<string[]> => {
      const rows = await db!
        .selectFrom('memberships')
        .select(['team_id', 'role'])
        .where('user_id', '=', userId)
        .execute()
      return rows
        .filter(row => Object.values(fixture.teams).includes(row.team_id))
        .map(row => {
          expect(row.role).to.equal('member')
          return row.team_id === fixture.teams.home ? 'home' : 'away'
        })
        .sort()
    }

    it('prints the fixture as JSON, without the password', function () {
      expect(printed).to.have.length(1)
      expect(printed[0]).not.to.include(PASSWORD)
      const parsed = JSON.parse(printed[0]) as LineupFixture
      expect(parsed).to.deep.equal(fixture)
      expect(Object.keys(parsed)).to.deep.equal([
        'gameId',
        'seasonId',
        'teams',
        'users',
        'players'
      ])
      expect(Object.keys(parsed.users)).to.deep.equal([
        'scorekeeper',
        'headCoach',
        'assistant',
        'awayCoach',
        'member'
      ])
      for (const user of Object.values(parsed.users))
        expect(Object.keys(user)).to.deep.equal(['email', 'userId'])
      expect(Object.keys(parsed.players)).to.deep.equal(['away', 'home'])
    })

    it('schedules one game between Visitors and Hosts', async function () {
      const game = await db!
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id', 'season_id', 'status'])
        .where('id', '=', fixture.gameId)
        .executeTakeFirstOrThrow()
      expect(game).to.deep.equal({
        home_team_id: fixture.teams.home,
        away_team_id: fixture.teams.away,
        season_id: fixture.seasonId,
        status: 'scheduled'
      })
      const teams = await db!
        .selectFrom('teams')
        .select(['id', 'name'])
        .where('id', 'in', [fixture.teams.home, fixture.teams.away])
        .execute()
      expect(
        Object.fromEntries(teams.map(team => [team.id, team.name]))
      ).to.deep.equal({
        [fixture.teams.home]: 'Hosts',
        [fixture.teams.away]: 'Visitors'
      })
    })

    it('rosters thirteen major leaguers a side, a Freeman on each', async function () {
      for (const side of ['away', 'home'] as const) {
        const players = fixture.players[side]
        expect(players.map(player => player.name)).to.deep.equal(
          LINEUP_NAMES[side]
        )
        expect(players.map(player => player.jersey)).to.deep.equal(
          players.map((_, i) => String(i + 1))
        )
        const freeman = players.find(player => player.name === 'Freeman')
        expect(freeman, side).not.to.equal(undefined)
        const row = await db!
          .selectFrom('memberships')
          .innerJoin('users', 'users.id', 'memberships.user_id')
          .select([
            'users.display_name',
            'users.first_name',
            'users.last_name',
            'memberships.is_player',
            'memberships.jersey'
          ])
          .where('memberships.user_id', '=', freeman!.userId)
          .where('memberships.team_id', '=', fixture.teams[side])
          .executeTakeFirstOrThrow()
        expect(row).to.deep.equal({
          display_name: 'Freeman',
          first_name: null,
          last_name: 'Freeman',
          is_player: true,
          jersey: '13'
        })
      }
      // The two Freemen are two people.
      expect(fixture.players.home[12].userId).not.to.equal(
        fixture.players.away[12].userId
      )
    })

    it("sets each team's default lineup to its first nine, P to RF", async function () {
      for (const side of ['away', 'home'] as const) {
        const team = await db!
          .selectFrom('teams')
          .select('default_lineup')
          .where('id', '=', fixture.teams[side])
          .executeTakeFirstOrThrow()
        // Stored with ids and jerseys and no names, as a live post keeps it.
        const stored = asStoredDefaultLineup(team.default_lineup)
        const nine = fixture.players[side].slice(0, 9)
        const kept = nine.map(({ gumboId, jersey }) => ({ gumboId, jersey }))
        expect(stored.fromGameId).to.equal(null)
        expect(
          JSON.parse(JSON.stringify(stored.lineup?.batters))
        ).to.deep.equal(kept)
        expect(JSON.stringify(team.default_lineup)).not.to.include('"name"')
        // Read, each is named from his account.
        const value = await resolvedDefaultOf(
          db!,
          fixture.teams[side],
          team.default_lineup
        )
        const named = nine.map(({ userId: _, ...person }) => person)
        expect(value?.lineup?.batters).to.deep.equal(named)
        expect(value?.lineup?.defense.P).to.deep.equal(named[0])
        expect(value?.lineup?.defense.RF).to.deep.equal(named[8])
        // Freeman starts on the bench.
        expect(
          value?.lineup?.batters.map(batter => batter.name)
        ).not.to.include('Freeman')
      }
    })

    it('gives the five people their teams and roles', async function () {
      const { users } = fixture
      expect(await rolesOf(users.scorekeeper.userId)).to.deep.equal([
        'away:scorekeeper',
        'home:scorekeeper'
      ])
      expect(await sidesOf(users.scorekeeper.userId)).to.deep.equal([
        'away',
        'home'
      ])
      expect(await rolesOf(users.headCoach.userId)).to.deep.equal([
        'home:coach'
      ])
      expect(await sidesOf(users.headCoach.userId)).to.deep.equal(['home'])
      expect(await rolesOf(users.assistant.userId)).to.deep.equal([
        'home:assistant'
      ])
      expect(await sidesOf(users.assistant.userId)).to.deep.equal(['home'])
      expect(await rolesOf(users.awayCoach.userId)).to.deep.equal([
        'away:coach'
      ])
      expect(await sidesOf(users.awayCoach.userId)).to.deep.equal(['away'])
      expect(await rolesOf(users.member.userId)).to.deep.equal([])
      expect(await sidesOf(users.member.userId)).to.deep.equal(['home'])
    })

    it('lets each person sign in with an e-mail and the password', async function () {
      for (const user of Object.values(fixture.users)) {
        const row = await db!
          .selectFrom('users')
          .innerJoin('user_emails', 'user_emails.user_id', 'users.id')
          .select([
            'users.password_hash',
            'users.login_enabled',
            'users.is_admin',
            'user_emails.email'
          ])
          .where('users.id', '=', user.userId)
          .executeTakeFirstOrThrow()
        expect(row.email).to.equal(user.email)
        expect(row.login_enabled).to.equal(true)
        expect(row.is_admin).to.equal(false)
        expect(row.password_hash).to.be.a('string')
        expect(row.password_hash).not.to.include(PASSWORD)
      }
    })

    it('run again, makes a new game for the same five people', async function () {
      const again: string[] = []
      const second = await runLineupFixture(
        db!,
        ['--password', PASSWORD],
        text => again.push(text)
      )
      expect(second.gameId).not.to.equal(fixture.gameId)
      expect(second.teams.home).not.to.equal(fixture.teams.home)
      expect(second.users).to.deep.equal(fixture.users)
      const roles = await db!
        .selectFrom('scope_roles')
        .select(['scope_id', 'role'])
        .where('user_id', '=', second.users.headCoach.userId)
        .where('scope_id', '=', second.teams.home)
        .execute()
      expect(roles.map(row => row.role)).to.deep.equal(['coach'])
    })

    it('throws the usage for any other arguments', async function () {
      const before = await gameCount()
      const usage = 'Usage: npm run lineup-fixture -- --password <password>'
      for (const args of [
        [],
        ['--password'],
        ['--password', ''],
        ['--password', PASSWORD, '--extra'],
        [PASSWORD, '--password']
      ])
        expect(
          await rejection(
            async () => await runLineupFixture(db!, args, () => {})
          ),
          args.join(' ')
        ).to.equal(usage)
      expect(await gameCount()).to.equal(before)
    })

    it('refuses to run in production', async function () {
      const before = await gameCount()
      const said: string[] = []
      const message = await inProduction(
        async () =>
          await rejection(
            async () =>
              await runLineupFixture(db!, ['--password', PASSWORD], text =>
                said.push(text)
              )
          )
      )
      expect(message).to.equal(
        'The lineup-fixture script does not run in production'
      )
      expect(said).to.deep.equal([])
      expect(await gameCount()).to.equal(before)
    })
  })

  describe('scoring-game', function () {
    before(function () {
      if (db == null) this.skip()
    })

    it('makes the games and a viewer on the home team, and prints their ids', async function () {
      const printed: string[] = []
      await runScoringGame(
        db!,
        ['viewer@example.test', PASSWORD, '--games', '2'],
        line => printed.push(line)
      )
      expect(printed).to.have.length(5)
      const games = printed.slice(0, 2).map(line => {
        expect(line).to.match(/^GAME_ID=/)
        return line.slice('GAME_ID='.length)
      })
      const ids = (line: string, key: string): string[] => {
        expect(line.startsWith(`${key}=`), line).to.equal(true)
        return line.slice(key.length + 1).split(',')
      }
      const away = ids(printed[2], 'AWAY')
      const home = ids(printed[3], 'HOME')
      const [viewer] = ids(printed[4], 'VIEWER')
      expect(away).to.have.length(9)
      expect(home).to.have.length(9)
      expect(printed.join('\n')).not.to.include(PASSWORD)

      const rows = await db!
        .selectFrom('games')
        .select(['id', 'home_team_id', 'away_team_id'])
        .where('id', 'in', games)
        .execute()
      expect(rows).to.have.length(2)
      const homeTeamId = rows[0].home_team_id

      // The default names, a first and a last, in batting order.
      const firstHome = await db!
        .selectFrom('users')
        .select(['display_name', 'first_name', 'last_name'])
        .where('id', '=', home[0])
        .executeTakeFirstOrThrow()
      expect(firstHome).to.deep.equal({
        display_name: 'Host 01',
        first_name: 'Host',
        last_name: '01'
      })
      const lastAway = await db!
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select(['users.display_name', 'memberships.positions'])
        .where('users.id', '=', away[8])
        .executeTakeFirstOrThrow()
      expect(lastAway).to.deep.equal({
        display_name: 'Visitor 09',
        positions: ['RF']
      })

      const viewerTeams = await db!
        .selectFrom('memberships')
        .select(['team_id', 'role'])
        .where('user_id', '=', viewer)
        .execute()
      expect(viewerTeams).to.deep.equal([
        { team_id: homeTeamId, role: 'member' }
      ])
      const email = await db!
        .selectFrom('user_emails')
        .select('email')
        .where('user_id', '=', viewer)
        .executeTakeFirstOrThrow()
      expect(email.email).to.equal('viewer@example.test')
    })

    it('throws the usage for arguments it does not understand', async function () {
      const before = await gameCount()
      const usage =
        'Usage: npm run scoring-game -- <viewerEmail> <viewerPassword> [--games <n>]'
      for (const args of [
        [],
        ['viewer@example.test'],
        ['viewer@example.test', PASSWORD, '--games', '0'],
        ['viewer@example.test', PASSWORD, '--games', 'two']
      ])
        expect(
          await rejection(async () => {
            await runScoringGame(db!, args, () => {})
          }),
          args.join(' ')
        ).to.equal(usage)
      expect(await gameCount()).to.equal(before)
    })

    it('refuses to run in production', async function () {
      const before = await gameCount()
      const message = await inProduction(
        async () =>
          await rejection(async () => {
            await runScoringGame(
              db!,
              ['viewer@example.test', PASSWORD],
              () => {}
            )
          })
      )
      expect(message).to.equal(
        'The scoring-game script does not run in production'
      )
      expect(await gameCount()).to.equal(before)
    })
  })
})
