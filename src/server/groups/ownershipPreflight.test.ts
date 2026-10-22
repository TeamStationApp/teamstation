import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import {
  analyzeOwnership,
  type OwnershipInput,
  ownershipPreflight
} from './ownershipPreflight'

function fixture(): OwnershipInput {
  return {
    teams: [{ id: 't', kind: 'full' }],
    seasons: [
      { id: 's1', leagueId: 'l' },
      { id: 's2', leagueId: 'l' }
    ],
    leagues: [{ id: 'l' }],
    memberships: [
      { teamId: 't', seasonId: 's1' },
      { teamId: 't', seasonId: 's2' }
    ],
    directAdmins: [
      { kind: 'team', id: 't' },
      { kind: 'season', id: 's1' },
      { kind: 'season', id: 's2' },
      { kind: 'league', id: 'l' }
    ]
  }
}

describe('ownership decisions', () => {
  it('preserves a matching lineage and identifies missing direct administrators', () => {
    expect(analyzeOwnership(fixture())).property('ready', true)
    const input = fixture()
    input.directAdmins = []
    expect(analyzeOwnership(input).conflicts).length(4)
  })
  it('requires a choice for mixed lineages and multiple standalone parents', () => {
    const input = fixture()
    input.seasons[0].leagueId = null
    expect(analyzeOwnership(input).ready).equals(false)
    input.seasons[1].leagueId = null
    expect(analyzeOwnership(input).ready).equals(false)
    const result = analyzeOwnership(input, [
      { teamId: 't', parentSeasonIds: ['s1'] }
    ])
    expect(result.ready).equals(true)
    expect(result.parents).deep.equals([
      { teamId: 't', seasonId: 's1', leagueId: null }
    ])
    expect(
      analyzeOwnership(input, [{ teamId: 't', parentSeasonIds: [] }]).parents
    ).deep.equals([])
  })
  it('rejects duplicate, unrelated and unknown decisions without creating parents', () => {
    for (const choices of [
      [{ teamId: 'missing', parentSeasonIds: [] }],
      [{ teamId: 't', parentSeasonIds: ['s1', 's1'] }],
      [{ teamId: 't', parentSeasonIds: ['other'] }]
    ])
      expect(analyzeOwnership(fixture(), choices).ready).equals(false)
    const input = fixture()
    input.seasons = []
    expect(analyzeOwnership(input).ready).equals(false)
  })
  it('requires external custody without inventing a direct account', () => {
    const input = fixture()
    input.teams = [{ id: 'x', kind: 'external' }]
    expect(analyzeOwnership(input).conflicts[0].reason).includes('custodian')
    input.teams[0].custodianId = 'l'
    input.teams[0].custodianType = 'league'
    expect(analyzeOwnership(input).ready).equals(true)
    input.teams[0].custodianType = 'season'
    input.teams[0].custodianId = 's1'
    expect(analyzeOwnership(input).ready).equals(true)
    input.teams.push({ id: 't', kind: 'full' })
    input.teams[0].custodianType = 'team'
    input.teams[0].custodianId = 't'
    expect(analyzeOwnership(input).ready).equals(true)
    input.teams = [{ id: 't', kind: 'full' }]
    input.memberships = []
    expect(analyzeOwnership(input).parents).deep.equals([])
  })
})

describe('ownership cutover in PostgreSQL', function () {
  this.timeout(60000)
  let h: AccountHarness
  before(async () => {
    h = await accountHarness()
  })
  after(async () => {
    await h?.close()
  })
  it('does not apply until direct administration is explicitly resolved', async () => {
    const missing = await ownershipPreflight(h.db, { dryRun: false })
    expect(missing.ready).equals(false)
    expect(
      await h.db.selectFrom('season_team_parents').selectAll().execute()
    ).length(0)
    await h.db
      .updateTable('memberships')
      .set({ role: 'owner' })
      .where('team_id', '=', 'tem_account')
      .execute()
    await h.db
      .insertInto('leagues')
      .values({ id: 'l', name: 'Demo League' })
      .execute()
    await h.db
      .insertInto('seasons')
      .values({
        starts_on: `2027-03-01`,
        ends_on: `2027-05-31`,
        id: 's',
        name: 'Demo Spring',
        year: 2027,
        league_id: 'l'
      })
      .execute()
    await h.db
      .insertInto('season_teams')
      .values({ team_id: 'tem_account', season_id: 's' })
      .execute()
    await h.db
      .insertInto('scope_roles')
      .values([
        {
          id: 'r1',
          scope_type: 'league',
          scope_id: 'l',
          user_id: userIdOfGumbo(101),
          role: 'admin'
        },
        {
          id: 'r2',
          scope_type: 'season',
          scope_id: 's',
          user_id: userIdOfGumbo(101),
          role: 'admin'
        }
      ])
      .execute()
    const dry = await ownershipPreflight(h.db, { dryRun: true })
    expect(dry.ready).equals(true)
    expect(
      await h.db.selectFrom('season_team_parents').selectAll().execute()
    ).length(0)
    const applied = await ownershipPreflight(h.db, { dryRun: false })
    expect(applied).property('alreadyApplied', false)
    expect(
      (
        await h.db
          .selectFrom('teams')
          .select('league_id')
          .where('id', '=', 'tem_account')
          .executeTakeFirstOrThrow()
      ).league_id
    ).equals('l')
    expect(await h.db.selectFrom('season_teams').selectAll().execute()).length(
      1
    )
    expect(await ownershipPreflight(h.db, { dryRun: false })).property(
      'alreadyApplied',
      true
    )
    await h.db
      .insertInto('seasons')
      .values({
        starts_on: `2027-03-01`,
        ends_on: `2027-05-31`,
        id: 'guest',
        name: 'Demo Exhibition',
        year: 2027,
        league_id: null
      })
      .execute()
    await h.db
      .insertInto('scope_roles')
      .values({
        id: 'guestAdmin',
        user_id: userIdOfGumbo(102),
        scope_type: 'season',
        scope_id: 'guest',
        role: 'admin'
      })
      .execute()
    await h.db
      .insertInto('season_teams')
      .values({ team_id: 'tem_account', season_id: 'guest' })
      .execute()
    const repeated = await ownershipPreflight(h.db, { dryRun: false })
    expect(repeated).property('alreadyApplied', true)
    expect(repeated.parents.map(parent => parent.seasonId)).deep.equals(['s'])
  })
})
