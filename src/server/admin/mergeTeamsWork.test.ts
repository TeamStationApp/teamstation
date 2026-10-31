import { expect } from 'chai'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { mergeTeams } from './mergeTeams'

const scratchName = `teamstation_mergework_${process.pid}_${Date.now()}`
const BATTER = 11
const PITCHER = 12

interface Teams {
  from: string
  into: string
  opponent: string
}

/** A play as a version 3 record stores it, its lineups under the teams' ids. */
function play(
  index: number,
  teams: Teams,
  version: number
): Record<string, unknown> {
  return {
    about: { atBatIndex: index },
    matchup: { batter: { id: BATTER }, pitcher: { id: PITCHER } },
    credits: [{ eventType: 'single', head: 'Single', creditUserId: BATTER }],
    teamStation: {
      version,
      setupBefore: {
        players: { p1: { teamId: teams.from } },
        teams: { [teams.from]: { order: [] }, [teams.opponent]: { order: [] } }
      },
      actions: []
    }
  }
}

/** A play with no record of TeamStation's. */
function thinPlay(index: number): Record<string, unknown> {
  return {
    about: { atBatIndex: index },
    matchup: { batter: { id: BATTER }, pitcher: { id: PITCHER } }
  }
}

/** A merge's work, in what it counts rather than how long it takes. */
describe('the work a team merge does', function () {
  this.timeout(60000)
  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>

  const seedTeams = async (): Promise<Teams> => {
    const teams = {
      from: makeId('team'),
      into: makeId('team'),
      opponent: makeId('team')
    }
    await db
      .insertInto('teams')
      .values([
        { id: teams.from, name: 'From', kind: 'external' },
        { id: teams.into, name: 'Into', kind: 'full' },
        { id: teams.opponent, name: 'Opponent', kind: 'full' }
      ])
      .execute()
    return teams
  }

  /** `games` games of the source team, two plays each, one team batting each. */
  const seedGames = async (
    teams: Teams,
    games: number,
    version = 3
  ): Promise<string[]> => {
    const ids: string[] = []
    for (let g = 0; g < games; g++) {
      const id = makeId('game')
      ids.push(id)
      await db
        .insertInto('games')
        .values({
          id,
          home_team_id: teams.from,
          away_team_id: teams.opponent,
          start_at: new Date(Date.UTC(2026, 0, 1 + g, 18)),
          status: 'final'
        })
        .execute()
      await db
        .insertInto('events')
        .values(
          [teams.from, teams.opponent].map((batting, index) => ({
            id: makeId('event'),
            gameId: id,
            battingTeamId: batting,
            source: 'external' as const,
            gumbo: play(index, teams, version) as never
          }))
        )
        .execute()
    }
    return ids
  }

  /** Runs a merge, counting statements sent and each kind of row written. */
  const measured = async (
    teams: Teams
  ): Promise<{ statements: number; syncs: number; rewrites: number }> => {
    await sql`truncate merge_work_writes`.execute(db)
    let statements = 0
    const logged = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      log: event => {
        if (event.level === 'query') statements += 1
      }
    })
    await mergeTeams(logged, {
      fromTeamId: teams.from,
      intoTeamId: teams.into,
      apply: true
    })
    const { rows } = await sql<{ kind: string; n: string }>`
      select kind, count(*)::text as n from merge_work_writes group by kind
    `.execute(db)
    const count = (kind: string): number =>
      Number(rows.find(row => row.kind === kind)?.n ?? 0)
    return {
      statements,
      syncs: count('sync'),
      rewrites: count('rewrite')
    }
  }

  const playersOf = async (
    teams: Teams,
    gameIds: string[]
  ): Promise<
    Array<{ role: string; team_id: string | null; batting: string }>
  > =>
    (
      await sql<{ role: string; team_id: string | null; batting: string }>`
        select p.role, p.team_id, e."battingTeamId" as batting
        from event_players p join events e on e.id = p.event_id
        where e."gameId" = any(${gameIds}::text[])
        order by e."battingTeamId" = ${teams.into} desc, p.role
      `.execute(db)
    ).rows

  before(async () => {
    attachInt8Parser()
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${scratchName}`)
    })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    for (const id of [BATTER, PITCHER]) {
      const userId = userIdOfGumbo(id)
      await sql`insert into users (id, display_name, first_name, last_name)
        values (${userId}, 'A Player', 'A', 'Player')`.execute(db)
      await sql`insert into gumbo_ids (gumbo_id, user_id)
        values (${id}, ${userId})`.execute(db)
    }
    // Beside the sync trigger: `sync` fires when it would, `rewrite` for every
    // write of a play's record.
    await sql
      .raw(
        `
      create table merge_work_writes (kind text not null);
      create function merge_work_write() returns trigger language plpgsql as $$
      begin
        insert into merge_work_writes values (tg_argv[0]);
        return null;
      end $$;
      create trigger merge_work_sync after update of gumbo, "battingTeamId" on events
        for each row
        when (current_setting('teamstation.event_children_held', true) is distinct from 'on')
        execute function merge_work_write('sync');
      create trigger merge_work_rewrite after update of gumbo on events
        for each row execute function merge_work_write('rewrite');
    `
      )
      .execute(db)
  })

  after(async () => {
    await db?.destroy()
    await admin?.query(`drop database if exists ${scratchName}`)
    await admin?.end()
  })

  it('sends the same statements for 2 games as for 20, and rewrites each play once', async () => {
    const few = await seedTeams()
    await seedGames(few, 2)
    const small = await measured(few)
    const many = await seedTeams()
    await seedGames(many, 20)
    const large = await measured(many)

    expect(large.statements).equals(small.statements)
    expect(small.rewrites).equals(2 * 2)
    expect(large.rewrites).equals(20 * 2)
    // Children are rebuilt in a set: the trigger never fires a row at a time.
    expect(large.syncs).equals(0)
  })

  it('grows by a batch of statements per 25 games, no more', async () => {
    const teams = await seedTeams()
    await seedGames(teams, 2)
    const one = await measured(teams)
    const next = await seedTeams()
    await seedGames(next, 60)
    const three = await measured(next)
    expect(three.statements - one.statements).at.most(2 * 8)
    expect(three.rewrites).equals(60 * 2)
    expect(three.syncs).equals(0)
  })

  it('leaves a rewritten play’s record and children on the merged game', async () => {
    const teams = await seedTeams()
    const games = await seedGames(teams, 1)
    await measured(teams)

    const records = await db
      .selectFrom('events')
      .select(['gumbo', 'battingTeamId'])
      .where('gameId', '=', games[0])
      .execute()
    for (const { gumbo } of records) {
      const text = JSON.stringify(gumbo)
      expect(text).not.includes(teams.from)
      expect(text).includes(teams.into)
    }
    expect(records.map(row => row.battingTeamId)).members([
      teams.into,
      teams.opponent
    ])

    // Read under the merged game, each pitcher is on the other team.
    const players = await playersOf(teams, games)
    expect(players).deep.equals([
      { role: 'batter', team_id: teams.into, batting: teams.into },
      { role: 'pitcher', team_id: teams.opponent, batting: teams.into },
      { role: 'batter', team_id: teams.opponent, batting: teams.opponent },
      { role: 'pitcher', team_id: teams.into, batting: teams.opponent }
    ])
    const state = await db
      .selectFrom('game_stats_state')
      .select(['game_id', 'requested_generation', 'status'])
      .where('game_id', '=', games[0])
      .execute()
    expect(state).length(1)
    expect(state[0].status).equals('pending')
  })

  it('keeps what a play with an older record has always been left with', async () => {
    const teams = await seedTeams()
    const games = await seedGames(teams, 1, 2)
    const work = await measured(teams)

    expect(work.rewrites).equals(0)
    const records = await db
      .selectFrom('events')
      .select('gumbo')
      .where('gameId', '=', games[0])
      .execute()
    // An older record names sides and is not rewritten.
    for (const { gumbo } of records)
      expect(JSON.stringify(gumbo)).includes(teams.from)
    // Its batting team moved while the game still named the source team, so
    // that play's pitcher could not be told; the other play's moved by id.
    expect(await playersOf(teams, games)).deep.equals([
      { role: 'batter', team_id: teams.into, batting: teams.into },
      { role: 'pitcher', team_id: null, batting: teams.into },
      { role: 'batter', team_id: teams.opponent, batting: teams.opponent },
      { role: 'pitcher', team_id: teams.into, batting: teams.opponent }
    ])
  })

  it('merges a team with no games', async () => {
    const teams = await seedTeams()
    const work = await measured(teams)
    expect(work.rewrites).equals(0)
    const merged = await db
      .selectFrom('teams')
      .select('merged_into')
      .where('id', '=', teams.from)
      .executeTakeFirstOrThrow()
    expect(merged.merged_into).equals(teams.into)
  })

  it('counts each duplicate fixture’s videos and external ids in one read each, and rewrites no retired game', async () => {
    const teams = await seedTeams()
    const games = await seedGames(teams, 3)
    const thin = games.map(() => makeId('game'))
    for (let g = 0; g < games.length; g++) {
      await db
        .insertInto('games')
        .values({
          id: thin[g],
          home_team_id: teams.into,
          away_team_id: teams.opponent,
          start_at: new Date(Date.UTC(2026, 0, 1 + g, 18))
        })
        .execute()
      await db
        .insertInto('videos')
        .values(
          [0, 1].map(n => ({
            id: makeId('video'),
            game_id: thin[g],
            kind: 'program',
            title: `Video ${n}`,
            storage: 'local'
          })) as never
        )
        .execute()
      await db
        .insertInto('external_ids')
        .values({
          id: makeId('externalId'),
          entity_type: 'game',
          entity_id: thin[g],
          system: 'mergework',
          kind: 'game',
          external_id: thin[g]
        })
        .execute()
    }
    const report = await mergeTeams(db, {
      fromTeamId: teams.from,
      intoTeamId: teams.into
    })
    expect(report.fixtures.map(f => f.retiredGameId)).members(thin)
    expect(report.fixtures.map(f => f.videosMoved)).deep.equals([2, 2, 2])
    expect(report.fixtures.map(f => f.externalIdsMoved)).deep.equals([1, 1, 1])

    await measured(teams)
    const videos = await db
      .selectFrom('videos')
      .select('game_id')
      .where('game_id', 'in', games)
      .execute()
    expect(videos).length(6)
  })

  it('does not rewrite the records of a source game it retires', async () => {
    const teams = await seedTeams()
    const [source] = await seedGames(teams, 1)
    const kept = makeId('game')
    await db
      .insertInto('games')
      .values({
        id: kept,
        home_team_id: teams.into,
        away_team_id: teams.opponent,
        start_at: new Date(Date.UTC(2026, 0, 1, 18))
      })
      .execute()
    await db
      .insertInto('events')
      .values(
        [0, 1, 2].map(index => ({
          id: makeId('event'),
          gameId: kept,
          battingTeamId: teams.into,
          source: 'external' as const,
          gumbo: thinPlay(index) as never
        }))
      )
      .execute()
    const work = await measured(teams)
    expect(work.rewrites).equals(0)
    expect(
      await db
        .selectFrom('games')
        .select('id')
        .where('id', '=', source)
        .executeTakeFirst()
    ).equals(undefined)
    const stats = await db
      .selectFrom('game_stats_state')
      .select('game_id')
      .where('game_id', '=', kept)
      .execute()
    expect(stats).length(0)
  })
})
