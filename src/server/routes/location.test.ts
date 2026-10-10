import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { locationRoutes } from './location'

describe('locality HTTP boundary', function () {
  this.timeout(60000)
  let h: AccountHarness
  before(async () => {
    h = await accountHarness(undefined, app => {
      app.use('/api/v1', locationRoutes())
    })
  })
  after(async () => {
    await h?.close()
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
