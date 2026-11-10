import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { asParentActions } from '../../common/groupLinks'
import { userIdOfGumbo } from '../../common/userId'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { roleScopes, visibleScopes } from '../access'
import { applyParents, previewParents } from './relationships'

describe('management parents independent of competition and games', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  it('supports matching regular/playoff parents and rejects conflicting league or two standalone parents', async () => {
    const actions = asParentActions([
      {
        operation: 'attach',
        child: { kind: 'team', id: f.teamA },
        parent: { kind: 'season', id: f.playoffs }
      }
    ])
    const preview = await previewParents(f.h.db, actions)
    await applyParents(f.h.db, [actor(101)], preview)
    expect(
      await f.h.db
        .selectFrom('season_team_parents')
        .selectAll()
        .where('team_id', '=', f.teamA)
        .execute()
    ).length(2)
    const conflicting = await previewParents(
      f.h.db,
      asParentActions([
        {
          operation: 'attach',
          child: { kind: 'team', id: f.teamA },
          parent: { kind: 'season', id: f.seasonB }
        }
      ])
    ).then(
      () => null,
      (error: unknown) => error
    )
    expect(conflicting).property('code', 'conflict')
    const first = await previewParents(
      f.h.db,
      asParentActions([
        {
          operation: 'attach',
          child: { kind: 'team', id: f.standaloneTeam },
          parent: { kind: 'season', id: f.standaloneSeason }
        }
      ])
    )
    await applyParents(f.h.db, [actor(103)], first)
    await f.h.db
      .insertInto('seasons')
      .values({
        starts_on: `2027-03-01`,
        ends_on: `2027-05-31`,
        id: 'anotherStandalone',
        name: 'Demo Other Standalone',
        year: 2027,
        league_id: null
      })
      .execute()
    expect(
      await previewParents(
        f.h.db,
        asParentActions([
          {
            operation: 'attach',
            child: { kind: 'team', id: f.standaloneTeam },
            parent: { kind: 'season', id: 'anotherStandalone' }
          }
        ])
      ).then(
        () => null,
        (error: unknown) => error
      )
    ).property('code', 'conflict')
    expect(() => asParentActions([])).throws(TypeError)
    expect(() =>
      asParentActions([
        {
          operation: 'attach',
          child: { kind: 'league', id: f.leagueA },
          parent: { kind: 'league', id: f.leagueB }
        }
      ])
    ).throws(TypeError)
  })
  it('allows either endpoint admin to break only the permission edges', async () => {
    await f.h.db
      .insertInto('season_teams')
      .values({ team_id: f.teamA, season_id: f.seasonB })
      .execute()
    await f.h.db
      .insertInto('games')
      .values({
        id: 'fixture-history',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonB,
        start_at: new Date()
      })
      .execute()
    const beforeMembership = await f.h.db
      .selectFrom('season_teams')
      .selectAll()
      .where('team_id', '=', f.teamA)
      .execute()
    const beforeGames = await f.h.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', 'fixture-history')
      .execute()
    const preview = await previewParents(
      f.h.db,
      asParentActions([
        {
          operation: 'detach',
          child: { kind: 'team', id: f.teamA },
          parent: { kind: 'league', id: f.leagueA }
        }
      ])
    )
    expect(
      preview.effects.filter(effect => effect.parent.kind === 'season')
    ).length(2)
    // The changes lead, one line per effect, ahead of what is preserved.
    const changes = preview.explanation.slice(0, preview.effects.length)
    expect(changes).length(3)
    for (const line of changes)
      expect(line).matches(/^Remove .+ as parent of Demo Hawks$/)
    expect(
      changes.some(line => line.startsWith('Remove Demo League A '))
    ).equals(true)
    expect(preview.explanation[preview.effects.length]).matches(
      /^Only management permissions change/
    )
    expect(
      await applyParents(f.h.db, [actor(106)], preview).then(
        () => null,
        (error: unknown) => error
      )
    ).property('code', 'forbidden')
    await applyParents(f.h.db, [actor(101)], preview)
    expect(
      await f.h.db
        .selectFrom('season_team_parents')
        .selectAll()
        .where('team_id', '=', f.teamA)
        .execute()
    ).length(0)
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .selectAll()
        .where('team_id', '=', f.teamA)
        .execute()
    ).deep.equals(beforeMembership)
    expect(
      await f.h.db
        .selectFrom('games')
        .selectAll()
        .where('id', '=', 'fixture-history')
        .execute()
    ).deep.equals(beforeGames)
  })
  it('never widens private scopes through competition, even with spectator settings', async () => {
    await f.h.db
      .updateTable('seasons')
      .set({ spectator_access: 'season' })
      .where('id', '=', f.seasonB)
      .execute()
    await f.h.db
      .updateTable('leagues')
      .set({ spectator_access: 'league' })
      .where('id', '=', f.leagueB)
      .execute()
    const scopes = await visibleScopes(f.h.db, userIdOfGumbo(101), false)
    expect(scopes.teamIds.has(f.teamB)).equals(false)
    expect(scopes.seasonIds.has(f.seasonB)).equals(false)
    const rights = await roleScopes(f.h.db, userIdOfGumbo(101), false)
    expect(rights.admin.teamIds.has(f.teamB)).equals(false)
    expect(rights.admin.teamIds.has(f.teamA)).equals(true) // direct creator grant survives unlink.
  })
  it('rejects stale previews and validates either-side rights without implicit ownership moves', async () => {
    const actions = asParentActions([
      {
        operation: 'attach',
        child: { kind: 'team', id: f.teamA },
        parent: { kind: 'league', id: f.leagueA }
      }
    ])
    const preview = await previewParents(f.h.db, actions)
    await applyParents(f.h.db, [actor(101)], preview)
    expect(
      await applyParents(f.h.db, [actor(101)], preview).then(
        () => null,
        (error: unknown) => error
      )
    ).property('code', 'conflict')
    const detachSeason = await previewParents(
      f.h.db,
      asParentActions([
        {
          operation: 'detach',
          child: { kind: 'season', id: f.seasonA },
          parent: { kind: 'league', id: f.leagueA }
        }
      ])
    )
    await applyParents(f.h.db, [actor(101)], detachSeason)
    expect(
      (
        await f.h.db
          .selectFrom('seasons')
          .select('league_id')
          .where('id', '=', f.seasonA)
          .executeTakeFirstOrThrow()
      ).league_id
    ).equals(null)
  })
  it('applies removals before additions for team and season moves in both identity sort directions', async () => {
    const memberships = await f.h.db
      .selectFrom('season_teams')
      .selectAll()
      .execute()
    const games = await f.h.db.selectFrom('games').selectAll().execute()
    await applyParents(
      f.h.db,
      [actor(101)],
      await previewParents(
        f.h.db,
        asParentActions([
          {
            operation: 'attach',
            child: { kind: 'season', id: f.seasonA },
            parent: { kind: 'league', id: f.leagueA }
          }
        ])
      )
    )
    for (const [from, to] of [
      [f.leagueA, f.leagueB],
      [f.leagueB, f.leagueA]
    ]) {
      const children = [
        { kind: 'team' as const, id: f.teamA },
        { kind: 'season' as const, id: f.seasonA }
      ]
      const preview = await previewParents(
        f.h.db,
        asParentActions([
          ...children.map(child => ({
            operation: 'detach',
            child,
            parent: { kind: 'league', id: from }
          })),
          ...children.map(child => ({
            operation: 'attach',
            child,
            parent: { kind: 'league', id: to }
          }))
        ])
      )
      await applyParents(f.h.db, [actor(101), actor(102)], preview)
      for (const child of children)
        expect(
          (
            await f.h.db
              .selectFrom(child.kind === 'team' ? 'teams' : 'seasons')
              .select('league_id')
              .where('id', '=', child.id)
              .executeTakeFirstOrThrow()
          ).league_id
        ).equals(to)
    }
    expect(
      await f.h.db.selectFrom('season_teams').selectAll().execute()
    ).deep.equals(memberships)
    expect(await f.h.db.selectFrom('games').selectAll().execute()).deep.equals(
      games
    )
  })
})
