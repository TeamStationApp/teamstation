import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { actor, type GroupFixture } from '../../test/groupFixtures'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { umpireAffiliations } from './affiliations'
import { umpireIdentity } from './context'
import { schedule } from './schedule'

describe('season-specific umpire affiliations and destinations', function () {
  this.timeout(60000)
  let f: GroupFixture, old: string | undefined
  before(async () => {
    old = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture()
    const db = f.h.db
    await db
      .insertInto('teams')
      .values(
        ['member', 'admin', 'other', 'nonplayer', 'inactive', 'family'].map(
          id => ({ id: `tem_aff_${id}`, name: `Demo ${id}` })
        )
      )
      .execute()
    await db
      .insertInto('season_teams')
      .values(
        ['member', 'admin', 'nonplayer', 'inactive', 'family'].map(id => ({
          season_id: f.seasonA,
          team_id: `tem_aff_${id}`,
          active: id !== 'inactive'
        }))
      )
      .execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: f.playoffs, team_id: 'tem_aff_other', active: true })
      .execute()
    await db
      .insertInto('memberships')
      .values([
        {
          id: 'mem_aff_self',
          team_id: 'tem_aff_member',
          user_id: userIdOfGumbo(103),
          is_player: false
        },
        {
          id: 'mem_aff_other',
          team_id: 'tem_aff_other',
          user_id: userIdOfGumbo(103),
          is_player: true
        },
        {
          id: 'mem_aff_inactive',
          team_id: 'tem_aff_inactive',
          user_id: userIdOfGumbo(103),
          is_player: true
        },
        {
          id: 'mem_aff_nonplayer',
          team_id: 'tem_aff_nonplayer',
          user_id: userIdOfGumbo(104),
          is_player: false
        },
        {
          id: 'mem_aff_family',
          team_id: 'tem_aff_family',
          user_id: userIdOfGumbo(106),
          is_player: true
        }
      ])
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: 'rol_aff_admin',
        scope_type: 'team',
        scope_id: 'tem_aff_admin',
        user_id: userIdOfGumbo(103),
        role: 'admin'
      })
      .execute()
    await db
      .insertInto('user_links')
      .values([
        {
          id: 'lnk_aff_guardian',
          user_id: userIdOfGumbo(103),
          related_user_id: userIdOfGumbo(104),
          kind: 'guardian'
        },
        {
          id: 'lnk_aff_family',
          user_id: userIdOfGumbo(103),
          related_user_id: userIdOfGumbo(106),
          kind: 'family'
        }
      ])
      .execute()
    await db
      .insertInto('umpire_assignments')
      .values({
        game_id: 'gam_umpire',
        slot: 'uty_plate:1',
        user_id: userIdOfGumbo(103),
        assigned_by: userIdOfGumbo(101)
      })
      .execute()
  })
  after(async () => {
    await f?.h.close()
    if (old == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = old
  })
  it('includes direct nonplayer members and guardians of players, excludes roles alone and other seasons', async () => {
    const resolver = await umpireAffiliations(f.h.db, f.leagueA)
    const p = await umpireIdentity(f.h.db, userIdOfGumbo(103))
    const teams = await resolver(p, f.seasonA)
    expect(teams.map(t => t.id).sort()).deep.equals(
      [f.teamA, 'tem_aff_member'].sort()
    )
    expect(await resolver(p, f.seasonA)).equals(teams)
    expect((await resolver(p, f.playoffs)).map(t => t.id)).deep.equals([
      'tem_aff_other'
    ])
    expect(await resolver(p, f.seasonB)).deep.equals([])
  })
  it('unions merged membership and guardian identities, deduplicates teams and omits disabled children', async () => {
    await f.h.db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(103) })
      .where('id', '=', userIdOfGumbo(105))
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'mem_aff_alias',
        team_id: 'tem_aff_member',
        user_id: userIdOfGumbo(105)
      })
      .execute()
    await f.h.db
      .updateTable('user_links')
      .set({ user_id: userIdOfGumbo(105) })
      .where('id', '=', 'lnk_aff_guardian')
      .execute()
    const p = await umpireIdentity(f.h.db, userIdOfGumbo(105))
    expect(
      (await (await umpireAffiliations(f.h.db, f.leagueA))(p, f.seasonA))
        .map(t => t.id)
        .sort()
    ).deep.equals([f.teamA, 'tem_aff_member'].sort())
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', userIdOfGumbo(104))
      .execute()
    expect(
      (await (await umpireAffiliations(f.h.db, f.leagueA))(p, f.seasonA)).map(
        t => t.id
      )
    ).deep.equals(['tem_aff_member'])
  })
  it('returns real team ids, season affiliations and coordinates, address or venue fallback', async () => {
    await f.h.db
      .updateTable('games')
      .set({ latitude: 34.1, longitude: -118.2, address: 'Demo Park & Field' })
      .where('id', '=', 'gam_umpire')
      .execute()
    let row = (await schedule(f.h.db, actor(101), f.leagueA, 'league', {}))
      .games[0]
    expect(row).includes({
      homeTeamId: f.teamA,
      awayTeamId: f.teamB,
      location: '34.1,-118.2'
    })
    expect(row.assignments['uty_plate:1'].teams!.map(t => t.id)).deep.equals([
      'tem_aff_member'
    ])
    await f.h.db
      .updateTable('games')
      .set({ latitude: null, longitude: null })
      .where('id', '=', 'gam_umpire')
      .execute()
    row = (await schedule(f.h.db, actor(101), f.leagueA, 'league', {})).games[0]
    expect(row.location).equals('Demo Park & Field')
    await f.h.db
      .updateTable('games')
      .set({ address: ' ', venue: 'Demo Field' })
      .where('id', '=', 'gam_umpire')
      .execute()
    expect(
      (await schedule(f.h.db, actor(101), f.leagueA, 'league', {})).games[0]
        .location
    ).equals('Demo Field')
    await f.h.db
      .updateTable('games')
      .set({ venue: null })
      .where('id', '=', 'gam_umpire')
      .execute()
    expect(
      (await schedule(f.h.db, actor(101), f.leagueA, 'league', {})).games[0]
        .location
    ).equals('')
  })
})
