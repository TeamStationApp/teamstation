import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { fullName, shortName } from '../../common/names'
import { asUmpireSchedule } from '../../common/umpireCleaners'
import { userIdOfGumbo } from '../../common/userId'
import { actor, type GroupFixture } from '../../test/groupFixtures'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { gameUmpires } from './assignments'
import { schedule } from './schedule'

// An umpire is named in full to a reader who may read their full name (the
// umpire themself, a guardian, the site admin) and short to anyone else, on
// the game's umpires, the umpire schedule and the leaderboard.
describe('umpire names for their reader', function () {
  this.timeout(60000)
  let f: GroupFixture
  let old: string | undefined
  const umpire = userIdOfGumbo(104)
  const full = 'Ichiro Suzuki'
  const short = 'Ichiro S'
  before(async () => {
    old = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture()
    const db = f.h.db
    await db
      .updateTable('users')
      .set({ first_name: 'Ichiro', last_name: 'Suzuki', display_name: full })
      .where('id', '=', umpire)
      .execute()
    // 103, an umpire of the league, is a guardian of the umpire and nothing
    // else; 106, an umpire of the league and a player on the other team, is a
    // stranger to them.
    await db
      .insertInto('user_links')
      .values({
        id: 'lnk_umpire_names',
        user_id: userIdOfGumbo(103),
        related_user_id: umpire,
        kind: 'guardian'
      })
      .execute()
    await db
      .insertInto('league_umpires')
      .values(
        [103, 106].map(id => ({
          league_id: f.leagueA,
          user_id: userIdOfGumbo(id),
          granted_by: userIdOfGumbo(101)
        }))
      )
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_umpire_names',
        team_id: f.teamB,
        user_id: userIdOfGumbo(106),
        is_player: true,
        role: 'member'
      })
      .execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: f.seasonA, team_id: f.teamB, active: true })
      .onConflict(oc => oc.doNothing())
      .execute()
    await db
      .insertInto('umpire_assignments')
      .values({
        game_id: 'gam_umpire',
        slot: 'uty_plate:1',
        user_id: umpire,
        assigned_by: umpire
      })
      .execute()
  })
  after(async () => {
    await f?.h.close()
    if (old == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = old
  })
  const json = async (path: string, user: number): Promise<any> => {
    const response = await f.h.request('GET', path, undefined, user)
    expect(response.status, `${path} as ${user}`).equals(200)
    return await response.json()
  }
  const gameName = async (user: number): Promise<string> =>
    (await json('/games/gam_umpire', user)).umpires.positions.find(
      (p: { slot: string }) => p.slot === 'uty_plate:1'
    ).person.name

  it("names the game's umpire in full to the umpire, a guardian and the site admin, and short to a stranger", async () => {
    expect(await gameName(104)).equals(full)
    expect(await gameName(103)).equals(full)
    expect(await gameName(105)).equals(full)
    expect(await gameName(106)).equals(short)
    // With no reader, as a write or a stored answer reads it, it stays short.
    expect(
      (await gameUmpires(f.h.db, 'gam_umpire'))!.positions.find(
        p => p.slot === 'uty_plate:1'
      )!.person!.name
    ).equals(short)
  })

  it('names the assignment, conflicts and choices of the umpire schedule to its reader', async () => {
    const row = async (user: number): Promise<any> =>
      asUmpireSchedule(
        await json(`/leagues/${f.leagueA}/umpire-schedule?view=umpire`, user)
      ).games.find(g => g.id === 'gam_umpire')!
    for (const user of [104, 103]) {
      const game = await row(user)
      expect(game.assignments['uty_plate:1'].name, `as ${user}`).equals(full)
      // The umpire's own conflict (they play in the game) and choices, which
      // the guardian reads for their child too.
      const conflict = game.conflicts.find(
        (c: { userId: string }) => c.userId === umpire
      )
      expect(conflict?.name, `conflict as ${user}`).equals(full)
      const choice = Object.values(game.choices)
        .flat()
        .find((c: any) => c.userId === umpire) as { name: string } | undefined
      expect(choice?.name, `choice as ${user}`).equals(full)
    }
    const stranger = await row(106)
    expect(stranger.assignments['uty_plate:1'].name).equals(short)
    // The paged schedule reads the same names.
    const page = await json(
      `/leagues/${f.leagueA}/umpire-schedule?view=umpire&paged=1`,
      104
    )
    expect(
      page.items.find((g: { id: string }) => g.id === 'gam_umpire').assignments[
        'uty_plate:1'
      ].name
    ).equals(full)
    // Without a reader, as a signup's checks read it, the schedule is short.
    expect(
      (await schedule(f.h.db, actor(104), f.leagueA, 'umpire', {})).games.find(
        g => g.id === 'gam_umpire'
      )!.assignments['uty_plate:1'].name
    ).equals(short)
  })

  it('names the top ten of the leaderboard to its reader', async () => {
    const named = async (user: number): Promise<string | undefined> =>
      (
        await json(`/leagues/${f.leagueA}/umpire-leaderboard`, user)
      ).scheduled.find((p: { userId: string }) => p.userId === umpire)?.name
    expect(await named(104)).equals(full)
    expect(await named(106)).equals(short)
    // A page lists the league's umpires with no assignment too, read from
    // their accounts only for the reader who reads them in full.
    const guardian = await f.h.db
      .selectFrom('users')
      .select(['id', 'first_name', 'last_name', 'display_name'])
      .where('id', '=', userIdOfGumbo(103))
      .executeTakeFirstOrThrow()
    const listed = async (user: number): Promise<string | undefined> =>
      (
        await json(`/leagues/${f.leagueA}/umpire-leaderboard?limit=50`, user)
      ).scheduled.find((p: { userId: string }) => p.userId === guardian.id)
        ?.name
    expect(await listed(105)).equals(
      fullName({
        id: guardian.id,
        firstName: guardian.first_name,
        lastName: guardian.last_name,
        displayName: guardian.display_name
      })
    )
    expect(await listed(101)).equals(
      shortName({
        id: guardian.id,
        firstName: guardian.first_name,
        lastName: guardian.last_name,
        displayName: guardian.display_name
      })
    )
  })
})
