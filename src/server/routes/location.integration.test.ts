import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { locationRoutes } from './location'

describe('locality HTTP boundary', function () {
  this.timeout(60000)
  let h: AccountHarness
  before(async () => {
    h = await accountHarness(undefined, app => {
      app.use(
        '/api/v1',
        locationRoutes({
          search: async (query, kind) => [
            {
              id: 'demo',
              name: kind === 'venue' ? 'Demo Park' : null,
              address: `${query}, Demo City`
            }
          ]
        })
      )
    })
  })
  after(async () => {
    await h?.close()
  })
  it('keeps city search public while authorizing mapping searches and validating parameters', async () => {
    expect(
      (
        await h.request(
          'GET',
          '/locations?kind=venue&query=Demo',
          undefined,
          null
        )
      ).status
    ).equals(401)
    const response = await h.request('GET', '/locations?kind=venue&query=Demo')
    expect(response.status).equals(200)
    expect(await response.json()).deep.equals({
      places: [{ id: 'demo', name: 'Demo Park', address: 'Demo, Demo City' }],
      provider: 'openstreetmap',
      attribution: '© OpenStreetMap contributors'
    })
    const client = new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      token: h.tokens.get(101)
    })
    expect(await client.eventPlaces('Demo', 'venue')).deep.equals([
      { id: 'demo', name: 'Demo Park', address: 'Demo, Demo City' }
    ])
    expect(
      (
        await (
          await h.request('GET', '/locations?kind=address&query=1%20Demo%20Way')
        ).json()
      ).places[0].name
    ).equals(null)
    for (const path of [
      '/locations?kind=bad&query=Demo',
      '/locations?kind=venue',
      '/locations?kind=venue&kind=address&query=Demo',
      '/locations?kind=venue&query=' + 'x'.repeat(121)
    ])
      expect((await h.request('GET', path)).status).equals(400)
  })
  it('searches public cities and does not persist or serialize submitted coordinates', async () => {
    const found = await h.request(
      'GET',
      '/locations?query=York',
      undefined,
      null
    )
    expect(found.status).equals(200)
    expect(((await found.json()) as { places: unknown[] }).places).not.length(0)
    const nearest = await h.request(
      'POST',
      '/location-suggestions',
      { latitude: 0, longitude: 0 },
      null
    )
    expect(nearest.status).equals(200)
    const result = (await nearest.json()) as { place: Record<string, unknown> }
    expect(result.place).property('city')
    expect(result.place).not.property('latitude')
    expect(result.place).not.property('longitude')
    for (const [method, url, body] of [
      ['GET', '/locations', undefined],
      ['GET', '/locations?query=' + 'x'.repeat(121), undefined],
      ['POST', '/location-suggestions', {}],
      ['POST', '/location-suggestions', { latitude: 100, longitude: 0 }]
    ] as const)
      expect((await h.request(method, url, body, null)).status).equals(400)
  })
})
