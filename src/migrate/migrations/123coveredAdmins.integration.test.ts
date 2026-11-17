import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { effectiveAdminIds } from '../../server/groups/adminGuard'
import { ownershipPreflight } from '../../server/groups/ownershipPreflight'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { migration123CoveredAdmins as migration } from './123coveredAdmins'

describe('covered administrator migration', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  async function run(): Promise<void> {
    await f.h.db.transaction().execute(async trx => {
      await sql.raw(migration.up).execute(trx)
    })
  }
  const roles = async (): Promise<unknown[]> =>
    await f.h.db.selectFrom('scope_roles').selectAll().orderBy('id').execute()
  it('removes nested redundancy only, retaining owners, staff, standalone and site-only grants', async () => {
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userIdOfGumbo(101),
        team_id: f.teamA,
        role: 'owner',
        joined_at: new Date()
      })
      .execute()
    await f.h.db
      .insertInto('scope_roles')
      .values([
        {
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(101),
          scope_type: 'team',
          scope_id: f.teamA,
          role: 'scorekeeper'
        },
        {
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(105),
          scope_type: 'team',
          scope_id: f.teamA,
          role: 'admin'
        }
      ])
      .execute()
    await run()
    for (const id of [f.seasonA, f.playoffs, f.teamA])
      expect(
        await f.h.db
          .selectFrom('scope_roles')
          .select('id')
          .where('scope_id', '=', id)
          .where('role', '=', 'admin')
          .where('user_id', '=', userIdOfGumbo(101))
          .execute()
      ).length(0)
    for (const group of [
      { kind: 'season' as const, id: f.seasonA },
      { kind: 'team' as const, id: f.teamA }
    ])
      expect(await effectiveAdminIds(f.h.db, group)).includes(
        userIdOfGumbo(101)
      )
    expect(
      await f.h.db
        .selectFrom('memberships')
        .select('role')
        .where('team_id', '=', f.teamA)
        .execute()
    ).deep.equals([{ role: 'owner' }])
    expect(
      await f.h.db
        .selectFrom('scope_roles')
        .select('role')
        .where('scope_id', '=', f.teamA)
        .orderBy('role')
        .execute()
    ).deep.equals([{ role: 'admin' }, { role: 'scorekeeper' }])
    expect(
      await f.h.db
        .selectFrom('scope_roles')
        .select('id')
        .where('scope_id', 'in', [f.standaloneSeason, f.standaloneTeam])
        .execute()
    ).length(2)
    const first = await roles()
    await run()
    await sql.raw(migration.down).execute(f.h.db)
    expect(await roles()).deep.equals(first)
  })
  it('preserves inactive, merged and login-disabled grants', async () => {
    await f.h.db
      .insertInto('scope_roles')
      .values([
        {
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(103),
          scope_type: 'league',
          scope_id: f.leagueA,
          role: 'admin'
        },
        {
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(103),
          scope_type: 'team',
          scope_id: f.teamA,
          role: 'admin'
        }
      ])
      .execute()
    for (const [user, state] of [
      [101, { login_enabled: false }],
      [102, { disabled_at: new Date() }],
      [103, { merged_into: userIdOfGumbo(104) }]
    ] as const)
      await f.h.db
        .updateTable('users')
        .set(state)
        .where('id', '=', userIdOfGumbo(user))
        .execute()
    const before = await roles()
    await run()
    expect(await roles()).deep.equals(before)
  })
  for (const ready of [false, true])
    it(`keeps team grants before cutover and uses only permission parents after (hierarchyReady=${ready})`, async () => {
      await f.h.db
        .updateTable('system_settings')
        .set({ value: ready })
        .where('key', '=', 'creation.hierarchyReady')
        .execute()
      await f.h.db
        .deleteFrom('season_team_parents')
        .where('team_id', '=', f.teamA)
        .execute()
      await f.h.db
        .updateTable('teams')
        .set({ league_id: null })
        .where('id', '=', f.teamA)
        .execute()
      await f.h.db
        .insertInto('season_teams')
        .values({ team_id: f.teamA, season_id: f.seasonA })
        .execute()
      await run()
      expect(
        await f.h.db
          .selectFrom('scope_roles')
          .select('id')
          .where('scope_id', '=', f.teamA)
          .execute()
      ).length(1)
    })
  it('supports migration before ownership cutover and repeat preflight', async () => {
    await f.h.db
      .updateTable('system_settings')
      .set({ value: false })
      .where('key', '=', 'creation.hierarchyReady')
      .execute()
    await f.h.db
      .insertInto('season_teams')
      .values([
        { team_id: f.teamA, season_id: f.seasonA },
        { team_id: f.teamA, season_id: f.playoffs },
        { team_id: f.teamB, season_id: f.seasonB }
      ])
      .execute()
    await f.h.db.deleteFrom('season_team_parents').execute()
    await f.h.db
      .updateTable('teams')
      .set({ league_id: null })
      .where('id', 'in', [f.teamA, f.teamB])
      .execute()
    await run()
    // The cutover may still choose no parent for a team, so its grant stays.
    const standalone = await ownershipPreflight(f.h.db, {
      dryRun: true,
      choices: [{ teamId: f.teamA, parentSeasonIds: [] }]
    })
    expect(standalone.conflicts).deep.equals([])
    const safe = await ownershipPreflight(f.h.db, { dryRun: false })
    expect(safe.conflicts).deep.equals([])
    expect(safe.ready).equals(true)
    expect(
      (await ownershipPreflight(f.h.db, { dryRun: false })).alreadyApplied
    ).equals(true)
    expect(
      await effectiveAdminIds(f.h.db, { kind: 'team', id: f.teamA })
    ).deep.equals([userIdOfGumbo(101)])
  })
})
