import { expect } from 'chai'
import { describe, it } from 'mocha'

import { coordinateTimezone } from './coordinateTimezone'

describe('coordinate time zones', () => {
  it('uses Google with bounded requests and never caches the selected point', async () => {
    const calls: URL[] = []
    const provider: typeof fetch = async (input, init) => {
      expect(input).instanceOf(URL)
      calls.push(input as URL)
      expect(init?.signal).instanceOf(AbortSignal)
      return new Response(
        JSON.stringify({ status: 'OK', timeZoneId: 'Asia/Tokyo' })
      )
    }
    const options = { apiKey: 'placeholder-key', fetch: provider }
    expect(await coordinateTimezone(35.67, 139.65, options)).equals(
      'Asia/Tokyo'
    )
    await coordinateTimezone(35.67, 139.65, options)
    expect(calls).length(2)
    expect(calls[0].origin).equals('https://maps.googleapis.com')
    expect(calls[0].searchParams.get('location')).equals('35.67,139.65')
    expect(calls[0].searchParams.get('key')).equals('placeholder-key')
    expect(Number(calls[0].searchParams.get('timestamp'))).greaterThan(0)
  })
  it('uses accurate boundaries when Google is unavailable, denied, empty or malformed', async () => {
    for (const mode of [
      'network',
      'http',
      'denied',
      'empty',
      'invalid',
      'json',
      'null'
    ] as const) {
      const provider: typeof fetch = async () => {
        if (mode === 'network') throw new Error('Provider unavailable')
        if (mode === 'json') return new Response('not json')
        return new Response(
          JSON.stringify(
            mode === 'null'
              ? null
              : {
                  status: mode === 'denied' ? 'REQUEST_DENIED' : 'OK',
                  timeZoneId: mode === 'invalid' ? 'Not/AZone' : undefined
                }
          ),
          { status: mode === 'http' ? 503 : 200 }
        )
      }
      expect(
        await coordinateTimezone(41.315, -6.511, {
          apiKey: 'placeholder-key',
          fetch: provider
        }),
        mode
      ).equals('Europe/Lisbon')
    }
    for (const [latitude, longitude, expected] of [
      [41.316, -6.396, 'Europe/Madrid'],
      [40.737, -114.03, 'America/Denver'],
      [40.737, -114.08, 'America/Denver'],
      [40.737, -114.3, 'America/Los_Angeles']
    ] as const)
      expect(
        await coordinateTimezone(latitude, longitude, {
          apiKey: 'placeholder-key',
          fetch: async () => {
            throw new Error('offline')
          }
        })
      ).equals(expected)
  })
  it('rejects invalid coordinates before contacting either provider', async () => {
    let calls = 0
    for (const [latitude, longitude] of [
      [NaN, 0],
      [91, 0],
      [0, 181],
      [0, Infinity]
    ]) {
      try {
        await coordinateTimezone(latitude, longitude, {
          apiKey: 'placeholder-key',
          fetch: async () => {
            calls++
            return new Response('{}')
          }
        })
        expect.fail('must refuse invalid coordinates')
      } catch (error) {
        expect(error).property('code', 'unavailable')
        expect(String(error)).not.includes('placeholder-key')
      }
    }
    expect(calls).equals(0)
  })
})
