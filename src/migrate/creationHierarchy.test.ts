import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { type AccountHarness, accountHarness } from '../test/accountHarness'

describe('independent creation relations', function () {
  this.timeout(60000)
  let h: AccountHarness
  before(async () => {
    h = await accountHarness()
    await h.db
      .insertInto('leagues')
      .values({ id: 'l', name: 'Demo League' })
      .execute()
    await h.db
      .insertInto('seasons')
      .values([
        { id: 's1', name: 'Standalone One', year: 2027, league_id: null },
        { id: 's2', name: 'Standalone Two', year: 2027, league_id: null },
        { id: 'sl1', name: 'Regular', year: 2027, league_id: 'l' },
        { id: 'sl2', name: 'Playoffs', year: 2027, league_id: 'l' }
      ])
      .execute()
  })
  after(async () => {
    await h?.close()
  })
  it('backfills login accounts as complete', async () => {
    const user = await h.db
      .selectFrom('users')
      .select(['onboarding_step', 'onboarding_completed_at'])
      .where('id', '=', 101)
      .executeTakeFirstOrThrow()
    expect(user.onboarding_step).equals('complete')
    expect(user.onboarding_completed_at).not.equals(null)
  })
  it('allows one standalone parent but refuses two or a conflicting league', async () => {
    await h.db
      .insertInto('season_team_parents')
      .values({ team_id: 'tem_account', season_id: 's1' })
      .execute()
    const refused = await h.db
      .insertInto('season_team_parents')
      .values({ team_id: 'tem_account', season_id: 's2' })
      .execute()
      .then(
        () => null,
        (error: unknown) => error
      )
    expect(refused).property('code', '23514')
    expect(
      await h.db.selectFrom('season_team_parents').selectAll().execute()
    ).length(1)
    const mismatch = await h.db
      .updateTable('teams')
      .set({ league_id: 'l' })
      .where('id', '=', 'tem_account')
      .execute()
      .then(
        () => null,
        (error: unknown) => error
      )
    expect(mismatch).property('code', '23514')
  })
  it('commits a consistent multi-parent transition and preserves participation on unlink', async () => {
    await h.db
      .insertInto('season_teams')
      .values({ team_id: 'tem_account', season_id: 's1' })
      .execute()
    await h.db.transaction().execute(async trx => {
      await trx
        .deleteFrom('season_team_parents')
        .where('team_id', '=', 'tem_account')
        .execute()
      await trx
        .updateTable('teams')
        .set({ league_id: 'l' })
        .where('id', '=', 'tem_account')
        .execute()
      await trx
        .insertInto('season_team_parents')
        .values([
          { team_id: 'tem_account', season_id: 'sl1' },
          { team_id: 'tem_account', season_id: 'sl2' }
        ])
        .execute()
    })
    expect(
      await h.db.selectFrom('season_team_parents').selectAll().execute()
    ).length(2)
    await h.db
      .deleteFrom('season_team_parents')
      .where('team_id', '=', 'tem_account')
      .execute()
    expect(await h.db.selectFrom('season_teams').selectAll().execute()).length(
      1
    )
  })
  it('enforces all parent writers, source uniqueness and receipt ownership', async () => {
    await h.db
      .insertInto('season_team_parents')
      .values({ team_id: 'tem_account', season_id: 'sl1' })
      .execute()
    const bad = await h.db
      .updateTable('seasons')
      .set({ league_id: null })
      .where('id', '=', 'sl1')
      .execute()
      .then(
        () => null,
        (error: unknown) => error
      )
    expect(bad).property('code', '23514')
    await h.db
      .insertInto('notification_events')
      .values({
        id: 'n',
        source_type: 'parent',
        source_id: 'r',
        revision: 1,
        actor_id: 101
      })
      .execute()
    const duplicate = await h.db
      .insertInto('notification_events')
      .values({
        id: 'n2',
        source_type: 'parent',
        source_id: 'r',
        revision: 1,
        actor_id: 101
      })
      .execute()
      .then(
        () => null,
        (error: unknown) => error
      )
    expect(duplicate).property('code', '23505')
    await h.db
      .insertInto('notification_receipts')
      .values({ event_id: 'n', user_id: 101 })
      .execute()
    expect(
      await h.db
        .selectFrom('notification_receipts')
        .selectAll()
        .where('user_id', '=', 102)
        .execute()
    ).length(0)
    expect(
      (
        await sql<{
          count: number
        }>`select count(*) from group_request_sides`.execute(h.db)
      ).rows[0].count
    ).equals(0)
  })
  it('serializes concurrent raw writes to the same standalone-parent team', async () => {
    await h.db
      .insertInto('teams')
      .values({ id: 'concurrent', name: 'Demo Visitors' })
      .execute()
    const results = await Promise.allSettled(
      ['s1', 's2'].map(async seasonId => {
        await h.db.transaction().execute(async trx => {
          await trx
            .insertInto('season_team_parents')
            .values({ team_id: 'concurrent', season_id: seasonId })
            .execute()
        })
      })
    )
    expect(results.filter(result => result.status === 'fulfilled')).length(1)
    expect(results.filter(result => result.status === 'rejected')).length(1)
    expect(
      await h.db
        .selectFrom('season_team_parents')
        .selectAll()
        .where('team_id', '=', 'concurrent')
        .execute()
    ).length(1)
  })
  it('retains a cancelled withdrawal only with an opponent attribution', async () => {
    await h.db
      .insertInto('games')
      .values({
        id: 'withdrawal',
        home_team_id: 'tem_account',
        away_team_id: 'concurrent',
        start_at: new Date()
      })
      .execute()
    const missing = await h.db
      .updateTable('games')
      .set({ cancellation_reason: 'withdrawal' })
      .where('id', '=', 'withdrawal')
      .execute()
      .then(
        () => null,
        (error: unknown) => error
      )
    expect(missing).property('code', '23514')
    await h.db
      .updateTable('games')
      .set({
        status: 'cancelled',
        cancellation_reason: 'withdrawal',
        withdrawn_at: new Date(),
        withdrawn_by_team_id: 'tem_account',
        withdrawn_by_user_id: 101
      })
      .where('id', '=', 'withdrawal')
      .execute()
    expect(
      await h.db
        .selectFrom('games')
        .select(['status', 'withdrawn_by_team_id'])
        .where('id', '=', 'withdrawal')
        .executeTakeFirstOrThrow()
    ).deep.equals({ status: 'cancelled', withdrawn_by_team_id: 'tem_account' })
  })
})
