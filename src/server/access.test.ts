import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../common/ids'
import { mintUserId } from '../common/mintUserId'
import { type Role, ROLE_FLAGS, ROLES } from '../common/roles'
import { migrations } from '../migrate/migrations'
import { migrateUp } from '../migrate/runner'
import { testDatabaseUrl } from '../migrate/testDatabase'
import {
  type AdminScopes,
  adminScopes,
  canCoach,
  canFilm,
  canKeepSongs,
  canManageTeam,
  canScore,
  canSeeGame,
  canSeeTeam,
  givenRolesOnTeam,
  hasRole,
  mayEditName,
  type RoleScopes,
  roleScopes,
  rolesOnTeam,
  type VisibleScopes
} from './access'
import { type Database, makeDatabase } from './db/database'

const scopes = (
  teamIds: string[],
  seasonIds: string[],
  isAdmin = false
): VisibleScopes => ({
  teamIds: new Set(teamIds),
  seasonIds: new Set(seasonIds),
  isAdmin
})

describe('access', function () {
  const game = {
    homeTeamId: 'tem_home',
    awayTeamId: 'tem_away',
    seasonId: 'sea_spring'
  }

  it("shows a team's own people that team's games", function () {
    expect(canSeeGame(scopes(['tem_home'], []), game)).equals(true)
    expect(canSeeGame(scopes(['tem_away'], []), game)).equals(true)
  })

  it('hides a game from someone in neither team', function () {
    expect(canSeeGame(scopes(['tem_other'], []), game)).equals(false)
  })

  it('shows a game when its season has been opened up', function () {
    expect(canSeeGame(scopes(['tem_other'], ['sea_spring']), game)).equals(true)
  })

  it('does not let an opened season cover a game outside it', function () {
    const other = { ...game, seasonId: 'sea_fall' }
    expect(canSeeGame(scopes(['tem_other'], ['sea_spring']), other)).equals(
      false
    )
  })

  it('never lets a seasonless game be opened up by a season', function () {
    const friendly = { ...game, seasonId: null }
    expect(canSeeGame(scopes(['tem_other'], ['sea_spring']), friendly)).equals(
      false
    )
  })

  it('shows a site administrator everything', function () {
    expect(canSeeGame(scopes([], [], true), game)).equals(true)
    expect(canSeeTeam(scopes([], [], true), 'tem_any')).equals(true)
  })

  it('keeps team visibility to actual members', function () {
    expect(canSeeTeam(scopes(['tem_home'], ['sea_spring']), 'tem_home')).equals(
      true
    )
    // Being able to watch a season's games does not make you a team member.
    expect(canSeeTeam(scopes([], ['sea_spring']), 'tem_home')).equals(false)
  })

  it('separates managing from watching', function () {
    const admin: AdminScopes = {
      leagueIds: new Set(),
      seasonIds: new Set(),
      teamIds: new Set(['tem_home']),
      isAdmin: false
    }
    expect(canManageTeam(admin, 'tem_home')).equals(true)
    expect(canManageTeam(admin, 'tem_away')).equals(false)
  })
})

/**
 * The role flags against a real tree: two leagues, three seasons, four teams.
 *
 * `lea_a` holds `sea_a1` (teams `tem_a1`, `tem_a2`) and `sea_a2` (`tem_a3`);
 * `lea_b` holds `sea_b1` (`tem_b1`). Every flag is set at each height by a
 * person of its own, so each case reads one person's scopes and nothing else
 * can leak into it.
 */
describe('role flags', function () {
  this.timeout(60000)

  const scratchName = `teamstation_access_${Date.now()}`
  const scratchUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${scratchName}`)
  let admin: Pool | undefined
  let db: Kysely<Database>

  const taken = new Set<number>()
  const person = (): { userId: number; legacyId: string } => {
    const made = mintUserId(id => taken.has(id))
    taken.add(made.userId)
    return made
  }
  const people = new Map<string, { userId: number; legacyId: string }>()
  const idOf = (name: string): number => {
    const held = people.get(name)
    if (held == null) throw new Error(`nobody called ${name}`)
    return held.userId
  }

  const TEAMS = ['tem_a1', 'tem_a2', 'tem_a3', 'tem_b1']
  /** Where each height's row is set, and which teams it must reach. */
  const HEIGHTS = [
    { type: 'league', id: 'lea_a', teams: ['tem_a1', 'tem_a2', 'tem_a3'] },
    { type: 'season', id: 'sea_a1', teams: ['tem_a1', 'tem_a2'] },
    { type: 'team', id: 'tem_a2', teams: ['tem_a2'] }
  ] as const

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)

    await db
      .insertInto('leagues')
      .values([
        { id: 'lea_a', name: 'League A' },
        { id: 'lea_b', name: 'League B' }
      ])
      .execute()
    await db
      .insertInto('seasons')
      .values([
        { id: 'sea_a1', name: 'A1', year: 2026, league_id: 'lea_a' },
        { id: 'sea_a2', name: 'A2', year: 2026, league_id: 'lea_a' },
        { id: 'sea_b1', name: 'B1', year: 2026, league_id: 'lea_b' }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values(
        TEAMS.map(id => ({
          id,
          name: id,
          league_id: id.startsWith('tem_a') ? 'lea_a' : 'lea_b'
        }))
      )
      .execute()
    await db
      .insertInto('season_teams')
      .values([
        { season_id: 'sea_a1', team_id: 'tem_a1' },
        { season_id: 'sea_a1', team_id: 'tem_a2' },
        { season_id: 'sea_a2', team_id: 'tem_a3' },
        { season_id: 'sea_b1', team_id: 'tem_b1' }
      ])
      .execute()
    await db
      .insertInto('season_team_parents')
      .values([
        { season_id: 'sea_a1', team_id: 'tem_a1' },
        { season_id: 'sea_a1', team_id: 'tem_a2' },
        { season_id: 'sea_a2', team_id: 'tem_a3' },
        { season_id: 'sea_b1', team_id: 'tem_b1' }
      ])
      .execute()

    const rows: Array<{
      name: string
      roles: Array<{
        type: 'league' | 'season' | 'team'
        id: string
        role: Role
      }>
    }> = [
      ...ROLE_FLAGS.flatMap(flag =>
        HEIGHTS.map(height => ({
          name: `${flag}@${height.id}`,
          roles: [{ type: height.type, id: height.id, role: flag }]
        }))
      ),
      ...HEIGHTS.map(height => ({
        name: `admin@${height.id}`,
        roles: [{ type: height.type, id: height.id, role: 'admin' as const }]
      })),
      {
        name: 'union',
        roles: [
          { type: 'league', id: 'lea_b', role: 'coach' },
          { type: 'season', id: 'sea_a2', role: 'coach' },
          { type: 'team', id: 'tem_a1', role: 'coach' },
          { type: 'team', id: 'tem_a1', role: 'songkeeper' }
        ]
      },
      {
        name: 'disabled',
        roles: [{ type: 'team', id: 'tem_a2', role: 'coach' }]
      },
      { name: 'manager', roles: [] },
      { name: 'owner', roles: [] },
      { name: 'siteAdmin', roles: [] },
      { name: 'player', roles: [] },
      { name: 'guardian', roles: [] },
      { name: 'member', roles: [] }
    ]
    for (const row of rows) {
      const made = person()
      people.set(row.name, made)
      await db
        .insertInto('users')
        .values({
          id: made.userId,
          legacyId: made.legacyId,
          display_name: row.name,
          is_admin: row.name === 'siteAdmin',
          disabled_at: row.name === 'disabled' ? new Date() : null
        })
        .execute()
      for (const role of row.roles) {
        await db
          .insertInto('scope_roles')
          .values({
            id: makeId('scopeRole'),
            user_id: made.userId,
            scope_type: role.type,
            scope_id: role.id,
            role: role.role
          })
          .execute()
      }
    }
    await db
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          user_id: idOf('manager'),
          team_id: 'tem_a1',
          role: 'manager'
        },
        {
          id: makeId('membership'),
          user_id: idOf('owner'),
          team_id: 'tem_b1',
          role: 'owner'
        },
        {
          id: makeId('membership'),
          user_id: idOf('player'),
          team_id: 'tem_a2',
          is_player: true
        },
        {
          id: makeId('membership'),
          user_id: idOf('member'),
          team_id: 'tem_a2'
        }
      ])
      .execute()
    await db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: idOf('guardian'),
        related_user_id: idOf('player'),
        kind: 'guardian'
      })
      .execute()
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  const scopesOf = async (name: string): Promise<RoleScopes> =>
    await roleScopes(db, idOf(name), name === 'siteAdmin')

  /** The teams on which `name` holds `role`, of the four there are. */
  const teamsHolding = async (name: string, role: Role): Promise<string[]> => {
    const scopes = await scopesOf(name)
    return TEAMS.filter(teamId => hasRole(scopes, role, teamId))
  }

  it('carries each flag down from a league, a season or a team, and never across', async function () {
    for (const flag of ROLE_FLAGS) {
      for (const height of HEIGHTS) {
        expect(
          await teamsHolding(`${flag}@${height.id}`, flag),
          `${flag}@${height.id}`
        ).deep.equals([...height.teams])
      }
    }
    const league = await scopesOf('scorekeeper@lea_a')
    expect([...league.scorekeeper.seasonIds].sort()).deep.equals([
      'sea_a1',
      'sea_a2'
    ])
    expect([...league.scorekeeper.leagueIds]).deep.equals(['lea_a'])
  })

  it('adds up flags set at several heights', async function () {
    expect(await teamsHolding('union', 'coach')).deep.equals([
      'tem_a1',
      'tem_a3',
      'tem_b1'
    ])
    expect(await teamsHolding('union', 'songkeeper')).deep.equals(['tem_a1'])
  })

  it('grants each flag itself, an assistant what a coach may do, and a scorekeeper songkeeper', async function () {
    const implied: Partial<Record<Role, Role[]>> = {
      scorekeeper: ['scorekeeper', 'songkeeper']
    }
    for (const flag of ROLE_FLAGS) {
      const scopes = await scopesOf(`${flag}@tem_a2`)
      const held = implied[flag] ?? [flag]
      expect(rolesOnTeam(scopes, 'tem_a2'), flag).deep.equals(held)
      for (const other of ROLE_FLAGS.filter(item => !held.includes(item))) {
        expect(hasRole(scopes, other, 'tem_a2'), `${flag} ${other}`).equals(
          false
        )
      }
    }
    const scorer = await scopesOf('scorekeeper@tem_a2')
    expect(canScore(scorer, 'tem_a2')).equals(true)
    expect(canKeepSongs(scorer, 'tem_a2')).equals(true)
    expect(canCoach(scorer, 'tem_a2')).equals(false)
    expect(canFilm(scorer, 'tem_a2')).equals(false)
    // Carried down like the scorekeeper flag itself, and never across.
    const leagueScorer = await scopesOf('scorekeeper@lea_a')
    expect(TEAMS.filter(id => canKeepSongs(leagueScorer, id))).deep.equals([
      'tem_a1',
      'tem_a2',
      'tem_a3'
    ])
    // A songkeeper does not score.
    const songs = await scopesOf('songkeeper@tem_a2')
    expect(canKeepSongs(songs, 'tem_a2')).equals(true)
    expect(canScore(songs, 'tem_a2')).equals(false)
    // An assistant coaches as a coach does, and keeps its own name.
    for (const height of HEIGHTS) {
      const assistant = await scopesOf(`assistant@${height.id}`)
      const coach = await scopesOf(`coach@${height.id}`)
      for (const teamId of TEAMS) {
        expect(canCoach(assistant, teamId), `${height.id} ${teamId}`).equals(
          canCoach(coach, teamId)
        )
      }
      expect(rolesOnTeam(assistant, height.teams[0])).deep.equals(['assistant'])
    }
    const assistant = await scopesOf('assistant@tem_a2')
    expect(canScore(assistant, 'tem_a2')).equals(false)
    expect(canKeepSongs(assistant, 'tem_a2')).equals(false)
  })

  it('lists the roles each person was given on a team, implying nothing', async function () {
    const named = (given: Map<number, Role[]>): Record<string, Role[]> =>
      Object.fromEntries(
        [...people]
          .filter(([, made]) => given.has(made.userId))
          .map(([name, made]) => [name, given.get(made.userId) ?? []])
      )
    // Everything set on the team, its season and its league; no implied
    // songkeeper for the scorekeeper, no flags for the admin.
    expect(named(await givenRolesOnTeam(db, 'tem_a2'))).deep.equals(
      Object.fromEntries([
        ...ROLE_FLAGS.flatMap(flag =>
          HEIGHTS.map(height => [`${flag}@${height.id}`, [flag]])
        ),
        ...HEIGHTS.map(height => [`admin@${height.id}`, ['admin']])
      ])
    )
    // A manager is the team's admin, beside roles set at several heights.
    const a1 = named(await givenRolesOnTeam(db, 'tem_a1'))
    expect(a1.manager).deep.equals(['admin'])
    expect(a1.union).deep.equals(['coach', 'songkeeper'])
    expect(a1['coach@tem_a2']).equals(undefined)
    const b1 = named(await givenRolesOnTeam(db, 'tem_b1'))
    expect(b1).deep.equals({ union: ['coach'], owner: ['admin'] })
    expect((await givenRolesOnTeam(db, 'tem_none')).size).equals(0)
  })

  it('gives every flag to an admin of a scope, a team owner or manager, and a site admin', async function () {
    for (const height of HEIGHTS) {
      const scopes = await scopesOf(`admin@${height.id}`)
      for (const teamId of height.teams) {
        expect(rolesOnTeam(scopes, teamId), height.id).deep.equals([...ROLES])
      }
    }
    const manager = await scopesOf('manager')
    expect(rolesOnTeam(manager, 'tem_a1')).deep.equals([...ROLES])
    expect(rolesOnTeam(manager, 'tem_a2')).deep.equals([])
    const owner = await scopesOf('owner')
    expect(rolesOnTeam(owner, 'tem_b1')).deep.equals([...ROLES])
    const site = await scopesOf('siteAdmin')
    for (const teamId of TEAMS) {
      expect(rolesOnTeam(site, teamId)).deep.equals([...ROLES])
    }
  })

  it('never makes a flag an admin, and keeps what adminScopes gave admins', async function () {
    for (const flag of ROLE_FLAGS) {
      const scopes = await adminScopes(db, idOf(`${flag}@lea_a`), false)
      expect(
        scopes.leagueIds.size + scopes.seasonIds.size + scopes.teamIds.size
      ).equals(0)
    }
    const league = await adminScopes(db, idOf('admin@lea_a'), false)
    expect({
      leagueIds: [...league.leagueIds],
      seasonIds: [...league.seasonIds].sort(),
      teamIds: [...league.teamIds].sort(),
      isAdmin: league.isAdmin
    }).deep.equals({
      leagueIds: ['lea_a'],
      seasonIds: ['sea_a1', 'sea_a2'],
      teamIds: ['tem_a1', 'tem_a2', 'tem_a3'],
      isAdmin: false
    })
    const manager = await adminScopes(db, idOf('manager'), false)
    expect([...manager.teamIds]).deep.equals(['tem_a1'])
    const site = await adminScopes(db, idOf('siteAdmin'), true)
    expect(site.isAdmin).equals(true)
  })

  it('gives the name to the player, a guardian, a site admin and the roster managers of their team', async function () {
    const player = idOf('player')
    const about = { isAdmin: false }
    // An admin, coach, assistant or scorekeeper, set on the team or carried
    // down from its season or league: a scorekeeper may keep the roster alone.
    for (const role of ['admin', 'coach', 'assistant', 'scorekeeper']) {
      for (const height of HEIGHTS) {
        const name = `${role}@${height.id}`
        expect(await mayEditName(db, idOf(name), player, about), name).equals(
          true
        )
      }
    }
    // The other flags hold a role on the team but never read the name.
    for (const role of ['songkeeper', 'videographer']) {
      for (const height of HEIGHTS) {
        const name = `${role}@${height.id}`
        expect(await mayEditName(db, idOf(name), player, about), name).equals(
          false
        )
      }
    }
    // Staff of other teams, a member who is not staff, and a disabled coach.
    for (const name of ['manager', 'owner', 'union', 'member', 'disabled']) {
      expect(await mayEditName(db, idOf(name), player, about), name).equals(
        false
      )
    }
    expect(await mayEditName(db, idOf('guardian'), player, about)).equals(true)
    expect(await mayEditName(db, player, player, about)).equals(true)
    expect(
      await mayEditName(db, idOf('member'), player, { isAdmin: true })
    ).equals(true)
  })
})
