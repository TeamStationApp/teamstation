import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import {
  type GuardianFixture,
  guardianFixture
} from '../../test/guardianFixture'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { teamsOf } from './players'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_teamsof_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const spring = makeId('season')
const fall = makeId('season')
const badgers = makeId('team')
const comets = makeId('team')
const closed = makeId('team')
const survivor = makeId('team')
const loose = makeId('team')
const held = new Set<number>()
const legacies = new Map<number, string>()
function mint(): number {
  const made = mintUserId(id => held.has(id))
  held.add(made.userId)
  legacies.set(made.userId, made.legacyId)
  return made.userId
}
const child = mint()

describe('the teams and seasons a player has played in', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined
  let day = 0

  /** A game on this team in this season, with a stat line for the child. */
  async function line(teamId: string, seasonId: string | null): Promise<void> {
    const gameId = makeId('game')
    day += 1
    await db!
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: teamId,
        away_team_id: loose,
        season_id: seasonId,
        start_at: new Date(Date.UTC(2026, 3, day)),
        status: 'final'
      })
      .execute()
    await db!
      .insertInto('game_player_stats')
      .values({
        id: makeId('gamePlayerStats'),
        game_id: gameId,
        gumbo_id: child,
        team_id: teamId,
        pa: 3,
        ab: 3,
        h: 1
      })
      .execute()
  }

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

    const now = new Date()
    await db
      .insertInto('users')
      .values({
        id: child,
        legacyId: legacies.get(child)!,
        display_name: 'Jordan P',
        first_name: 'Jordan',
        last_name: 'P',
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      .insertInto('seasons')
      .values([
        { id: spring, name: 'Spring 2026', year: 2026 },
        { id: fall, name: 'Fall 2025', year: 2025 }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: badgers, name: 'Badgers' },
        { id: comets, name: 'Comets' },
        { id: survivor, name: 'Survivor' },
        { id: loose, name: 'Opponent', kind: 'external' }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values({ id: closed, name: 'Closed', merged_into: survivor })
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

  it('lists every team and season the player has a stat line for, newest first', async function () {
    await line(badgers, spring)
    await line(badgers, spring)
    await line(comets, fall)
    expect(await teamsOf(db!, [child])).deep.equals([
      {
        teamId: badgers,
        teamName: 'Badgers',
        seasonId: spring,
        seasonName: 'Spring 2026',
        seasonYear: 2026,
        jersey: null,
        positions: [],
        current: false,
        logoPath: null
      },
      {
        teamId: comets,
        teamName: 'Comets',
        seasonId: fall,
        seasonName: 'Fall 2025',
        seasonYear: 2025,
        jersey: null,
        positions: [],
        current: false,
        logoPath: null
      }
    ])
  })

  it('leaves out a team that has been merged into another', async function () {
    await line(closed, spring)
    const teams = await teamsOf(db!, [child])
    expect(teams.map(team => team.teamId)).not.include(closed)
  })

  it('lists a stat line in a game with no season after the seasons', async function () {
    await line(survivor, null)
    const teams = await teamsOf(db!, [child])
    expect(teams[teams.length - 1]).deep.equals({
      teamId: survivor,
      teamName: 'Survivor',
      seasonId: null,
      seasonName: null,
      seasonYear: null,
      jersey: null,
      positions: [],
      current: false,
      logoPath: null
    })
  })

  it('still lists a membership with no stat line, and a team from both sources once', async function () {
    const now = new Date()
    const spare = makeId('team')
    await db!.insertInto('teams').values({ id: spare, name: 'Spare' }).execute()
    await db!
      .insertInto('season_teams')
      .values([
        { season_id: spring, team_id: spare },
        { season_id: spring, team_id: badgers }
      ])
      .execute()
    await db!
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          team_id: spare,
          user_id: child,
          role: 'member',
          is_player: true,
          joined_at: now
        },
        {
          id: makeId('membership'),
          team_id: badgers,
          user_id: child,
          role: 'member',
          is_player: true,
          joined_at: now
        }
      ])
      .execute()
    const teams = await teamsOf(db!, [child])
    expect(teams.filter(team => team.teamId === spare)).to.have.length(1)
    expect(
      teams.filter(team => team.teamId === badgers && team.seasonId === spring)
    ).to.have.length(1)
  })

  it('carries the number and positions of each team’s membership, newest season first', async function () {
    const now = new Date()
    // A closed row of the child's, from an earlier import, on two teams.
    const earlier = mint()
    await db!
      .insertInto('users')
      .values({
        id: earlier,
        legacyId: legacies.get(earlier)!,
        display_name: 'Jordan P',
        merged_into: child,
        created_at: now,
        updated_at: now
      })
      .execute()
    await db!
      .updateTable('memberships')
      .set({ jersey: '7', positions: ['SS', '2B'] })
      .where('user_id', '=', child)
      .where('team_id', '=', badgers)
      .execute()
    await db!
      .insertInto('memberships')
      .values([
        // The open row's number wins on a team both rows are on.
        {
          id: makeId('membership'),
          team_id: badgers,
          user_id: earlier,
          role: 'member',
          is_player: true,
          jersey: '99',
          positions: ['P'],
          joined_at: now
        },
        // And the closed row's is the child's where it is the only one.
        {
          id: makeId('membership'),
          team_id: comets,
          user_id: earlier,
          role: 'member',
          is_player: true,
          jersey: '12',
          positions: ['C'],
          joined_at: now
        }
      ])
      .execute()

    const teams = await teamsOf(db!, [child, earlier])
    expect(
      teams.map(team => [
        team.teamName,
        team.seasonYear,
        team.jersey,
        team.positions,
        team.current
      ])
    ).deep.equals([
      ['Badgers', 2026, '7', ['SS', '2B'], true],
      ['Spare', 2026, null, [], true],
      // Played on now under the closed row, which is still the child.
      ['Comets', 2025, '12', ['C'], true],
      // Only a stat line: a team they played for, not one they are on.
      ['Survivor', null, null, [], false]
    ])
  })

  it('lists a team once in the season it belongs to, and not again without one', async function () {
    // The Owls are a child of the spring season without competing in it, as
    // a team made inside a season is; the child also played a friendly.
    const owls = makeId('team')
    await db!.insertInto('teams').values({ id: owls, name: 'Owls' }).execute()
    await db!
      .insertInto('season_team_parents')
      .values({ season_id: spring, team_id: owls })
      .execute()
    await db!
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: owls,
        user_id: child,
        role: 'member',
        is_player: true,
        jersey: '3',
        joined_at: new Date()
      })
      .execute()
    const owlsRows = async (): Promise<unknown[]> =>
      (await teamsOf(db!, [child]))
        .filter(team => team.teamId === owls)
        .map(team => [team.seasonName, team.jersey])
    expect(await owlsRows()).deep.equals([['Spring 2026', '3']])
    await line(owls, spring)
    await line(owls, null)
    expect(await owlsRows()).deep.equals([['Spring 2026', '3']])
  })

  it('answers nobody for no ids', async function () {
    expect(await teamsOf(db!, [])).deep.equals([])
  })
})

/**
 * A guardian reads their own child's whole page: every team the child has
 * played for, every figure and every highlight, the teams the child has left
 * included. A coach of one of those teams reads that team's part alone.
 *
 * On `guardianFixture`: Avery (201) plays for Demo Hawks and Demo Comets, and
 * Tim Raines (106) is his guardian with no membership of his own. A Comets
 * game with a video, a credited play and stat lines is added, then Avery
 * leaves the Comets.
 */
describe('a guardian reading their child’s page', function () {
  this.timeout(120000)

  let f: GuardianFixture
  const avery = 201
  const comets = 'guardian-game-3'

  before(async function () {
    f = await guardianFixture()
    const db = f.h.db
    const startAt = new Date('2026-09-27T18:00:00Z')
    await db
      .insertInto('games')
      .values({
        id: comets,
        home_team_id: f.secondTeam,
        away_team_id: f.standaloneTeam,
        season_id: f.playoffs,
        start_at: startAt,
        venue: 'Demo Field',
        status: 'final',
        home_score: 4,
        away_score: 1,
        timezone: 'UTC'
      })
      .execute()
    await db
      .insertInto('videos')
      .values({
        id: 'vid_guardian_3',
        game_id: comets,
        kind: 'program',
        title: 'Demo game video',
        storage: 'spaces',
        status: 'ready',
        start_at: startAt,
        duration_sec: 7200
      })
      .execute()
    const at = new Date(startAt.getTime() + 20 * 60_000).toISOString()
    await db
      .insertInto('events')
      .values({
        id: 'evt_guardian_comets_0',
        gameId: comets,
        startTime: at,
        battingTeamId: f.secondTeam,
        gumbo: {
          about: {
            atBatIndex: 0,
            inning: 1,
            halfInning: 'bottom',
            isScoringPlay: false,
            startTime: at
          },
          result: { eventType: 'double', awayScore: 0, homeScore: 0 },
          credits: [
            {
              eventType: 'double',
              label: 'Double: Avery S',
              teamId: f.secondTeam,
              creditUserId: avery,
              credit: { name: 'Avery S', role: 'batter', position: null }
            }
          ]
        }
      })
      .execute()
    await db
      .insertInto('event_players')
      .values(
        (
          [
            ['evt_guardian_comets_0', f.secondTeam],
            ['evt_guardian_guardian-game-1_0', f.teamA]
          ] as const
        ).map(([eventId, teamId]) => ({
          id: makeId('eventPlayer'),
          event_id: eventId,
          gumbo_id: avery,
          team_id: teamId,
          role: 'batter' as const,
          position: null
        }))
      )
      .execute()
    await db
      .insertInto('game_player_stats')
      .values(
        (
          [
            ['guardian-game-1', f.teamA],
            [comets, f.secondTeam]
          ] as const
        ).map(([gameId, teamId]) => ({
          id: makeId('gamePlayerStats'),
          game_id: gameId,
          gumbo_id: avery,
          team_id: teamId,
          pa: 4,
          ab: 4,
          h: 2
        }))
      )
      .execute()
    // Avery leaves the Comets.
    await db
      .deleteFrom('memberships')
      .where('user_id', '=', avery)
      .where('team_id', '=', f.secondTeam)
      .execute()
  })

  after(async function () {
    await f?.h.close()
  })

  const read = async (path: string, userId: number): Promise<any> => {
    const answer = await f.h.request('GET', path, undefined, userId)
    expect(answer.status, `${path} as ${userId}`).equals(200)
    return await answer.json()
  }

  it('lists every team the child has played for to the guardian, and the coach’s team to the coach', async function () {
    // One entry per team and season, so a team can be there twice.
    const teamIds = (answer: any): string[] =>
      [
        ...new Set(
          (answer.teams as Array<{ teamId: string }>).map(team => team.teamId)
        )
      ].sort()
    const mine = await read(`/players/${avery}`, f.people.guardian)
    expect(teamIds(mine)).deep.equals([f.teamA, f.secondTeam].sort())
    const coach = await read(`/players/${avery}`, f.people.teamCoach)
    expect(teamIds(coach)).deep.equals([f.teamA])
  })

  it('names the child’s number and positions on each team, and none on a team left', async function () {
    const mine = await read(`/players/${avery}`, f.people.guardian)
    expect(
      (
        mine.teams as Array<{
          teamId: string
          jersey: string | null
          positions: string[]
        }>
      ).map(team => [team.teamId, team.jersey, team.positions])
    ).deep.equals([
      // Played for, then left: the stat line stays, the membership is gone.
      [f.secondTeam, null, []],
      // The Hawks once, with the membership's number and positions.
      [f.teamA, '7', ['SS', '2B']]
    ])
  })

  it('says which of the child’s teams they play on now, and not one they left', async function () {
    const current = (answer: any): Array<[string, boolean]> =>
      (answer.teams as Array<{ teamId: string; current: boolean }>).map(
        team => [team.teamId, team.current]
      )
    expect(
      current(await read(`/players/${avery}`, f.people.guardian))
    ).deep.equals([
      [f.secondTeam, false],
      [f.teamA, true]
    ])
    expect(
      current(await read(`/players/${avery}`, f.people.teamCoach))
    ).deep.equals([[f.teamA, true]])
  })

  it('gives each team its logo, signed, and no logo to a team without one', async function () {
    const db = f.h.db
    await db
      .updateTable('teams')
      .set({ logo_path: `images/team/${f.teamA}/hawks` })
      .where('id', '=', f.teamA)
      .execute()
    try {
      const mine = await read(`/players/${avery}`, f.people.guardian)
      const logos = new Map(
        (mine.teams as Array<{ teamId: string; logoUrl: string | null }>).map(
          team => [team.teamId, team.logoUrl]
        )
      )
      expect(logos.get(f.teamA)).to.be.a('string')
      expect(logos.get(f.teamA)).includes(`images/team/${f.teamA}/hawks-96`)
      expect(logos.get(f.teamA)).includes('X-Amz-Signature=')
      expect(logos.get(f.secondTeam)).equals(null)
      for (const team of mine.teams)
        expect(team).not.to.have.property('logoPath')
    } finally {
      await db
        .updateTable('teams')
        .set({ logo_path: null })
        .where('id', '=', f.teamA)
        .execute()
    }
  })

  it('lists the Hawks once, in the season they are a child of, to the guardian and the coach', async function () {
    const seasons = (answer: any): Array<[string, string | null]> =>
      (answer.teams as Array<{ teamId: string; seasonId: string | null }>).map(
        team => [team.teamId, team.seasonId]
      )
    expect(
      seasons(await read(`/players/${avery}`, f.people.teamCoach))
    ).deep.equals([[f.teamA, f.seasonA]])
    expect(
      seasons(await read(`/players/${avery}`, f.people.guardian))
    ).deep.equals([
      [f.secondTeam, f.playoffs],
      [f.teamA, f.seasonA]
    ])
  })

  it('adds up every figure for the guardian, and the coach’s team for the coach', async function () {
    const mine = await read(`/players/${avery}/stats`, f.people.guardian)
    expect(mine.games).equals(2)
    expect(
      (mine.options.teams as Array<{ teamId: string }>).map(team => team.teamId)
    ).deep.equals([f.secondTeam, f.teamA])
    const coach = await read(`/players/${avery}/stats`, f.people.teamCoach)
    expect(coach.games).equals(1)
    const plays = await read(`/players/${avery}/plays`, f.people.guardian)
    expect(
      (plays as Array<{ gameId: string }>).map(play => play.gameId).sort()
    ).deep.equals(['guardian-game-1', comets])
    const coachPlays = await read(`/players/${avery}/plays`, f.people.teamCoach)
    expect(
      (coachPlays as Array<{ gameId: string }>).map(play => play.gameId)
    ).deep.equals(['guardian-game-1'])
  })

  it('shows the guardian the highlights of a team the child left, and the coach none of them', async function () {
    const games = (answer: any): string[] => [
      ...new Set(
        (answer.highlights as Array<{ gameId: string }>).map(
          highlight => highlight.gameId
        )
      )
    ]
    expect(
      games(await read(`/players/${avery}/highlights`, f.people.guardian))
    ).deep.equals([comets, 'guardian-game-1', 'guardian-game-2'])
    expect(
      games(await read(`/players/${avery}/highlights`, f.people.teamCoach))
    ).deep.equals(['guardian-game-1', 'guardian-game-2'])
  })

  it('still opens the child’s page for the guardian once the child is on no team', async function () {
    await f.h.db
      .deleteFrom('memberships')
      .where('user_id', '=', avery)
      .execute()
    const mine = await read(`/players/${avery}`, f.people.guardian)
    expect(mine.userId).equals(avery)
    // Somebody who never saw a team of his sees nothing.
    const stranger = await f.h.request(
      'GET',
      `/players/${avery}`,
      undefined,
      f.people.oneTeam
    )
    expect(stranger.status).equals(404)
  })
})
