import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { shaper } from './shaper'

const SHAPER = 'https://shaper.example.test'

interface Sent {
  url: string
  method: string
  body: unknown
}

/** A conditioner that lists `devices` and answers each shape with `shapeStatus`. */
function conditioner(
  options: {
    devices?: unknown[]
    listStatus?: number
    shapeStatus?: number
  } = {}
): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = []
  const call = async (
    url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const method = init?.method ?? 'GET'
    sent.push({
      url: url as string,
      method,
      body: init?.body == null ? undefined : JSON.parse(init.body as string)
    })
    if (method === 'GET') {
      return new Response(JSON.stringify({ devices: options.devices ?? [] }), {
        status: options.listStatus ?? 200
      })
    }
    return new Response(null, { status: options.shapeStatus ?? 204 })
  }
  return { fetch: call, sent }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error as Error
  )
}

describe('the network conditioner', function () {
  it('finds a device on a test network, and says when the address is on none', async function () {
    const fake = conditioner({
      devices: [
        {
          ip: '192.0.2.20',
          hostname: 'iphone',
          ssid: 'test-net-1',
          extra: true
        }
      ]
    })
    const shape = shaper({
      base: 'https://gw.example.test/',
      fetch: fake.fetch
    })
    expect(await shape.onTestNetwork('192.0.2.20')).deep.equals({
      ip: '192.0.2.20',
      hostname: 'iphone',
      ssid: 'test-net-1'
    })
    expect(await shape.onTestNetwork('192.0.2.21')).equals(null)
    expect(fake.sent[0].url).equals('https://gw.example.test/v1/devices')
  })

  it('says when the conditioner will not list its devices', async function () {
    const fake = conditioner({ listStatus: 502 })
    const error = await rejection(
      shaper({ base: SHAPER, fetch: fake.fetch }).onTestNetwork('192.0.2.20')
    )
    expect(error.message).equals('the conditioner would not list devices: 502')
    expect(fake.sent[0].url).equals(`${SHAPER}/v1/devices`)
  })

  it('drops all traffic for the outage, then clears it', async function () {
    const fake = conditioner()
    const slept: number[] = []
    const shape = shaper({
      base: SHAPER,
      fetch: fake.fetch,
      sleep: async ms => {
        slept.push(ms)
      }
    })
    expect(
      await shape.outage('192.0.2.20', 180_000, async () => 'seen')
    ).equals('seen')
    expect(await shape.outage('192.0.2.20', 5)).equals(undefined)
    expect(slept).deep.equals([180_000, 5])
    expect(fake.sent.map(sent => [sent.method, sent.body])).deep.equals([
      ['POST', [{ ip: '192.0.2.20', lossPct: 100 }]],
      ['POST', [{ ip: '192.0.2.20' }]],
      ['POST', [{ ip: '192.0.2.20', lossPct: 100 }]],
      ['POST', [{ ip: '192.0.2.20' }]]
    ])
  })

  it('clears the shape even when the work during the outage throws', async function () {
    const fake = conditioner()
    const shape = shaper({
      base: SHAPER,
      fetch: fake.fetch,
      sleep: async () => {}
    })
    const error = await rejection(
      shape.outage('192.0.2.20', 1000, async () => {
        throw new Error('probe failed')
      })
    )
    expect(error.message).equals('probe failed')
    expect(fake.sent.at(-1)!.body).deep.equals([{ ip: '192.0.2.20' }])
  })

  it('says when the conditioner refuses a shape', async function () {
    const fake = conditioner({ shapeStatus: 400 })
    const error = await rejection(
      shaper({ base: SHAPER, fetch: fake.fetch, sleep: async () => {} }).outage(
        '192.0.2.20',
        1000
      )
    )
    expect(error.message).equals('the conditioner refused a shape: 400')
    expect(fake.sent).length(1)
  })

  it('asks the conditioner itself over HTTP when no fetch is given', async function () {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          devices: [{ ip: '192.0.2.20', hostname: null, ssid: 'test-net-2' }]
        })
      )
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      expect(
        await shaper({ base: `http://127.0.0.1:${port}` }).onTestNetwork(
          '192.0.2.20'
        )
      ).deep.equals({ ip: '192.0.2.20', hostname: null, ssid: 'test-net-2' })
    } finally {
      server.close()
    }
  })

  it('waits with real time when no sleep is given', async function () {
    const fake = conditioner()
    const started = Date.now()
    await shaper({ base: SHAPER, fetch: fake.fetch }).outage('192.0.2.20', 5)
    expect(Date.now() - started).at.least(4)
  })
})
