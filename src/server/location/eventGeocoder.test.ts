import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { eventGeocoder, photonCoordinates } from './eventGeocoder'

describe('event address geocoding', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const result = { features: [{ geometry: { coordinates: [12, 34] } }] }
  it('uses the Photon contract, deduplicates requests and persists positive results', async () => {
    let calls = 0
    const geocoder = eventGeocoder(f.h.db, {
      url: 'https://example.test/api',
      spacingMs: 0,
      fetch: async (input, options) => {
        calls++
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        )
        expect(url.searchParams.get('q')).equals('1 Demo Way')
        expect(url.searchParams.get('limit')).equals('1')
        expect(
          (options?.headers as Record<string, string>)['User-Agent']
        ).includes('TeamStation')
        return new Response(JSON.stringify(result))
      }
    })
    const answers = await Promise.all([
      geocoder.lookup('1 Demo Way'),
      geocoder.lookup('1 Demo Way')
    ])
    expect(calls).equals(1)
    expect(answers).deep.equals([
      { latitude: 34, longitude: 12 },
      { latitude: 34, longitude: 12 }
    ])
    expect(
      await eventGeocoder(f.h.db, {
        fetch: async () => {
          throw new Error('should use persistent cache')
        }
      }).lookup(' 1 DEMO WAY ')
    ).deep.equals(answers[0])
  })
  it('validates coordinates and uses short failure caching with retry recovery', async () => {
    for (const raw of [
      null,
      {},
      { features: [] },
      { features: [null] },
      { features: [{ geometry: null }] },
      { features: [{ geometry: { coordinates: [Infinity, 0] } }] },
      { features: [{ geometry: { coordinates: [0, 100] } }] },
      { features: [{ geometry: { coordinates: [181, 0] } }] },
      { features: [{ geometry: { coordinates: ['0', 1] } }] }
    ])
      expect(() => photonCoordinates(raw)).throws()
    let now = 1000
    let calls = 0
    const geocoder = eventGeocoder(f.h.db, {
      now: () => now,
      spacingMs: 0,
      failureTtlMs: 10,
      fetch: async () => {
        calls++
        return calls === 1
          ? new Response('unavailable', { status: 503 })
          : new Response(JSON.stringify(result))
      }
    })
    for (let i = 0; i < 2; i++) {
      try {
        await geocoder.lookup('Unavailable address')
        expect.fail('must fail')
      } catch (error) {
        expect(String(error)).match(/map|address/)
      }
    }
    expect(calls).equals(1)
    now += 20
    expect(await geocoder.lookup('Unavailable address')).deep.equals({
      latitude: 34,
      longitude: 12
    })
    expect(calls).equals(2)
  })
  it('bounds concurrent work and aborts provider requests', async () => {
    const geocoder = eventGeocoder(f.h.db, {
      spacingMs: 1,
      timeoutMs: 100,
      fetch: async (_input, options) =>
        await new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'))
            },
            { once: true }
          )
        })
    })
    const results = await Promise.allSettled(
      Array.from(
        { length: 10 },
        async (_, i) => await geocoder.lookup(`Demo address ${i}`)
      )
    )
    expect(results.every(row => row.status === 'rejected')).equals(true)
    expect(
      results.some(
        row => row.status === 'rejected' && String(row.reason).includes('busy')
      )
    ).equals(true)
  })
})
