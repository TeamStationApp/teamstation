import { expect } from 'chai'
import { describe, it } from 'mocha'

import { rosterEditFixture } from '../../app/scoring/scoringRosterEdit.e2e.fixture'
import { asRosterEntry } from '../../common/api'
import { managesRoster } from '../../common/roles'
import { userIdOfGumbo } from '../../common/userId'

describe('scorekeeper roster-management exception', function () {
  this.timeout(60000)
  it('authorizes settings/full names independently of coaching and preserves basic names', async function () {
    const fixture = await rosterEditFixture('http://127.0.0.1:1', 0)
    const get = async (query: string): Promise<Response> =>
      await fetch(fixture.backendUrl + '/api/v1/teams/away/roster' + query)
    const put = async (team: string, userId = 100): Promise<Response> =>
      await fetch(
        fixture.backendUrl +
          `/api/v1/teams/${team}/players/${userIdOfGumbo(userId)}/settings`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jersey: '12',
            bats: 'switch',
            throws: 'left',
            positions: ['SS', '2B']
          })
        }
      )
    try {
      for (const scope of ['season', 'league'] as const) {
        await fixture.roles(['scorekeeper'], scope)
        expect((await get('?includeFullNames=true')).status).equals(200)
        expect((await put('away')).status).equals(200)
      }
      for (const role of ['scorekeeper', 'coach', 'admin'] as const) {
        await fixture.roles([role])
        expect(managesRoster({ teams: { away: [role] } }, 'away')).equals(true)
        const result = await get('?includeFullNames=true')
        expect(result.status).equals(200)
        const entries = ((await result.json()) as unknown[]).map(asRosterEntry)
        expect(
          entries.find(row => row.userId === userIdOfGumbo(100))?.nameDetails
            ?.displayName
        ).equals('Mookie Betts')
        expect((await put('away')).status).equals(200)
        expect((await put('other')).status).equals(404)
        expect((await put('away', 900)).status).equals(404)
      }
      for (const role of ['songkeeper', 'videographer'] as const) {
        await fixture.roles([role])
        expect((await get('?includeFullNames=true')).status).equals(404)
        expect((await put('away')).status).equals(404)
      }
      await fixture.roles(['scorekeeper'])
      for (const query of ['', '?includeFullNames=false']) {
        const entries = (await (await get(query)).json()) as Array<
          Record<string, unknown>
        >
        expect(
          entries.find(row => row.userId === userIdOfGumbo(100))?.shortName
        ).equals('Mookie B')
        expect(entries.every(row => row.nameDetails == null)).equals(true)
      }
      for (const query of [
        '?includeFullNames=1',
        '?includeFullNames=true&includeFullNames=false'
      ])
        expect((await get(query)).status).equals(400)
      await fixture.roles([])
      expect((await get('?includeFullNames=true')).status).equals(404)
      expect((await put('away')).status).equals(404)
      expect(managesRoster(undefined, 'away')).equals(false)
      expect(
        managesRoster({ teams: { away: ['scorekeeper'] } }, 'other')
      ).equals(false)
      expect(managesRoster({ teams: {} }, undefined)).equals(false)
    } finally {
      await fixture.close()
    }
  })
})
