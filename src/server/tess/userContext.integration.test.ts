import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { contextText } from './prompt'
import { userContext } from './userContext'

/**
 * Who Tess is answering, read from the database: the person's public name,
 * their teams with their roles, what they administer and umpire, and the
 * players they guard. Never a whole name or an e-mail address.
 */
describe("Tess's user context", function () {
  this.timeout(60000)
  let h: AccountHarness
  const babe = userIdOfGumbo(101)
  const lou = userIdOfGumbo(102)

  before(async () => {
    h = await accountHarness()
    const { db } = h
    await db
      .insertInto('leagues')
      .values([
        { id: 'lea_demo', name: 'Demo League', umpire_management: true },
        { id: 'lea_other', name: 'Other League' }
      ])
      .execute()
    await db
      .insertInto('seasons')
      .values({
        id: 'sea_demo',
        name: 'Demo Spring',
        year: 2026,
        starts_on: '2026-03-01',
        ends_on: '2026-06-30',
        league_id: 'lea_other'
      })
      .execute()
    await db
      .insertInto('teams')
      .values({ id: 'tem_coach', name: 'Demo Eagles', short_name: 'Eagles' })
      .execute()
    await db
      .insertInto('scope_roles')
      .values([
        {
          id: 'rol_coach',
          user_id: babe,
          scope_type: 'team',
          scope_id: 'tem_coach',
          role: 'coach',
          granted_by: null
        },
        {
          id: 'rol_season',
          user_id: babe,
          scope_type: 'season',
          scope_id: 'sea_demo',
          role: 'admin',
          granted_by: null
        },
        {
          id: 'rol_league',
          user_id: babe,
          scope_type: 'league',
          scope_id: 'lea_other',
          role: 'admin',
          granted_by: null
        }
      ])
      .execute()
    await db
      .insertInto('league_umpires')
      .values({ league_id: 'lea_demo', user_id: babe, granted_by: babe })
      .execute()
    await db
      .insertInto('user_links')
      .values({
        id: 'lnk_guardian',
        user_id: babe,
        related_user_id: lou,
        kind: 'guardian'
      })
      .execute()
  })
  after(async () => {
    await h?.close()
  })

  it('names the person, their teams and roles, what they run, umpire and guard', async () => {
    const context = await userContext(h.db, babe, false)
    expect(context.userId).equals(babe)
    expect(context.name).equals('Babe R.')
    expect(context.siteAdmin).equals(false)
    expect(context.teams).deep.equals([
      {
        teamId: 'tem_coach',
        name: 'Demo Eagles',
        shortName: 'Eagles',
        roles: ['coach']
      },
      {
        teamId: 'tem_account',
        name: 'Demo Hawks',
        shortName: 'Demo Hawks',
        roles: ['player']
      }
    ])
    expect(context.seasonsAdministered).deep.equals([
      { seasonId: 'sea_demo', name: 'Demo Spring' }
    ])
    expect(context.leaguesAdministered).deep.equals([
      { leagueId: 'lea_other', name: 'Other League' }
    ])
    expect(context.umpireLeagues).deep.equals([
      { leagueId: 'lea_demo', name: 'Demo League' }
    ])
    expect(context.guardianOf).deep.equals([{ userId: lou, name: 'Lou G.' }])
  })

  it('never puts a whole name or an e-mail address in the prompt', async () => {
    const text = contextText({
      user: await userContext(h.db, babe, false)
    })
    expect(text).includes('Babe R.')
    expect(text).includes('Lou G.')
    for (const secret of [
      'Babe Ruth',
      'Ruth',
      'Lou Gehrig',
      'Gehrig',
      '@example.com'
    ])
      expect(text, secret).not.includes(secret)
  })

  it('reads somebody with nothing as an empty context, and a site admin as one', async () => {
    const context = await userContext(h.db, lou, false)
    expect(context).deep.include({
      name: 'Lou G.',
      siteAdmin: false,
      teams: [],
      seasonsAdministered: [],
      leaguesAdministered: [],
      umpireLeagues: [],
      guardianOf: []
    })
    await h.db
      .updateTable('users')
      .set({ is_admin: true })
      .where('id', '=', lou)
      .execute()
    expect((await userContext(h.db, lou, true)).siteAdmin).equals(true)
    // A row that is gone reads as nobody, not as an error.
    expect((await userContext(h.db, 'usr_gone', false)).name).equals(
      'Staff member'
    )
  })
})
