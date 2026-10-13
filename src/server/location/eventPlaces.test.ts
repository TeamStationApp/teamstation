import { expect } from 'chai'
import { describe, it } from 'mocha'

import { eventPlaceSearch, photonPlaces, VENUE_TAGS } from './eventPlaces'

const poi = (id = 1): { properties: Record<string, string | number> } => ({
  properties: {
    osm_type: 'N',
    osm_id: id,
    osm_key: 'leisure',
    name: 'Demo Park',
    street: 'Demo Way',
    housenumber: '1',
    city: 'Demo City',
    state: 'Demo Region',
    country: 'Demo Country'
  }
})
describe('mapping place autocomplete', () => {
  it('suggests named venues, excludes streets/cities and deduplicates bounded results', () => {
    const street = {
      properties: { osm_key: 'highway', name: 'Demo Way', city: 'Demo City' }
    }
    const raw = {
      features: [
        null,
        {},
        { properties: null },
        poi(),
        poi(),
        street,
        { properties: { osm_key: 'place', name: 'Demo City' } },
        { properties: { osm_key: 'leisure', name: '' } },
        ...Array.from({ length: 9 }, (_, i) => poi(i + 2))
      ]
    }
    const found = photonPlaces(raw, 'venue')
    expect(found).length(5)
    expect(found[0]).includes({
      name: 'Demo Park',
      address: '1 Demo Way, Demo City, Demo Region, Demo Country'
    })
    expect(photonPlaces({ features: [street] }, 'address')[0]).includes({
      name: null,
      address: 'Demo Way, Demo City'
    })
    expect(photonPlaces({ features: [poi()] }, 'address')[0].name).equals(
      'Demo Park'
    )
    expect(
      photonPlaces(
        {
          features: [
            { properties: {} },
            { properties: { name: 'x'.repeat(501) } },
            { properties: { osm_key: 'shop', name: 'x'.repeat(201) } }
          ]
        },
        'venue'
      )
    ).length(0)
    for (const raw of [null, {}, { features: null }])
      expect(() => photonPlaces(raw, 'venue')).throws('unavailable')
    expect(
      photonPlaces(
        {
          features: [
            {
              properties: {
                osm_key: 'amenity',
                name: 'Demo Hall',
                locality: 'Demo Hamlet'
              }
            }
          ]
        },
        'venue'
      )[0].address
    ).equals('Demo Hall, Demo Hamlet')
  })
  it('deduplicates in-flight searches, uses named-POI filters and bounded expiring cache', async () => {
    let calls = 0
    let now = 1000
    const search = eventPlaceSearch({
      spacingMs: 0,
      now: () => now,
      url: 'https://example.test/api',
      fetch: async input => {
        calls++
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        )
        if (url.searchParams.get('q') === 'Demo')
          expect(url.searchParams.getAll('osm_tag')).deep.equals(
            calls === 2 ? [] : VENUE_TAGS
          )
        expect(url.searchParams.get('limit')).equals('10')
        return new Response(JSON.stringify({ features: [poi()] }))
      }
    })
    expect(await search.search('x', 'venue')).length(0)
    const [a, b] = await Promise.all([
      search.search('Demo', 'venue'),
      search.search('Demo', 'venue')
    ])
    expect(a).deep.equals(b)
    expect(calls).equals(1)
    await search.search(' demo ', 'venue')
    expect(calls).equals(1)
    await search.search('Demo', 'address')
    expect(calls).equals(2)
    now += 60001
    await search.search('Demo', 'venue')
    expect(calls).equals(3)
    for (let i = 0; i < 129; i++) await search.search(`Venue ${i}`, 'venue')
  })
  it('recovers from rejection, invalid JSON/status and malformed results', async () => {
    let mode = 0
    const search = eventPlaceSearch({
      spacingMs: 1,
      timeoutMs: 10,
      fetch: async (_input, options) => {
        expect(options?.signal).not.equals(undefined)
        if (mode++ === 0) throw new Error('offline')
        if (mode === 2) return new Response('', { status: 503 })
        if (mode === 3) return new Response('not json')
        if (mode === 4) return new Response('{}')
        return new Response('{"features":[]}')
      }
    })
    for (let i = 0; i < 4; i++) {
      let failed = false
      try {
        await search.search('Demo', 'venue')
      } catch (e) {
        failed = true
        expect(String(e)).includes('Place suggestions')
      }
      expect(failed).equals(true)
    }
    expect(await search.search('Demo', 'venue')).length(0)
  })
  it('limits simultaneous unique queries instead of growing an unbounded queue', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => {
      finish = resolve
    })
    const search = eventPlaceSearch({
      spacingMs: 0,
      fetch: async () => {
        await gate
        return new Response('{"features":[]}')
      }
    })
    const pending = Array.from(
      { length: 8 },
      async (_, i) => await search.search(`Demo ${i}`, 'address')
    )
    let rejected = false
    try {
      await search.search('Demo ninth', 'address')
    } catch (e) {
      rejected = true
      expect(String(e)).includes('busy')
    }
    expect(rejected).equals(true)
    finish()
    await Promise.all(pending)
  })
})
