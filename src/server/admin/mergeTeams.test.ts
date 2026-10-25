import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { listenScreenScopes } from '../../test/screenScopeNotices'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { replaceGameEvents } from '../events/eventWrite'
import { mergeTeams } from './mergeTeams'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_mergeteams_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

/**
 * The real shape of the problem, in miniature.
 *
 * One fixture, written down twice by two clubs who disagreed about which of
 * them was at home. The club that kept score has the plays and no video; the
 * club that filmed it has the video and nothing else. That is not a contrived
 * case — it is the QPLL playoffs, where every team entered its opponent by
 * hand as a new team.
 */
describe('merging two rows that are one team', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined

  const hawks = makeId('team')
  const houser = makeId('team')
  const widows = makeId('team')
  const scoredGame = makeId('game')
  const filmedGame = makeId('game')
  const videoId = makeId('video')
  const startAt = new Date('2026-05-20T23:45:00.000Z')

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

    await db
      .insertInto('teams')
      .values([
        { id: hawks, name: 'Alta Hawks', kind: 'full' },
        { id: houser, name: 'NP5 Maddux', kind: 'external' },
        { id: widows, name: 'Bay Widows', kind: 'full' }
      ])
      .execute()

    // Scored by the Widows' club: they were away, Houser — really the Hawks —
    // were at home. 14-4, with plays.
    await db
      .insertInto('games')
      .values({
        id: scoredGame,
        home_team_id: houser,
        away_team_id: widows,
        start_at: startAt,
        status: 'final',
        home_score: 4,
        away_score: 14
      })
      .execute()
    await db
      .insertInto('events')
      .values(
        [0, 1, 2].map(index => ({
          id: makeId('event'),
          gameId: scoredGame,
          battingTeamId: widows,
          source: 'external' as const,
          gumbo: {
            about: { atBatIndex: index },
            result: { eventType: 'single', awayScore: 14, homeScore: 4 }
          }
        }))
      )
      .execute()

    // The Hawks' own record of the same fixture: sides the other way round,
    // never scored, but it is the one with the video on it.
    await db
      .insertInto('games')
      .values({
        id: filmedGame,
        home_team_id: widows,
        away_team_id: hawks,
        start_at: startAt,
        status: 'scheduled'
      })
      .execute()
    // The filmed record was linked to a registry field and warned about it.
    await db
      .insertInto('venues')
      .values({
        id: 'ven_merge',
        google_place_id: 'place-merge',
        name: 'Demo Park',
        latitude: 40,
        longitude: -75,
        timezone: 'America/New_York'
      })
      .execute()
    await db
      .insertInto('venue_fields')
      .values({
        id: 'fld_merge',
        venue_id: 'ven_merge',
        name: 'Field 1',
        sizes: ['50/70']
      })
      .execute()
    await db
      .updateTable('games')
      .set({ field_id: 'fld_merge', field_size: '50/70' })
      .where('id', '=', filmedGame)
      .execute()
    await db
      .insertInto('game_field_warnings')
      .values({ game_id: filmedGame, kind: 'outsideAvailability' })
      .execute()
    // And the Auto-Scheduler had published it.
    const planner = mintUserId(() => false)
    await insertFixtureUsers(db, {
      id: userIdOfGumbo(planner.userId),
      legacyId: planner.legacyId,
      display_name: 'Demo Planner',
      created_at: new Date(),
      updated_at: new Date()
    })
    await db
      .insertInto('leagues')
      .values({
        id: 'lea_merge',
        name: 'Demo League',
        created_at: new Date(),
        updated_at: new Date()
      })
      .execute()
    await db
      .insertInto('seasons')
      .values({
        id: 'sea_merge',
        name: 'Demo Season',
        year: 2026,
        starts_on: '2026-03-01',
        ends_on: '2026-05-31',
        created_at: new Date(),
        updated_at: new Date()
      })
      .execute()
    await db
      .insertInto('schedule_previews')
      .values({
        id: 'spv_merge',
        league_id: 'lea_merge',
        created_by: userIdOfGumbo(planner.userId),
        mode: 'full',
        input: '{}'
      })
      .execute()
    await db
      .updateTable('games')
      .set({ schedule_preview_id: 'spv_merge' })
      .where('id', '=', filmedGame)
      .execute()
    await db
      .insertInto('schedule_preview_games')
      .values({
        preview_id: 'spv_merge',
        game_key: 'game-1',
        season_id: 'sea_merge',
        home_team_id: widows,
        away_team_id: hawks,
        game_id: filmedGame
      })
      .execute()
    // Two of its games name the team merged away: one still to reschedule.
    await db
      .insertInto('schedule_preview_games')
      .values([
        {
          preview_id: 'spv_merge',
          game_key: 'game-2',
          season_id: 'sea_merge',
          home_team_id: houser,
          away_team_id: widows
        },
        {
          preview_id: 'spv_merge',
          game_key: 'game-3',
          season_id: 'sea_merge',
          home_team_id: widows,
          away_team_id: houser
        }
      ])
      .execute()
    await db
      .insertInto('videos')
      .values({
        id: videoId,
        game_id: filmedGame,
        kind: 'program',
        title: '2026-05-20 Hawks vs Bay Widows',
        storage: 'peertube',
        status: 'ready'
      })
      .execute()
  })

  after(async function () {
    if (db != null) await db.destroy()
    else if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('writes nothing without being asked to', async function () {
    if (db == null) this.skip()
    const report = await mergeTeams(db, {
      fromTeamId: houser,
      intoTeamId: hawks
    })
    expect(report.applied).equals(false)
    expect(report.fixtures.length).equals(1)
    expect(report.fixtures[0].orientationDiffers).equals(true)

    const still = await db
      .selectFrom('games')
      .select('id')
      .where('id', '=', filmedGame)
      .executeTakeFirst()
    expect(still != null, 'the game is still there').equals(true)
  })

  it('keeps the scored game and moves the video onto it', async function () {
    if (db == null) this.skip()
    const notices = await listenScreenScopes(db)
    const mark = notices.mark()
    const report = await mergeTeams(db, {
      fromTeamId: houser,
      intoTeamId: hawks,
      apply: true
    })
    expect(report.applied).equals(true)
    // Both teams' screens are told, and the game that moved.
    try {
      for (const ids of [
        { teamId: houser },
        { teamId: hawks },
        { gameId: scoredGame }
      ])
        await notices.named(mark, ids)
    } finally {
      await notices.close()
    }
    expect(report.fixtures[0].keptGameId).equals(scoredGame)
    expect(report.fixtures[0].videosMoved).equals(1)

    const game = await db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', scoredGame)
      .executeTakeFirstOrThrow()

    // The orientation of the record that holds the plays is preserved, so the
    // 59 real events never have to have their scores swapped round.
    expect(game.home_team_id, 'the Hawks were at home').equals(hawks)
    expect(game.away_team_id).equals(widows)
    expect(game.away_score).equals(14)
    expect(game.home_score).equals(4)

    const video = await db
      .selectFrom('videos')
      .select('game_id')
      .where('id', '=', videoId)
      .executeTakeFirstOrThrow()
    expect(video.game_id, 'the video followed').equals(scoredGame)
    // The field went with the fixture, and the retired game's warning with
    // the retired game.
    expect([game.field_id, game.field_size]).deep.equals(['fld_merge', '50/70'])
    // So did its place in the schedule it was published from.
    expect(game.schedule_preview_id).equals('spv_merge')
    expect(
      await db
        .selectFrom('schedule_preview_games')
        .select(['game_key', 'game_id', 'home_team_id', 'away_team_id'])
        .orderBy('game_key')
        .execute()
    ).deep.equals([
      {
        game_key: 'game-1',
        game_id: scoredGame,
        home_team_id: widows,
        away_team_id: hawks
      },
      // The teams it names follow the merge, so the games to reschedule are
      // the kept team's.
      {
        game_key: 'game-2',
        game_id: null,
        home_team_id: hawks,
        away_team_id: widows
      },
      {
        game_key: 'game-3',
        game_id: null,
        home_team_id: widows,
        away_team_id: hawks
      }
    ])
    expect(
      await db.selectFrom('game_field_warnings').select('game_id').execute()
    ).deep.equals([])

    const gone = await db
      .selectFrom('games')
      .select('id')
      .where('id', '=', filmedGame)
      .executeTakeFirst()
    expect(gone == null, 'the emptier row is gone').equals(true)

    const team = await db
      .selectFrom('teams')
      .select('merged_into')
      .where('id', '=', houser)
      .executeTakeFirstOrThrow()
    expect(team.merged_into).equals(hawks)

    const owed = await db
      .selectFrom('game_stats_state')
      .selectAll()
      .where('game_id', '=', scoredGame)
      .executeTakeFirstOrThrow()
    expect(Number(owed.requested_generation)).greaterThan(
      Number(owed.built_generation)
    )
    expect(owed.status).equals('pending')
  })

  it('refuses to merge a team into itself', async function () {
    if (db == null) this.skip()
    let refused = false
    try {
      await mergeTeams(db, { fromTeamId: hawks, intoTeamId: hawks })
    } catch {
      refused = true
    }
    expect(refused).equals(true)
  })

  it('refuses to merge two teams that play each other, and changes nothing', async function () {
    if (db == null) this.skip()
    const from = makeId('team')
    const into = makeId('team')
    const between = makeId('game')
    await db
      .insertInto('teams')
      .values([
        { id: from, name: 'Copy Owls', kind: 'external' },
        { id: into, name: 'Owls', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values({
        id: between,
        home_team_id: into,
        away_team_id: from,
        start_at: startAt,
        status: 'scheduled',
        guests: { [into]: [], [from]: [] }
      })
      .execute()
    // And a scheduler's proposal still waiting, which would publish another,
    // and one declined, which never will.
    const { created_by: planner } = await db
      .selectFrom('schedule_previews')
      .select('created_by')
      .where('id', '=', 'spv_merge')
      .executeTakeFirstOrThrow()
    const proposal = {
      kind: 'game' as const,
      sender_id: planner,
      sender_scope_type: 'season' as const,
      sender_scope_id: 'sea_merge',
      terms: '{}',
      sent_at: new Date(),
      expires_at: new Date(Date.now() + 86400000)
    }
    await db
      .insertInto('group_requests')
      .values([
        { ...proposal, id: 'grq_owls_waiting', status: 'pending' },
        { ...proposal, id: 'grq_owls_declined', status: 'declined' }
      ])
      .execute()
    await db
      .insertInto('schedule_preview_games')
      .values([
        {
          preview_id: 'spv_merge',
          game_key: 'owls-1',
          season_id: 'sea_merge',
          home_team_id: from,
          away_team_id: into,
          request_id: 'grq_owls_waiting'
        },
        {
          preview_id: 'spv_merge',
          game_key: 'owls-2',
          season_id: 'sea_merge',
          home_team_id: into,
          away_team_id: from,
          request_id: 'grq_owls_declined'
        }
      ])
      .execute()
    for (const apply of [false, true]) {
      let refused: unknown
      try {
        await mergeTeams(db, { fromTeamId: from, intoTeamId: into, apply })
      } catch (error) {
        refused = error
      }
      expect(String(refused), String(apply)).includes(
        `Copy Owls and Owls play each other in ${between}, proposal grq_owls_waiting;`
      )
    }
    await db
      .deleteFrom('schedule_preview_games')
      .where('game_key', 'in', ['owls-1', 'owls-2'])
      .execute()
    expect(
      await db
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id'])
        .where('id', '=', between)
        .executeTakeFirstOrThrow()
    ).deep.equals({ home_team_id: into, away_team_id: from })
    expect(
      (
        await db
          .selectFrom('teams')
          .select('merged_into')
          .where('id', '=', from)
          .executeTakeFirstOrThrow()
      ).merged_into
    ).equals(null)
    // With the game gone and only the declined proposal left, it merges.
    await db.deleteFrom('games').where('id', '=', between).execute()
    await db
      .deleteFrom('group_requests')
      .where('id', '=', 'grq_owls_waiting')
      .execute()
    await db
      .insertInto('schedule_preview_games')
      .values({
        preview_id: 'spv_merge',
        game_key: 'owls-2',
        season_id: 'sea_merge',
        home_team_id: into,
        away_team_id: from,
        request_id: 'grq_owls_declined'
      })
      .execute()
    const report = await mergeTeams(db, { fromTeamId: from, intoTeamId: into })
    expect(report.applied).equals(false)
    await db
      .deleteFrom('schedule_preview_games')
      .where('game_key', '=', 'owls-2')
      .execute()
  })

  it('a drain after merge writes rows with the surviving team id', async function () {
    if (db == null) this.skip()
    // Fresh pair: fromTeam is home, intoTeam is the survivor name for team_id.
    const from = makeId('team')
    const into = makeId('team')
    const opponent = makeId('team')
    const game = makeId('game')
    const held = new Set<number>()
    const mint = (): { userId: number; legacyId: string } => {
      const made = mintUserId(id => held.has(id))
      held.add(made.userId)
      return made
    }
    const batter = mint()
    const pitcher = mint()
    const now = new Date()
    await db
      .insertInto('teams')
      .values([
        { id: from, name: 'From', kind: 'external' },
        { id: into, name: 'Into', kind: 'full' },
        { id: opponent, name: 'Opp', kind: 'full' }
      ])
      .execute()
    for (const user of [batter, pitcher]) {
      await insertFixtureUsers(db, {
        id: userIdOfGumbo(user.userId),
        legacyId: user.legacyId,
        display_name: 'P',
        created_at: now,
        updated_at: now
      })
    }
    await db
      .insertInto('games')
      .values({
        id: game,
        home_team_id: from,
        away_team_id: opponent,
        start_at: now
      })
      .execute()
    await replaceGameEvents(db, {
      gameId: game,
      homeTeamId: from,
      awayTeamId: opponent,
      plays: [
        {
          gumbo: {
            about: { atBatIndex: 0, inning: 1, halfInning: 'bottom' },
            result: { eventType: 'single', awayScore: 0, homeScore: 0 },
            count: { outs: 0 },
            matchup: {
              batter: { id: batter.userId },
              pitcher: { id: pitcher.userId }
            },
            runners: [
              {
                movement: { start: null, end: '1B', isOut: false },
                details: {
                  eventType: 'single',
                  runner: { id: batter.userId }
                }
              }
            ]
          },
          source: 'manual'
        }
      ]
    })
    await mergeTeams(db, { fromTeamId: from, intoTeamId: into, apply: true })
    const { drain } = await import('../statsBuilder/builder')
    await drain(db, () => new Date('2026-09-25T12:00:00.000Z'))
    const rows = await db
      .selectFrom('game_player_stats')
      .select(['gumbo_id', 'team_id'])
      .where('game_id', '=', game)
      .execute()
    expect(rows.length).greaterThan(0)
    const bat = rows.find(row => Number(row.gumbo_id) === batter.userId)!
    expect(bat.team_id).equals(into)
  })
})
