import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import type {
  ScheduleGamesResponse,
  ScheduleOpponent
} from '../../common/scheduleGames'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { roleScopes } from '../access'
import { withdrawFromGame } from './gameApprovals'
import { scheduleGames } from './scheduleGames'

describe('legacy batch scheduling approval boundary', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const row = (
    f: GroupFixture,
    opponent: ScheduleOpponent = { teamId: f.teamB }
  ): object => ({
    opponent,
    side: 'home',
    seasonId: f.seasonA,
    startAt: '2029-07-01T19:00:00Z',
    externalId: { system: 'fixture', id: 'batch-game' }
  })
  async function grant(
    userId: number,
    kind: 'team' | 'season',
    id: string
  ): Promise<void> {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userId,
        scope_type: kind,
        scope_id: id,
        role: 'admin'
      })
      .execute()
  }
  for (const ready of [undefined, false])
    it(`refuses service and HTTP publication with readiness ${String(ready)}, rolling back games, opponents, IDs and audit`, async () => {
      await f.h.db
        .deleteFrom('system_settings')
        .where('key', '=', 'creation.hierarchyReady')
        .execute()
      if (ready !== undefined)
        await f.h.db
          .insertInto('system_settings')
          .values({ key: 'creation.hierarchyReady', value: ready })
          .execute()
      await f.h.db
        .insertInto('season_teams')
        .values([
          { season_id: f.seasonA, team_id: f.teamA },
          { season_id: f.seasonA, team_id: f.teamB }
        ])
        .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
        .execute()
      expect(
        (await roleScopes(f.h.db, 101, false)).admin.teamIds.has(f.teamB)
      ).equals(true)
      const beforeTeams = await f.h.db.selectFrom('teams').selectAll().execute()
      const body = {
        games: [row(f), row(f, { name: 'Demo Unready Opponent' })]
      }
      const service = await scheduleGames(f.h.db, {
        teamId: f.teamA,
        rows: body.games,
        actor: actor(101)
      })
      for (const response of [
        service,
        await (
          await f.h.request('POST', `/teams/${f.teamA}/games`, body, 101)
        ).json(),
        await (
          await f.h.request('POST', `/TEAMS/${f.teamA}/GAMES/`, body, 101)
        ).json()
      ] as ScheduleGamesResponse[]) {
        expect(response.results.map(result => result.result)).deep.equals([
          'error',
          'error'
        ])
        for (const result of response.results)
          expect(result).property('error').deep.equals({
            code: 'forbidden',
            message:
              'Finish organization setup before publishing schedule changes'
          })
      }
      for (const table of ['games', 'external_ids', 'group_requests'] as const)
        expect(await f.h.db.selectFrom(table).selectAll().execute()).length(0)
      expect(
        await f.h.db.selectFrom('teams').selectAll().execute()
      ).deep.equals(beforeTeams)
      expect(
        await f.h.db
          .selectFrom('audit_log')
          .selectAll()
          .where('method', '=', 'BATCH')
          .execute()
      ).length(0)
      await f.h.db
        .insertInto('system_settings')
        .values({ key: 'creation.hierarchyReady', value: true })
        .onConflict(oc => oc.column('key').doUpdateSet({ value: true }))
        .execute()
      expect(
        (await roleScopes(f.h.db, 101, false)).admin.teamIds.has(f.teamB)
      ).equals(false)
      const refused = await scheduleGames(f.h.db, {
        teamId: f.teamA,
        rows: [row(f)],
        actor: actor(101)
      })
      expect(refused.results[0]).property('error').property('code', 'forbidden')
      await grant(101, 'team', f.teamB)
      expect(
        (
          await scheduleGames(f.h.db, {
            teamId: f.teamA,
            rows: [row(f)],
            actor: actor(101)
          })
        ).results[0].result
      ).equals('created')
    })
  it('preserves a safe unchanged retry while unresolved, but rolls back material revisions and new game aliases', async () => {
    await grant(101, 'team', f.teamB)
    const original = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      rows: [row(f)],
      actor: actor(101)
    })
    expect(original.results[0].result).equals('created')
    const before = await f.h.db.selectFrom('games').selectAll().execute()
    const ids = await f.h.db.selectFrom('external_ids').selectAll().execute()
    const audit = await f.h.db
      .selectFrom('audit_log')
      .selectAll()
      .where('method', '=', 'BATCH')
      .execute()
    await f.h.db
      .updateTable('system_settings')
      .set({ value: false })
      .where('key', '=', 'creation.hierarchyReady')
      .execute()
    const response = await f.h.request(
      'POST',
      `/teams/${f.teamA}/games`,
      {
        games: [
          row(f),
          { ...row(f), venue: 'Demo Changed Field' },
          {
            ...row(f),
            externalId: { system: 'fixture', id: 'new-unready-alias' }
          }
        ]
      },
      101
    )
    expect(response.status).equals(200)
    const result = (await response.json()) as ScheduleGamesResponse
    expect(result.results.map(row => row.result)).deep.equals([
      'unchanged',
      'error',
      'error'
    ])
    expect(await f.h.db.selectFrom('games').selectAll().execute()).deep.equals(
      before
    )
    expect(
      await f.h.db.selectFrom('external_ids').selectAll().execute()
    ).deep.equals(ids)
    expect(
      await f.h.db
        .selectFrom('audit_log')
        .selectAll()
        .where('method', '=', 'BATCH')
        .execute()
    ).deep.equals(audit)
  })
  it('refuses opponent identity enrichment on an otherwise unchanged held game before cutover', async () => {
    const stub = 'tem_demo_batch_stub'
    await f.h.db
      .insertInto('teams')
      .values({
        id: stub,
        name: 'Demo Batch Stub',
        kind: 'external',
        custodian_type: 'season',
        custodian_id: f.seasonA
      })
      .execute()
    const fixtureRow = row(f, { teamId: stub })
    expect(
      (
        await scheduleGames(f.h.db, {
          teamId: f.teamA,
          rows: [fixtureRow],
          actor: actor(101)
        })
      ).results[0].result
    ).equals('created')
    await f.h.db
      .updateTable('system_settings')
      .set({ value: false })
      .where('key', '=', 'creation.hierarchyReady')
      .execute()
    const before = await f.h.db.selectFrom('external_ids').selectAll().execute()
    const result = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      rows: [
        {
          ...fixtureRow,
          opponent: {
            teamId: stub,
            externalId: {
              system: 'fixture',
              kind: 'opponent',
              id: 'unready-opponent-alias'
            }
          }
        }
      ],
      actor: actor(101)
    })
    expect(result.results[0]).property('error').property('code', 'forbidden')
    expect(
      await f.h.db.selectFrom('external_ids').selectAll().execute()
    ).deep.equals(before)
  })
  it('refuses missing opponent consent and rolls back the game, IDs, audit and hidden requests', async () => {
    const result = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      rows: [row(f)],
      actor: actor(101)
    })
    expect(result.results[0]).deep.equals({
      index: 0,
      result: 'error',
      error: {
        code: 'forbidden',
        message: 'Additional approval is required; use game proposals'
      }
    })
    for (const table of ['games', 'external_ids', 'group_requests'] as const)
      expect(await f.h.db.selectFrom(table).selectAll().execute()).length(0)
    expect(
      await f.h.db
        .selectFrom('audit_log')
        .selectAll()
        .where('method', '=', 'BATCH')
        .execute()
    ).length(0)
  })
  it('publishes with all current consents, preserves ordered row results, retries IDs and audits approval', async () => {
    await grant(101, 'team', f.teamB)
    const result = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      rows: [row(f), { bad: true }, row(f)],
      actor: actor(101)
    })
    expect(result.results.map(r => r.result)).deep.equals([
      'created',
      'error',
      'unchanged'
    ])
    expect(result.counts).deep.equals({
      created: 1,
      error: 1,
      unchanged: 1,
      updated: 0
    })
    expect(await f.h.db.selectFrom('games').selectAll().execute()).length(1)
    const audit = await f.h.db
      .selectFrom('audit_log')
      .selectAll()
      .where('method', '=', 'BATCH')
      .execute()
    expect(audit).length(1)
    expect(audit[0].actor_user_id).equals(101)
    await f.h.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', 101)
      .where('scope_id', '=', f.teamB)
      .execute()
    const retry = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      rows: [row(f)],
      actor: actor(101)
    })
    expect(retry.results[0].result).equals('unchanged')
    const change = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      rows: [{ ...row(f), venue: 'Changed Field' }],
      actor: actor(101)
    })
    expect(change.results[0]).deep.include({ result: 'error' })
    expect(
      (
        await f.h.db
          .selectFrom('games')
          .select('venue')
          .executeTakeFirstOrThrow()
      ).venue
    ).equals(null)
  })
  it('requires host placement authority in addition to both teams, without another consent request', async () => {
    await grant(101, 'team', f.teamB)
    const result = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      rows: [{ ...row(f), seasonId: f.seasonB }],
      actor: actor(101)
    })
    expect(result.results[0]).deep.include({ result: 'error' })
    expect(await f.h.db.selectFrom('games').selectAll().execute()).length(0)
    await grant(101, 'season', f.seasonB)
    const permitted = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      rows: [{ ...row(f), seasonId: f.seasonB }],
      actor: actor(101)
    })
    expect(permitted.results[0]).deep.include({ result: 'created' })
    expect(await f.h.db.selectFrom('games').selectAll().execute()).length(1)
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('kind', '=', 'game')
        .execute()
    ).length(0)
  })
  it('rejects a machine or unverified caller and cannot trust supplied stale rights', async () => {
    const rights = {
      siteAdmin: true,
      teamAdminIds: new Set<string>(),
      seasonIds: new Set<string>()
    }
    for (const caller of [
      undefined,
      { ...actor(105), apiTokenId: 'fixture-token' },
      actor(106)
    ]) {
      const result = await scheduleGames(f.h.db, {
        teamId: f.teamA,
        rows: [row(f)],
        actor: caller,
        rights
      })
      expect(result.results[0]).property('error').property('code', 'forbidden')
    }
    expect(await f.h.db.selectFrom('games').selectAll().execute()).length(0)
  })
  it('gives a newly named external opponent explicit host custody without inferred membership', async () => {
    const result = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      rows: [{ ...row(f), opponent: { name: 'Demo New Opponent' } }],
      actor: actor(101)
    })
    expect(result.results[0].result).equals('created')
    const stub = await f.h.db
      .selectFrom('teams')
      .selectAll()
      .where('name', '=', 'Demo New Opponent')
      .executeTakeFirstOrThrow()
    expect(stub).deep.include({
      kind: 'external',
      custodian_type: 'season',
      custodian_id: f.seasonA,
      league_id: null
    })
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .selectAll()
        .where('team_id', '=', stub.id)
        .execute()
    ).length(0)
  })
  it('never claims or renames an existing foreign external opponent by name or ID', async () => {
    const stub = 'tem_foreign_stub'
    await f.h.db
      .insertInto('teams')
      .values({
        id: stub,
        name: 'Demo Foreign Opponent',
        kind: 'external',
        custodian_type: 'season',
        custodian_id: f.seasonB
      })
      .execute()
    for (const opponent of [
      { name: 'Demo Foreign Opponent' },
      {
        teamId: stub,
        externalId: { system: 'fixture', kind: 'opponent', id: 'foreign-id' }
      }
    ]) {
      const result = await scheduleGames(f.h.db, {
        teamId: f.teamA,
        rows: [{ ...row(f), opponent }],
        actor: actor(101)
      })
      expect(result.results[0]).property('error').property('code', 'forbidden')
    }
    expect(
      await f.h.db.selectFrom('external_ids').selectAll().execute()
    ).length(0)
    expect(
      (
        await f.h.db
          .selectFrom('teams')
          .selectAll()
          .where('id', '=', stub)
          .executeTakeFirstOrThrow()
      ).custodian_id
    ).equals(f.seasonB)
  })
  it('cannot resurrect a withdrawn game or attach a fresh game alias without consent', async () => {
    await grant(101, 'team', f.teamB)
    const result = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      rows: [row(f)],
      actor: actor(101)
    })
    const created = result.results[0]
    if (created.result === 'error') throw new Error(created.error.message)
    await withdrawFromGame(f.h.db, actor(101), created.gameId, f.teamA, f.clock)
    const revised = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      rows: [{ ...row(f), status: 'scheduled' }],
      actor: actor(101)
    })
    expect(revised.results[0]).property('error').property('code', 'conflict')
    expect(
      (
        await f.h.db
          .selectFrom('games')
          .selectAll()
          .where('id', '=', created.gameId)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('cancelled')
  })
  it('serializes concurrent external IDs and fixture twins into one published game', async () => {
    await grant(101, 'team', f.teamB)
    const results = await Promise.all(
      ['first', 'second'].map(
        async id =>
          await scheduleGames(f.h.db, {
            teamId: f.teamA,
            rows: [{ ...row(f), externalId: { system: 'fixture', id } }],
            actor: actor(101)
          })
      )
    )
    expect(
      results
        .flatMap(r => r.results)
        .map(r => r.result)
        .sort()
    ).deep.equals(['created', 'updated'])
    expect(await f.h.db.selectFrom('games').selectAll().execute()).length(1)
    expect(
      await f.h.db.selectFrom('external_ids').selectAll().execute()
    ).length(2)
  })
})
