import { expect } from 'chai'
import type { Insertable, Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../common/ids'
import { type Role, ROLE_FLAGS, ROLES } from '../common/roles'
import { userIdOfGumbo } from '../common/userId'
import { migrations } from '../migrate/migrations'
import { migrateUp } from '../migrate/runner'
import { testDatabaseUrl } from '../migrate/testDatabase'
import { mintUserId } from '../test/historicalUserIds'
import { insertFixtureUsers } from '../test/insertFixtureUsers'
import { statsDatabase } from '../test/statsDatabase'
import {
  adminScopes,
  canCoach,
  canFilm,
  canKeepSongs,
  canScore,
  canSeeTeam,
  givenRolesOnTeam,
  guardedPlayers,
  guardiansOf,
  guardsPerson,
  guardsPlayer,
  hasRole,
  isHeadCoach,
  mayEditName,
  mayManagePlayer,
  mayViewFullName,
  mayViewFullNames,
  type RoleScopes,
  roleScopes,
  rolesOnTeam,
  teamsPlayedOnNow,
  type VisibleScopes,
  visibleScopes
} from './access'
import { onePerson } from './admin/people'
import {
  type Database,
  makeDatabase,
  type MembershipsTable,
  type ScopeRolesTable
} from './db/database'

const scopes = (
  teamIds: string[],
  seasonIds: string[],
  isAdmin = false
): VisibleScopes => ({
  teamIds: new Set(teamIds),
  seasonIds: new Set(seasonIds),
  isAdmin
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
        {
          starts_on: `2026-03-01`,
          ends_on: `2026-05-31`,
          id: 'sea_a1',
          name: 'A1',
          year: 2026,
          league_id: 'lea_a'
        },
        {
          starts_on: `2026-03-01`,
          ends_on: `2026-05-31`,
          id: 'sea_a2',
          name: 'A2',
          year: 2026,
          league_id: 'lea_a'
        },
        {
          starts_on: `2026-03-01`,
          ends_on: `2026-05-31`,
          id: 'sea_b1',
          name: 'B1',
          year: 2026,
          league_id: 'lea_b'
        }
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
      { name: 'member', roles: [] },
      { name: 'seasonMember', roles: [] },
      { name: 'leagueMember', roles: [] },
      { name: 'otherSeasonMember', roles: [] },
      { name: 'survivor', roles: [] },
      { name: 'closedMember', roles: [] }
    ]
    for (const row of rows) {
      const made = person()
      people.set(row.name, made)
      await insertFixtureUsers(db, {
        id: userIdOfGumbo(made.userId),
        legacyId: made.legacyId,
        display_name: row.name,
        is_admin: row.name === 'siteAdmin',
        disabled_at: row.name === 'disabled' ? new Date() : null
      })
      for (const role of row.roles) {
        await db
          .insertInto('scope_roles')
          .values({
            id: makeId('scopeRole'),
            user_id: userIdOfGumbo(made.userId),
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
          user_id: userIdOfGumbo(idOf('manager')),
          team_id: 'tem_a1',
          role: 'manager'
        },
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(idOf('owner')),
          team_id: 'tem_b1',
          role: 'owner'
        },
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(idOf('player')),
          team_id: 'tem_a2',
          is_player: true
        },
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(idOf('member')),
          team_id: 'tem_a2'
        }
      ])
      .execute()
    await db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: userIdOfGumbo(idOf('guardian')),
        related_user_id: userIdOfGumbo(idOf('player')),
        kind: 'guardian'
      })
      .execute()
    // Members of a level above the team: of a season, of a league, of the
    // other league's season, and of a season through a row since closed.
    await db
      .insertInto('season_members')
      .values([
        {
          id: makeId('seasonMember'),
          user_id: userIdOfGumbo(idOf('seasonMember')),
          season_id: 'sea_a1'
        },
        {
          id: makeId('seasonMember'),
          user_id: userIdOfGumbo(idOf('otherSeasonMember')),
          season_id: 'sea_b1'
        },
        {
          id: makeId('seasonMember'),
          user_id: userIdOfGumbo(idOf('closedMember')),
          season_id: 'sea_a2'
        }
      ])
      .execute()
    await db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: userIdOfGumbo(idOf('leagueMember')),
        league_id: 'lea_a'
      })
      .execute()
    await db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(idOf('survivor')) })
      .where('id', '=', userIdOfGumbo(idOf('closedMember')))
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
    await roleScopes(db, userIdOfGumbo(idOf(name)), name === 'siteAdmin')

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

  // U9: the head coach saves the team's lineup in a game; an assistant does not.
  it('makes a coach, an admin of the team and a site admin its head coach, and never an assistant', async function () {
    for (const height of HEIGHTS) {
      const coach = await scopesOf(`coach@${height.id}`)
      expect(
        TEAMS.filter(teamId => isHeadCoach(coach, teamId)),
        height.id
      ).deep.equals([...height.teams])
      const assistant = await scopesOf(`assistant@${height.id}`)
      expect(
        TEAMS.filter(teamId => isHeadCoach(assistant, teamId)),
        height.id
      ).deep.equals([])
      const admin = await scopesOf(`admin@${height.id}`)
      expect(
        TEAMS.filter(teamId => isHeadCoach(admin, teamId)),
        height.id
      ).deep.equals([...height.teams])
    }
    expect(isHeadCoach(await scopesOf('manager'), 'tem_a1')).equals(true)
    expect(isHeadCoach(await scopesOf('manager'), 'tem_a2')).equals(false)
    const site = await scopesOf('siteAdmin')
    expect(TEAMS.every(teamId => isHeadCoach(site, teamId))).equals(true)
    expect(isHeadCoach(await scopesOf('scorekeeper@tem_a2'), 'tem_a2')).equals(
      false
    )
  })

  it('lists the roles each person was given on a team, implying nothing', async function () {
    const named = (given: Map<string, Role[]>): Record<string, Role[]> =>
      Object.fromEntries(
        [...people]
          .filter(([, made]) => given.has(userIdOfGumbo(made.userId)))
          .map(([name, made]) => [
            name,
            given.get(userIdOfGumbo(made.userId)) ?? []
          ])
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
      const scopes = await adminScopes(
        db,
        userIdOfGumbo(idOf(`${flag}@lea_a`)),
        false
      )
      expect(
        scopes.leagueIds.size + scopes.seasonIds.size + scopes.teamIds.size
      ).equals(0)
    }
    const league = await adminScopes(
      db,
      userIdOfGumbo(idOf('admin@lea_a')),
      false
    )
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
    const manager = await adminScopes(db, userIdOfGumbo(idOf('manager')), false)
    expect([...manager.teamIds]).deep.equals(['tem_a1'])
    const site = await adminScopes(db, userIdOfGumbo(idOf('siteAdmin')), true)
    expect(site.isAdmin).equals(true)
  })

  it('makes a season or league member a member of every team below it', async function () {
    // A team of League A in none of its seasons, there only by its league.
    await db
      .insertInto('teams')
      .values({ id: 'tem_a9', name: 'tem_a9', league_id: 'lea_a' })
      .execute()
    const reach = async (
      name: string
    ): Promise<{ teams: string[]; seasons: string[] }> => {
      const scopes = await visibleScopes(db, userIdOfGumbo(idOf(name)), false)
      return {
        teams: [...scopes.teamIds].sort(),
        seasons: [...scopes.seasonIds].sort()
      }
    }
    try {
      expect(await reach('seasonMember')).deep.equals({
        teams: ['tem_a1', 'tem_a2'],
        seasons: ['sea_a1']
      })
      expect(await reach('leagueMember')).deep.equals({
        teams: ['tem_a1', 'tem_a2', 'tem_a3', 'tem_a9'],
        seasons: ['sea_a1', 'sea_a2']
      })
      // A member of another league's season reaches none of League A's
      // teams, and a team member no team beside their own.
      expect(await reach('otherSeasonMember')).deep.equals({
        teams: ['tem_b1'],
        seasons: ['sea_b1']
      })
      expect(await reach('member')).deep.equals({
        teams: ['tem_a2'],
        seasons: []
      })
      const scopes = await visibleScopes(
        db,
        userIdOfGumbo(idOf('seasonMember')),
        false
      )
      expect(canSeeTeam(scopes, 'tem_a2')).equals(true)
      expect(canSeeTeam(scopes, 'tem_a3')).equals(false)
      // A season membership written under a row since merged is the
      // survivor's; the closed row itself reaches nothing.
      expect(await reach('survivor')).deep.equals({
        teams: ['tem_a3'],
        seasons: ['sea_a2']
      })
      expect(await reach('closedMember')).deep.equals({
        teams: [],
        seasons: []
      })
      // Membership is not a role, and no name comes with it.
      expect(rolesOnTeam(await scopesOf('leagueMember'), 'tem_a1')).deep.equals(
        []
      )
      expect(
        await mayEditName(
          db,
          userIdOfGumbo(idOf('seasonMember')),
          userIdOfGumbo(idOf('player')),
          {
            isAdmin: false
          }
        )
      ).equals(false)
    } finally {
      await db.deleteFrom('teams').where('id', '=', 'tem_a9').execute()
    }
  })

  it('gives the name to the player, a guardian, a site admin and the roster managers of their team', async function () {
    const player = idOf('player')
    const about = { isAdmin: false }
    // An admin, coach, assistant or scorekeeper, set on the team or carried
    // down from its season or league: a scorekeeper may keep the roster alone.
    for (const role of ['admin', 'coach', 'assistant', 'scorekeeper']) {
      for (const height of HEIGHTS) {
        const name = `${role}@${height.id}`
        expect(
          await mayEditName(
            db,
            userIdOfGumbo(idOf(name)),
            userIdOfGumbo(player),
            about
          ),
          name
        ).equals(true)
      }
    }
    // The other flags hold a role on the team but never read the name.
    for (const role of ['songkeeper', 'videographer']) {
      for (const height of HEIGHTS) {
        const name = `${role}@${height.id}`
        expect(
          await mayEditName(
            db,
            userIdOfGumbo(idOf(name)),
            userIdOfGumbo(player),
            about
          ),
          name
        ).equals(false)
      }
    }
    // Staff of other teams, a member who is not staff, and a disabled coach.
    for (const name of ['manager', 'owner', 'union', 'member', 'disabled']) {
      expect(
        await mayEditName(
          db,
          userIdOfGumbo(idOf(name)),
          userIdOfGumbo(player),
          about
        ),
        name
      ).equals(false)
    }
    expect(
      await mayEditName(
        db,
        userIdOfGumbo(idOf('guardian')),
        userIdOfGumbo(player),
        about
      )
    ).equals(true)
    expect(
      await mayEditName(db, userIdOfGumbo(player), userIdOfGumbo(player), about)
    ).equals(true)
    expect(
      await mayEditName(
        db,
        userIdOfGumbo(idOf('member')),
        userIdOfGumbo(player),
        { isAdmin: true }
      )
    ).equals(true)
  })
})

/**
 * A guardian's reach, against a real tree of five teams.
 *
 * The child has two rows: `child` is open, and `childOld` was merged into it.
 * They play for `tem_one` (as `child`), `tem_two` (as `childOld`) and
 * `tem_both`, where the guardian is a member too; they are on `tem_watch`
 * without playing, and play for `tem_gone`, which was merged into `tem_one`.
 * The guardian has two rows too, and the link hangs from the closed ones on
 * both sides, and a stray `family` link joins the guardian's own two rows.
 * An aunt is `family` of the open row; a neighbour's link is `other`. A coach coaches `tem_two` and nothing else; a member plays for
 * nobody and belongs to `tem_one`.
 */
describe('guardians', function () {
  this.timeout(60000)

  const scratchName = `teamstation_guardians_${Date.now()}`
  const scratchUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${scratchName}`)
  let admin: Pool | undefined
  let db: Kysely<Database>

  const taken = new Set<number>()
  const ids = new Map<string, number>()
  const idOf = (name: string): number => {
    const held = ids.get(name)
    if (held == null) throw new Error(`nobody called ${name}`)
    return held
  }
  const NAMES = [
    'child',
    'childOld',
    'guardian',
    'guardianOld',
    'aunt',
    'neighbour',
    'coach',
    'member',
    'other',
    'siteAdmin'
  ]

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
      .insertInto('teams')
      .values(
        ['tem_one', 'tem_two', 'tem_both', 'tem_watch', 'tem_gone'].map(id => ({
          id,
          name: id
        }))
      )
      .execute()
    await db
      .updateTable('teams')
      .set({ merged_into: 'tem_one' })
      .where('id', '=', 'tem_gone')
      .execute()
    for (const name of NAMES) {
      const made = mintUserId(id => taken.has(id))
      taken.add(made.userId)
      ids.set(name, made.userId)
      await insertFixtureUsers(db, {
        id: userIdOfGumbo(made.userId),
        legacyId: made.legacyId,
        display_name: name,
        is_admin: name === 'siteAdmin'
      })
    }
    await db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(idOf('child')) })
      .where('id', '=', userIdOfGumbo(idOf('childOld')))
      .execute()
    await db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(idOf('guardian')) })
      .where('id', '=', userIdOfGumbo(idOf('guardianOld')))
      .execute()
    const membership = (
      name: string,
      teamId: string,
      isPlayer: boolean
    ): {
      id: string
      user_id: string
      team_id: string
      is_player: boolean
    } => ({
      id: makeId('membership'),
      user_id: userIdOfGumbo(idOf(name)),
      team_id: teamId,
      is_player: isPlayer
    })
    await db
      .insertInto('memberships')
      .values([
        membership('child', 'tem_one', true),
        membership('childOld', 'tem_two', true),
        membership('child', 'tem_both', true),
        membership('child', 'tem_watch', false),
        membership('child', 'tem_gone', true),
        membership('guardian', 'tem_both', false),
        membership('member', 'tem_one', false)
      ])
      .execute()
    await db
      .insertInto('user_links')
      .values(
        (
          [
            ['guardianOld', 'childOld', 'guardian'],
            ['aunt', 'child', 'family'],
            ['neighbour', 'child', 'other'],
            // A link to a row since closed into the guardian themself.
            ['guardian', 'guardianOld', 'family']
          ] as const
        ).map(([from, to, kind]) => ({
          id: makeId('userLink'),
          user_id: userIdOfGumbo(idOf(from)),
          related_user_id: userIdOfGumbo(idOf(to)),
          kind
        }))
      )
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(idOf('coach')),
        scope_type: 'team',
        scope_id: 'tem_two',
        role: 'coach'
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

  const teamsOf = async (name: string): Promise<string[]> =>
    [
      ...(await visibleScopes(db, userIdOfGumbo(idOf(name)), false)).teamIds
    ].sort()

  it('names the child by the row they sign in as, across merged rows on both sides', async function () {
    expect(
      await guardedPlayers(db, userIdOfGumbo(idOf('guardian')))
    ).deep.equals([idOf('child')].map(userIdOfGumbo))
    // A `family` link counts; an `other` one does not.
    expect(await guardedPlayers(db, userIdOfGumbo(idOf('aunt')))).deep.equals(
      [idOf('child')].map(userIdOfGumbo)
    )
    for (const name of ['neighbour', 'coach', 'member', 'child']) {
      expect(
        await guardedPlayers(db, userIdOfGumbo(idOf(name))),
        name
      ).deep.equals([])
    }
    expect(
      await guardsPlayer(
        db,
        userIdOfGumbo(idOf('guardian')),
        userIdOfGumbo(idOf('childOld'))
      )
    ).equals(true)
    expect(
      await guardsPlayer(
        db,
        userIdOfGumbo(idOf('neighbour')),
        userIdOfGumbo(idOf('child'))
      )
    ).equals(false)
  })

  it('reads the guarded people once with the scopes, and on their own without them', async function () {
    const child = await onePerson(db, userIdOfGumbo(idOf('childOld')))
    const guardian = await visibleScopes(
      db,
      userIdOfGumbo(idOf('guardian')),
      false
    )
    expect([...guardian.guardedIds!]).deep.equals(
      [idOf('child')].map(userIdOfGumbo)
    )
    expect(
      await guardsPerson(db, guardian, userIdOfGumbo(idOf('guardian')), child)
    ).equals(true)
    const neighbour = await visibleScopes(
      db,
      userIdOfGumbo(idOf('neighbour')),
      false
    )
    expect(
      await guardsPerson(db, neighbour, userIdOfGumbo(idOf('neighbour')), child)
    ).equals(false)
    // A closed row asks as nobody, and guards nobody.
    expect([
      ...(await visibleScopes(db, userIdOfGumbo(idOf('guardianOld')), false))
        .guardedIds!
    ]).deep.equals([])
    // Scopes made by hand carry none, so the links are read instead.
    for (const [name, guards] of [
      ['aunt', true],
      ['neighbour', false]
    ] as const)
      expect(
        await guardsPerson(
          db,
          scopes([], []),
          userIdOfGumbo(idOf(name)),
          child
        ),
        name
      ).equals(guards)
  })

  it('gives a guardian every team the child plays on now, beside their own', async function () {
    // Not the team the child only watches, nor one merged away.
    expect(await teamsOf('guardian')).deep.equals([
      'tem_both',
      'tem_one',
      'tem_two'
    ])
    expect(await teamsOf('aunt')).deep.equals([
      'tem_both',
      'tem_one',
      'tem_two'
    ])
    // Nobody else's scopes change: the neighbour, a member, a coach.
    expect(await teamsOf('neighbour')).deep.equals([])
    expect(await teamsOf('member')).deep.equals(['tem_one'])
    expect(await teamsOf('coach')).deep.equals(['tem_two'])
    // A closed row of the guardian's is nobody's scopes.
    expect(await teamsOf('guardianOld')).deep.equals([])
  })

  it('reads the teams any of a player’s rows plays on now, each once', async function () {
    const child = await onePerson(db, userIdOfGumbo(idOf('child')))
    // Not the team the child only watches, nor one merged away; a team two
    // rows play on once.
    expect((await teamsPlayedOnNow(db, child.userIds)).sort()).deep.equals([
      'tem_both',
      'tem_one',
      'tem_two'
    ])
    expect(
      await teamsPlayedOnNow(db, [userIdOfGumbo(idOf('childOld'))])
    ).deep.equals(['tem_two'])
    expect(
      await teamsPlayedOnNow(db, [userIdOfGumbo(idOf('member'))])
    ).deep.equals([])
    expect(await teamsPlayedOnNow(db, [])).deep.equals([])
  })

  it('orders canonical guardian IDs by case-sensitive Base58 digits', async function () {
    const [first, second, child] = [32, 33, 34].map(userIdOfGumbo)
    await insertFixtureUsers(db, [
      { id: first, display_name: 'Babe Ruth' },
      { id: second, display_name: 'Hank Aaron' },
      { id: child, display_name: 'Mookie Betts' }
    ])
    await db
      .insertInto('user_links')
      .values(
        [second, first].map(userId => ({
          id: makeId('userLink'),
          user_id: userId,
          related_user_id: child,
          kind: 'guardian'
        }))
      )
      .execute()
    expect(await guardiansOf(db, [child])).deep.equals([first, second])
  })

  it('reads the guardians of several players at once as it reads each alone', async function () {
    // The child twice, by both rows; a guardian's closed row, whose only
    // link is from the guardian themself; and a member nobody guards.
    const players = ['childOld', 'member', 'guardianOld', 'child'].map(idOf)
    const each = new Set<string>()
    for (const player of players)
      for (const guardian of await guardiansOf(db, [userIdOfGumbo(player)]))
        each.add(guardian)
    const together = await guardiansOf(db, players.map(userIdOfGumbo))
    expect(together).deep.equals([...each].sort())
    // By the row each signs in as: the guardian linked from a closed row.
    expect(together).deep.equals(
      [idOf('guardian'), idOf('aunt')].map(userIdOfGumbo).sort()
    )
    expect(await guardiansOf(db, [userIdOfGumbo(idOf('member'))])).deep.equals(
      []
    )
    expect(await guardiansOf(db, [])).deep.equals([])
  })

  it('takes a team away when the child leaves it, unless the guardian belongs to it', async function () {
    await db
      .deleteFrom('memberships')
      .where('user_id', 'in', [
        userIdOfGumbo(idOf('child')),
        userIdOfGumbo(idOf('childOld'))
      ])
      .where('team_id', 'in', ['tem_two', 'tem_both'])
      .execute()
    try {
      expect(await teamsOf('guardian')).deep.equals(['tem_both', 'tem_one'])
      expect(await teamsOf('aunt')).deep.equals(['tem_one'])
    } finally {
      await db
        .insertInto('memberships')
        .values([
          {
            id: makeId('membership'),
            user_id: userIdOfGumbo(idOf('childOld')),
            team_id: 'tem_two',
            is_player: true
          },
          {
            id: makeId('membership'),
            user_id: userIdOfGumbo(idOf('child')),
            team_id: 'tem_both',
            is_player: true
          }
        ])
        .execute()
    }
  })

  it('lets a guardian, a coach of one of the child’s teams or a site admin manage the child', async function () {
    const as = (name: string): { userId: string; isAdmin: boolean } => ({
      userId: userIdOfGumbo(idOf(name)),
      isAdmin: name === 'siteAdmin'
    })
    const child = idOf('child')
    for (const teamId of ['tem_one', 'tem_two', null]) {
      for (const name of ['guardian', 'aunt', 'siteAdmin']) {
        expect(
          await mayManagePlayer(db, as(name), userIdOfGumbo(child), teamId),
          `${name} ${teamId}`
        ).equals(true)
      }
      for (const name of ['neighbour', 'member', 'child']) {
        expect(
          await mayManagePlayer(db, as(name), userIdOfGumbo(child), teamId),
          `${name} ${teamId}`
        ).equals(false)
      }
    }
    // A coach, on the team they coach, and away from any team for a child
    // who plays on it under a closed row; never on another team.
    expect(
      await mayManagePlayer(db, as('coach'), userIdOfGumbo(child), 'tem_two')
    ).equals(true)
    expect(
      await mayManagePlayer(db, as('coach'), userIdOfGumbo(child), null)
    ).equals(true)
    expect(
      await mayManagePlayer(db, as('coach'), userIdOfGumbo(child), 'tem_one')
    ).equals(false)
    expect(
      await mayManagePlayer(
        db,
        as('coach'),
        userIdOfGumbo(idOf('member')),
        null
      )
    ).equals(false)
    // Nobody's guardian manages somebody else.
    expect(
      await mayManagePlayer(
        db,
        as('guardian'),
        userIdOfGumbo(idOf('member')),
        null
      )
    ).equals(false)
  })
})

/**
 * Who reads a person's full name without being able to change it: the people
 * managers of a level whose people list holds them.
 *
 * League `lea_v` holds season `sea_v1` (teams `tem_v1` and `tem_v2`);
 * `tem_vold` was merged into `tem_v1`. League `lea_w` holds `sea_w1`
 * (`tem_w1`). Placeholder `tem_vx` is kept by `sea_v1`, `tem_vy` by
 * `tem_v1`, and `tem_vz` by `tem_vx`, a placeholder, so by nobody.
 */
describe('mayViewFullNames', function () {
  this.timeout(60000)
  const fixture = statsDatabase('mayview')
  const taken = new Set<number>()
  const ids = new Map<string, string>()
  const idOf = (name: string): string => {
    const id = ids.get(name)
    if (id == null) throw new Error(`nobody called ${name}`)
    return id
  }
  const about = { isAdmin: false }
  const sees = async (
    reader: string,
    person: string,
    isAdmin = false
  ): Promise<boolean> =>
    await mayViewFullName(fixture.db, idOf(reader), idOf(person), { isAdmin })

  const PEOPLE = [
    // Readers.
    'Tony La Russa',
    'Joe Torre',
    'Dusty Baker',
    'Bruce Bochy',
    'Terry Francona',
    'Bobby Cox',
    'Lou Piniella',
    'Jim Leyland',
    'Sparky Anderson',
    'Tommy Lasorda',
    'Walter Alston',
    'Cal Ripken',
    // People read.
    'Mookie Betts',
    'Aaron Judge',
    'Mike Trout',
    'Derek Jeter',
    'Ken Griffey',
    'Tony Gwynn',
    'Craig Biggio',
    'Barry Larkin',
    'Barry Bonds',
    'Edgar Martinez',
    'Chipper Jones',
    'Andruw Jones',
    'Greg Maddux',
    'Javy Lopez',
    'John Smoltz',
    'Tom Glavine',
    'Rickey Henderson',
    'Tim Raines'
  ]
  const DISABLED = new Set([
    'Sparky Anderson',
    'Rickey Henderson',
    'Tim Raines'
  ])

  before(async function () {
    const db = fixture.db
    for (const name of PEOPLE) {
      const one = mintUserId(id => taken.has(id))
      taken.add(one.userId)
      ids.set(name, userIdOfGumbo(one.userId))
      const [first, last] = name.split(' ')
      await insertFixtureUsers(db, {
        id: one.userId,
        legacyId: one.legacyId,
        display_name: name,
        first_name: first,
        last_name: last,
        login_enabled: true,
        disabled_at: DISABLED.has(name) ? new Date() : null
      })
    }
    // Tommy Lasorda's row was closed into Walter Alston's.
    await db
      .updateTable('users')
      .set({ merged_into: idOf('Walter Alston') })
      .where('id', '=', idOf('Tommy Lasorda'))
      .execute()
    await db
      .insertInto('leagues')
      .values([
        { id: 'lea_v', name: 'League V' },
        { id: 'lea_w', name: 'League W' }
      ])
      .execute()
    await db
      .insertInto('seasons')
      .values([
        {
          starts_on: '2026-03-01',
          ends_on: '2026-05-31',
          id: 'sea_v1',
          name: 'V1',
          year: 2026,
          league_id: 'lea_v'
        },
        {
          starts_on: '2026-03-01',
          ends_on: '2026-05-31',
          id: 'sea_w1',
          name: 'W1',
          year: 2026,
          league_id: 'lea_w'
        }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: 'tem_v1', name: 'Demo Hawks', league_id: 'lea_v' },
        { id: 'tem_v2', name: 'Demo Owls', league_id: 'lea_v' },
        {
          id: 'tem_vold',
          name: 'Demo Old Hawks',
          league_id: 'lea_v',
          merged_into: 'tem_v1'
        },
        { id: 'tem_w1', name: 'Demo Wrens', league_id: 'lea_w' },
        {
          id: 'tem_vx',
          name: 'Demo Visitors',
          kind: 'external',
          custodian_type: 'season',
          custodian_id: 'sea_v1'
        },
        {
          id: 'tem_vy',
          name: 'Demo Guests',
          kind: 'external',
          custodian_type: 'team',
          custodian_id: 'tem_v1'
        },
        {
          id: 'tem_vz',
          name: 'Demo Strays',
          kind: 'external',
          custodian_type: 'team',
          custodian_id: 'tem_vx'
        }
      ])
      .execute()
    const links = [
      { season_id: 'sea_v1', team_id: 'tem_v1' },
      { season_id: 'sea_v1', team_id: 'tem_v2' },
      { season_id: 'sea_w1', team_id: 'tem_w1' }
    ]
    await db.insertInto('season_teams').values(links).execute()
    await db.insertInto('season_team_parents').values(links).execute()

    const role = (
      name: string,
      scopeType: 'league' | 'season' | 'team',
      scopeId: string,
      given: Role
    ): Insertable<ScopeRolesTable> => ({
      id: makeId('scopeRole'),
      user_id: idOf(name),
      scope_type: scopeType,
      scope_id: scopeId,
      role: given,
      granted_at: new Date()
    })
    await db
      .insertInto('scope_roles')
      .values([
        role('Tony La Russa', 'league', 'lea_v', 'admin'),
        role('Joe Torre', 'season', 'sea_v1', 'coach'),
        role('Dusty Baker', 'team', 'tem_v1', 'assistant'),
        role('Bruce Bochy', 'team', 'tem_v1', 'admin'),
        role('Terry Francona', 'team', 'tem_v1', 'scorekeeper'),
        role('Bobby Cox', 'league', 'lea_w', 'admin'),
        role('Jim Leyland', 'team', 'tem_v1', 'songkeeper'),
        role('Sparky Anderson', 'league', 'lea_v', 'admin'),
        role('Tommy Lasorda', 'league', 'lea_v', 'admin'),
        role('Ken Griffey', 'league', 'lea_v', 'coach')
      ])
      .execute()
    const member = (
      name: string,
      teamId: string,
      isPlayer: boolean
    ): Insertable<MembershipsTable> => ({
      id: makeId('membership'),
      user_id: idOf(name),
      team_id: teamId,
      is_player: isPlayer,
      role: 'member'
    })
    const andruw = makeId('membership')
    await db
      .insertInto('memberships')
      .values([
        member('Mookie Betts', 'tem_v1', true),
        member('Aaron Judge', 'tem_v2', false),
        member('Lou Piniella', 'tem_v1', false),
        { ...member('Andruw Jones', 'tem_v1', true), id: andruw },
        member('Javy Lopez', 'tem_vx', true),
        member('John Smoltz', 'tem_vy', true),
        member('Tom Glavine', 'tem_w1', true),
        member('Greg Maddux', 'tem_vz', true),
        member('Tim Raines', 'tem_v2', false)
      ])
      .execute()
    await db
      .insertInto('season_members')
      .values([
        {
          id: makeId('seasonMember'),
          user_id: idOf('Mike Trout'),
          season_id: 'sea_v1',
          joined_at: new Date()
        },
        {
          id: makeId('seasonMember'),
          user_id: idOf('Rickey Henderson'),
          season_id: 'sea_v1',
          joined_at: new Date()
        }
      ])
      .execute()
    await db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: idOf('Derek Jeter'),
        league_id: 'lea_v',
        joined_at: new Date()
      })
      .execute()
    await db
      .insertInto('follows')
      .values([
        {
          user_id: idOf('Barry Larkin'),
          group_type: 'team',
          group_id: 'tem_v1'
        },
        {
          user_id: idOf('Barry Bonds'),
          group_type: 'team',
          group_id: 'tem_vold'
        },
        {
          user_id: idOf('Edgar Martinez'),
          group_type: 'season',
          group_id: 'sea_v1'
        }
      ])
      .execute()
    await db
      .insertInto('league_umpires')
      .values({
        league_id: 'lea_v',
        user_id: idOf('Chipper Jones'),
        granted_by: idOf('Tony La Russa')
      })
      .execute()
    await db
      .insertInto('user_links')
      .values([
        {
          id: makeId('userLink'),
          user_id: idOf('Tony Gwynn'),
          related_user_id: idOf('Mookie Betts'),
          kind: 'guardian' as const,
          created_at: new Date()
        },
        {
          id: makeId('userLink'),
          user_id: idOf('Craig Biggio'),
          related_user_id: idOf('Mookie Betts'),
          kind: 'family' as const,
          created_at: new Date()
        },
        {
          id: makeId('userLink'),
          user_id: idOf('Greg Maddux'),
          related_user_id: idOf('Andruw Jones'),
          kind: 'guardian' as const,
          created_at: new Date()
        }
      ])
      .execute()
    // The Hawks hold Andruw Jones only by an add his side may still reject.
    await db
      .insertInto('group_requests')
      .values({
        id: 'grq_mayview_add',
        kind: 'playerAdd',
        sender_id: idOf('Bruce Bochy'),
        sender_scope_type: 'team',
        sender_scope_id: 'tem_v1',
        terms: JSON.stringify({
          mode: 'roster',
          userId: idOf('Andruw Jones'),
          membershipId: andruw
        }),
        status: 'applied',
        sent_at: new Date(Date.now() - 86_400_000),
        expires_at: new Date(Date.now() + 86_400_000),
        initiating_team_id: 'tem_v1'
      })
      .execute()
  })

  it('reads in full everybody mayEditNames allows', async function () {
    for (const reader of [
      'Mookie Betts',
      'Tony Gwynn',
      'Craig Biggio',
      'Terry Francona',
      'Bruce Bochy'
    ])
      expect(await sees(reader, 'Mookie Betts'), reader).equals(true)
    const everyone = await mayViewFullNames(
      fixture.db,
      idOf('Lou Piniella'),
      PEOPLE.map(idOf),
      { isAdmin: true }
    )
    expect(everyone.size).equals(PEOPLE.length)
    expect(await sees('Bobby Cox', 'Mookie Betts', true)).equals(true)
  })

  it('reads in full whom a team, a season and a league people manager has on a list of theirs', async function () {
    // A team's assistant: its adults and players, and the league's members,
    // role holders and the team's followers shown on its list.
    for (const person of [
      'Mookie Betts',
      'Lou Piniella',
      'Derek Jeter',
      'Ken Griffey',
      'Mike Trout',
      'Barry Larkin',
      'Barry Bonds',
      'Tony Gwynn',
      'Craig Biggio'
    ])
      expect(await sees('Dusty Baker', person), person).equals(true)
    // Not another team's adult, nor the season's follower.
    for (const person of ['Aaron Judge', 'Edgar Martinez', 'Chipper Jones'])
      expect(await sees('Dusty Baker', person), person).equals(false)
    // A season's coach: an adult on a team the season reaches, its member,
    // follower, and the league's members and role holders.
    for (const person of [
      'Aaron Judge',
      'Mike Trout',
      'Edgar Martinez',
      'Derek Jeter',
      'Ken Griffey',
      'Tony Gwynn',
      'Mookie Betts'
    ])
      expect(await sees('Joe Torre', person), person).equals(true)
    // A league's administrator: all of those, and the league's umpire, whose
    // profile they open; a season's coach is not shown the umpire.
    for (const person of [
      'Aaron Judge',
      'Mike Trout',
      'Derek Jeter',
      'Ken Griffey',
      'Barry Larkin',
      'Chipper Jones'
    ])
      expect(await sees('Tony La Russa', person), person).equals(true)
    expect(await sees('Joe Torre', 'Chipper Jones')).equals(false)
    // Reading never grants changing: the adults stay out of mayEditNames.
    expect(
      await mayEditName(
        fixture.db,
        idOf('Tony La Russa'),
        idOf('Derek Jeter'),
        about
      )
    ).equals(false)
  })

  it('keeps a disabled person on a list only as a team member or a player', async function () {
    expect(await sees('Joe Torre', 'Tim Raines')).equals(true)
    expect(await sees('Joe Torre', 'Rickey Henderson')).equals(false)
  })

  it('reads nobody more for a disabled, closed or unknown reader, and does not throw', async function () {
    for (const reader of ['Sparky Anderson', 'Tommy Lasorda']) {
      expect(await sees(reader, 'Derek Jeter'), reader).equals(false)
      expect(await sees(reader, reader), reader).equals(true)
    }
    expect(
      await mayViewFullName(
        fixture.db,
        'usr_nobody0000000000000',
        idOf('Derek Jeter'),
        about
      )
    ).equals(false)
  })

  it('denies an unrelated manager, a plain member and a songkeeper', async function () {
    for (const reader of ['Bobby Cox', 'Lou Piniella', 'Jim Leyland'])
      for (const person of [
        'Aaron Judge',
        'Mike Trout',
        'Derek Jeter',
        'Tony Gwynn'
      ])
        expect(await sees(reader, person), `${reader} ${person}`).equals(false)
    expect(await sees('Bobby Cox', 'Mookie Betts')).equals(false)
    expect(await sees('Bobby Cox', 'Tom Glavine')).equals(true)
  })

  it('counts no team holding a player only by an open add, for them or their guardian', async function () {
    for (const reader of ['Bruce Bochy', 'Joe Torre', 'Tony La Russa']) {
      expect(await sees(reader, 'Andruw Jones'), reader).equals(false)
      expect(await sees(reader, 'Greg Maddux'), reader).equals(false)
    }
    const expire = async (at: Date): Promise<void> => {
      await fixture.db
        .updateTable('group_requests')
        .set({ expires_at: at })
        .where('id', '=', 'grq_mayview_add')
        .execute()
    }
    await expire(new Date(Date.now() - 1000))
    try {
      expect(await sees('Joe Torre', 'Andruw Jones')).equals(true)
      expect(await sees('Joe Torre', 'Greg Maddux')).equals(true)
    } finally {
      await expire(new Date(Date.now() + 86_400_000))
    }
  })

  it("gives a placeholder team's people to its custodian's administrators", async function () {
    // Kept by the season: its league's administrator, not its coach.
    expect(await sees('Tony La Russa', 'Javy Lopez')).equals(true)
    expect(await sees('Joe Torre', 'Javy Lopez')).equals(false)
    // Kept by a full team: its administrator, not its assistant.
    expect(await sees('Bruce Bochy', 'John Smoltz')).equals(true)
    expect(await sees('Dusty Baker', 'John Smoltz')).equals(false)
    // Kept by a placeholder: nobody's.
    expect(await sees('Bruce Bochy', 'Greg Maddux')).equals(false)
  })

  it('reuses rows the caller has, and asks about fifty in as many queries as two', async function () {
    const known = await onePerson(fixture.db, idOf('Mike Trout'))
    expect(
      await mayViewFullName(
        fixture.db,
        idOf('Joe Torre'),
        idOf('Mike Trout'),
        about,
        new Map([[idOf('Mike Trout'), known]])
      )
    ).equals(true)
    const others: string[] = []
    for (let i = 0; i < 48; i++) {
      const one = mintUserId(id => taken.has(id))
      taken.add(one.userId)
      others.push(userIdOfGumbo(one.userId))
      await insertFixtureUsers(fixture.db, {
        id: one.userId,
        legacyId: one.legacyId,
        display_name: `Demo Player ${i}`
      })
    }
    const counted = (): { db: Kysely<Database>; queries: () => number } => {
      let queries = 0
      return {
        db: fixture.db.withPlugin({
          transformQuery(args) {
            queries++
            return args.node
          },
          async transformResult(args) {
            return args.result
          }
        }),
        queries: () => queries
      }
    }
    const two = counted()
    const few = await mayViewFullNames(
      two.db,
      idOf('Joe Torre'),
      [idOf('Tony Gwynn'), others[0]],
      about
    )
    const fifty = counted()
    const many = await mayViewFullNames(
      fifty.db,
      idOf('Joe Torre'),
      [idOf('Tony Gwynn'), ...others, idOf('Tom Glavine')],
      about
    )
    expect([...few]).deep.equals([idOf('Tony Gwynn')])
    expect([...many]).deep.equals([idOf('Tony Gwynn')])
    expect(fifty.queries()).equals(two.queries())
  })

  it("reads the open adds of a listed person's own teams alone, never the other teams of a league they belong to", async function () {
    const asked: unknown[][] = []
    const executor = fixture.db.getExecutor()
    const db = fixture.db.withPlugin({
      transformQuery(args) {
        const compiled = executor.compileQuery(args.node, args.queryId)
        if (compiled.sql.includes('from "group_requests"'))
          asked.push([...compiled.parameters])
        return args.node
      },
      async transformResult(args) {
        return args.result
      }
    })
    // Derek Jeter belongs to League V and to none of its teams; his reader
    // assists on one of them.
    expect([
      ...(await mayViewFullNames(
        db,
        idOf('Dusty Baker'),
        [idOf('Derek Jeter')],
        about
      ))
    ]).deep.equals([idOf('Derek Jeter')])
    const teams = asked.flat(Infinity)
    for (const team of ['tem_v2', 'tem_vold', 'tem_w1'])
      expect(teams, team).not.includes(team)
  })

  it('reads the reader’s roles once, for changing and seeing alike', async function () {
    const traced = (): { db: Kysely<Database>; sql: string[] } => {
      const sql: string[] = []
      const executor = fixture.db.getExecutor()
      return {
        db: fixture.db.withPlugin({
          transformQuery(args) {
            sql.push(executor.compileQuery(args.node, args.queryId).sql)
            return args.node
          },
          async transformResult(args) {
            return args.result
          }
        }),
        sql
      }
    }
    // Somebody Joe may neither change nor see in full, so both halves run.
    const stranger = mintUserId(id => taken.has(id))
    taken.add(stranger.userId)
    await insertFixtureUsers(fixture.db, {
      id: stranger.userId,
      legacyId: stranger.legacyId,
      display_name: 'Demo Stranger'
    })
    const view = traced()
    expect([
      ...(await mayViewFullNames(
        view.db,
        idOf('Joe Torre'),
        [idOf('Tony Gwynn'), userIdOfGumbo(stranger.userId)],
        about
      ))
    ]).deep.equals([idOf('Tony Gwynn')])
    const roles = traced()
    await roleScopes(roles.db, idOf('Joe Torre'), false)
    // Each read of who holds what that `roleScopes` makes, made once in all.
    const held = roles.sql.filter(
      query =>
        query.includes('from "scope_roles"') || query.includes('from "users"')
    )
    expect(held.length).greaterThan(1)
    for (const query of held)
      expect(view.sql.filter(made => made === query).length, query).equals(1)
  })
})
