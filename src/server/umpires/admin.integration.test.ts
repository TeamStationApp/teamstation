import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { umpireLevelHint, umpireLevelName } from '../../common/umpires'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import {
  fixtureCounts,
  fixturePositions,
  seedUmpireTypes
} from '../../test/umpireTypes'
import { umpireRoutes } from '../routes/umpires'
import { people } from './admin'

describe('umpire levels, needs and certification', function () {
  this.timeout(60000)
  let f: GroupFixture
  let major: string
  let minor: string
  const person = userIdOfGumbo(101)
  const request = async (
    method: string,
    suffix: string,
    body?: unknown
  ): Promise<Response> =>
    await f.h.request(method, `/leagues/${f.leagueA}/${suffix}`, body, 101)
  before(async () => {
    f = await groupFixture(undefined, undefined, (app, { db }) => {
      app.use('/api/v1', umpireRoutes(db))
    })
    await seedUmpireTypes(f.h.db, f.leagueA)
  })
  before(async () => {
    await f.h.db
      .insertInto('league_members')
      .values({
        id: 'lmb_umpire_admin',
        league_id: f.leagueA,
        user_id: person,
        role: 'member',
        source: 'manual'
      })
      .execute()
  })
  after(async () => {
    await f?.h.close()
  })
  it('cycles hints and validates names without changing capitalization', () => {
    expect(umpireLevelHint([])).equals('majors')
    expect(umpireLevelHint(['MAJORS'])).equals('minors')
    expect(umpireLevelHint(['majors', 'minors', 'aa'])).equals('AAA')
    expect(umpireLevelHint(['custom'])).equals('majors')
    expect(
      umpireLevelHint([
        'majors',
        'minors',
        'aa',
        'aaa',
        'intermediate',
        'juniors',
        'high school',
        'college'
      ])
    ).equals('Level name')
    for (const name of ['', ' ', null, 'x'.repeat(101)])
      expect(() => umpireLevelName(name, [])).throws()
    expect(() => umpireLevelName('MAJORS', ['majors'])).throws()
    expect(umpireLevelName('  Juniors ', [])).equals('Juniors')
    expect(fixturePositions(false, 0).map(p => p.slot)).deep.equals([])
    expect(fixturePositions(true, 2).map(p => p.slot)).deep.equals([
      'uty_plate:1',
      'uty_field:1',
      'uty_field:2'
    ])
  })
  it('adds unique levels, lists upcoming seasons, and refuses cross-league or malformed needs', async () => {
    major = (
      await (await request('POST', 'umpire-levels', { name: 'majors' })).json()
    ).id
    minor = (
      await (await request('POST', 'umpire-levels', { name: 'minors' })).json()
    ).id
    expect(
      (await request('POST', 'umpire-levels', { name: 'MAJORS' })).status
    ).equals(400)
    expect(
      (await request('POST', 'umpire-levels', { name: ' ' })).status
    ).equals(400)
    expect(
      (await (await request('GET', 'umpire-levels')).json()).levels
    ).length(2)
    expect(
      (await (await request('GET', 'umpire-requirements')).json()).seasons.some(
        (s: any) => s.id === f.seasonA && s.requirement == null
      )
    ).equals(true)
    for (const body of [
      {},
      { seasonIds: [f.seasonB], levelId: major, types: fixtureCounts(true, 1) },
      { seasonIds: [f.seasonA], levelId: major, types: fixtureCounts(true, 7) }
    ])
      expect((await request('PUT', 'umpire-requirements', body)).status).equals(
        400
      )
    expect(
      (
        await request('PUT', 'umpire-requirements', {
          seasonIds: [f.seasonA],
          levelId: 'missing',
          types: fixtureCounts(true, 1)
        })
      ).status
    ).equals(404)
    expect(
      (
        await request('PUT', 'umpire-requirements', {
          seasonIds: [f.seasonA],
          levelId: major,
          types: fixtureCounts(true, 2)
        })
      ).status
    ).equals(200)
    const usage = (await (await request('GET', 'umpire-levels')).json()).levels
    expect(usage.find((l: any) => l.id === major).inUse).equals(true)
    expect(usage.find((l: any) => l.id === minor).inUse).equals(false)
    const rows = (await (await request('GET', 'umpire-requirements')).json())
      .seasons
    expect(rows.find((s: any) => s.id === f.seasonA).requirement).deep.equals({
      levelId: major,
      levelName: 'majors',
      types: fixtureCounts(true, 2)
    })
  })
  it('searches affiliations, grants canonical people, and preserves certifications on revoke', async () => {
    expect(
      (await (await request('GET', 'umpire-candidates?q=')).json()).people
    ).deep.equals([])
    const candidates = (
      await (await request('GET', 'umpire-candidates?q=Babe')).json()
    ).people
    expect(candidates.some((p: any) => p.id === person)).equals(true)
    expect(
      (await request('POST', 'umpires', { userId: person })).status
    ).equals(200)
    expect(
      (await request('POST', 'umpires', { userId: person })).status
    ).equals(200)
    expect(
      (await request('POST', 'umpires', { userId: 'missing' })).status
    ).equals(404)
    expect((await request('POST', 'umpires', {})).status).equals(400)
    expect(
      (
        await request('PUT', `umpires/${person}/certifications`, {
          levelId: major,
          typeId: 'uty_plate',
          enabled: true
        })
      ).status
    ).equals(200)
    expect(
      (await request('PUT', `umpires/${person}/certifications`, {})).status
    ).equals(400)
    expect(
      (await (await request('GET', 'umpires')).json()).people[0].certifications
    ).deep.equals([{ levelId: major, typeId: 'uty_plate', enabled: true }])
    expect(
      (await (await request('GET', 'umpire-candidates?q=Babe')).json()).people
    ).deep.equals([])
    expect((await request('DELETE', `umpires/${person}`)).status).equals(200)
    expect(
      await f.h.db
        .selectFrom('umpire_certifications')
        .selectAll()
        .where('user_id', '=', person)
        .execute()
    ).length(1)
    expect(
      (
        await request('PUT', `umpires/${person}/certifications`, {
          levelId: major,
          typeId: 'uty_plate',
          enabled: true
        })
      ).status
    ).equals(400)
    expect(
      (await request('POST', 'umpires', { userId: person })).status
    ).equals(200)
    expect(
      (await (await request('GET', 'umpires')).json()).people[0]
        .certifications[0].enabled
    ).equals(true)
  })
  it('loads candidate identities in a bounded number of queries', async () => {
    let queries = 0
    const db = f.h.db.withPlugin({
      transformQuery({ node }) {
        queries += 1
        return node
      },
      async transformResult({ result }) {
        return result
      }
    })
    await people(db, f.leagueA, 'Babe')
    expect(queries).lessThan(12)
  })
  it('shrinks only obsolete slots, preserves slots on level change, and clears used levels', async () => {
    await f.h.db
      .insertInto('games')
      .values({
        id: 'gam_needs',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date()
      })
      .execute()
    await f.h.db
      .insertInto('umpire_assignments')
      .values(
        ['uty_plate:1', 'uty_field:1', 'uty_field:2'].map((slot, i) => ({
          game_id: 'gam_needs',
          slot,
          user_id: userIdOfGumbo(101 + i),
          assigned_by: person,
          credit_team_id: f.teamA
        }))
      )
      .execute()
    await request('PUT', 'umpire-requirements', {
      seasonIds: [f.seasonA],
      levelId: minor,
      types: fixtureCounts(false, 1)
    })
    expect(
      (
        await f.h.db.selectFrom('umpire_assignments').select('slot').execute()
      ).map(r => r.slot)
    ).deep.equals(['uty_field:1'])
    await request('DELETE', `umpire-levels/${major}`)
    expect(
      await f.h.db.selectFrom('umpire_certifications').selectAll().execute()
    ).length(0)
    await request('DELETE', `umpire-levels/${minor}`)
    expect(
      await f.h.db.selectFrom('umpire_assignments').selectAll().execute()
    ).length(0)
    expect(
      await f.h.db
        .selectFrom('season_umpire_requirements')
        .selectAll()
        .execute()
    ).length(0)
    expect((await request('DELETE', `umpire-levels/${minor}`)).status).equals(
      404
    )
  })
})
