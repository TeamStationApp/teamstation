import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { asGroupDetail } from '../../common/publicGroups'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('a league page lists its seasons, its teams and where they play', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  it('names the league seasons each team is in and the placeholders it keeps', async () => {
    await f.h.db
      .insertInto('season_teams')
      .values({ team_id: f.teamA, season_id: f.playoffs })
      .execute()
    // A competitor from another league plays in this league's season too,
    // and its own league is not this one's business.
    await f.h.db
      .insertInto('season_teams')
      .values({ team_id: f.teamB, season_id: f.seasonA })
      .execute()
    await f.h.db
      .insertInto('teams')
      .values({
        id: 'tem_kept_demo',
        name: 'Demo Placeholder',
        kind: 'external',
        custodian_type: 'league',
        custodian_id: f.leagueA
      })
      .execute()
    const response = await f.h.request(
      'GET',
      `/leagues/${f.leagueA}`,
      undefined,
      101
    )
    expect(response.status).equals(200)
    const detail = asGroupDetail(await response.json())
    expect(detail.children.map(child => child.id)).includes(f.teamA)
    expect(detail.children.map(child => child.id)).not.includes(f.teamB)
    expect(detail.keptTeams.map(team => team.id)).deep.equals(['tem_kept_demo'])
    expect(
      detail.teamSeasons.find(row => row.teamId === f.teamA)?.seasonIds
    ).deep.equals([f.seasonA, f.playoffs].sort())
    expect(detail.teamSeasons.some(row => row.teamId === f.teamB)).equals(false)
    expect(
      detail.teamSeasons.some(row => row.teamId === 'tem_kept_demo')
    ).equals(false)
  })
  it('leaves season and team detail without league-only lists', async () => {
    for (const path of [`/seasons/${f.seasonA}`, `/teams/${f.teamA}`]) {
      const detail = asGroupDetail(
        await (await f.h.request('GET', path, undefined, 101)).json()
      )
      expect(detail.keptTeams, path).deep.equals([])
      expect(detail.teamSeasons, path).deep.equals([])
    }
  })
})
