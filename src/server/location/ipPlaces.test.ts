import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import {
  answerIpLookup,
  DB_IP_SOURCE,
  IP_PLACES_FILE,
  IP_PLACES_MONTH_FILE,
  type IpAsker,
  type IpChannel,
  ipLookupsFrom,
  type IpPlaces,
  ipPlacesConfigOf,
  type IpPlacesDeps,
  isPublicIp,
  monthOf,
  placeOfRecord,
  startIpPlaces
} from './ipPlaces'

const NOW = Date.UTC(2026, 10, 18, 12)
const DAY = 24 * 60 * 60 * 1000

/** A database record, as DB-IP's City Lite writes one. */
const sanDiegoRecord = {
  city: { names: { en: 'San Diego' } },
  subdivisions: [{ names: { en: 'California' } }],
  country: { iso_code: 'US' },
  location: { latitude: 32.7157, longitude: -117.1611 }
}

const dirs: string[] = []
const started: IpPlaces[] = []
afterEach(async () => {
  for (const places of started.splice(0)) places.stop()
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ipPlaces-'))
  dirs.push(dir)
  return dir
}

/**
 * Deps whose "database" is a file of JSON: the reader answers its one
 * record for any address. `served` maps a month to the gzipped body.
 */
function fakeDeps(served: Record<string, Buffer | number>): IpPlacesDeps & {
  fetched: string[]
  logged: string[]
  cancelled: number
} {
  const fetched: string[] = []
  const logged: string[] = []
  const deps = {
    fetched,
    logged,
    cancelled: 0,
    fetch: async (url: string) => {
      fetched.push(url)
      const month = /(\d{4}-\d{2})/.exec(url)?.[1] ?? ''
      const body = served[month]
      if (typeof body === 'number' || body == null)
        // A refused download's body is drained, not left open.
        return new Response(
          new ReadableStream({
            cancel: () => {
              deps.cancelled++
            }
          }),
          { status: typeof body === 'number' ? body : 404 }
        )
      return new Response(new Uint8Array(body))
    },
    open: async (path: string) => {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return { get: () => parsed }
    },
    now: () => NOW,
    log: (message: string) => {
      logged.push(message)
    }
  }
  return deps
}

const gz = (value: unknown): Buffer => gzipSync(JSON.stringify(value))

function start(dir: string, deps: IpPlacesDeps): IpPlaces {
  const places = startIpPlaces({ dir }, deps)
  started.push(places)
  return places
}

describe('IP places', () => {
  it('keeps the database where it is configured, else under the service’s state directory, else nowhere', () => {
    expect(
      ipPlacesConfigOf({ dir: '/data/ip' }, '/state/teamstation')
    ).deep.equals({ dir: '/data/ip' })
    expect(ipPlacesConfigOf(undefined, '/state/teamstation')).deep.equals({
      dir: '/state/teamstation/ipPlaces'
    })
    // systemd names several, colon-separated, when a unit has several.
    expect(
      ipPlacesConfigOf(undefined, '/state/teamstation:/state/other')
    ).deep.equals({
      dir: '/state/teamstation/ipPlaces'
    })
    expect(ipPlacesConfigOf(false, '/state/teamstation')).equals(undefined)
    expect(ipPlacesConfigOf(undefined, undefined)).equals(undefined)
    expect(ipPlacesConfigOf(undefined, '')).equals(undefined)
  })

  it('names the month, and the one before it, in UTC', () => {
    expect(monthOf(NOW)).equals('2026-11')
    expect(monthOf(NOW, 1)).equals('2026-10')
    expect(monthOf(Date.UTC(2026, 0, 3), 1)).equals('2025-12')
    expect(DB_IP_SOURCE.replace('{month}', '2026-11')).equals(
      'https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz'
    )
  })

  it('places no private, loopback or link-local address', () => {
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '172.16.0.1',
      // 172.16.0.0/12 ends at 172.31.255.255; the next address on is public.
      '172.31.9.9',
      '192.168.1.1',
      '169.254.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:10.0.0.1',
      'not an address'
    ])
      expect(isPublicIp(ip), ip).equals(false)
    for (const ip of ['203.0.113.8', '2001:db8::8888', '::ffff:203.0.113.8'])
      expect(isPublicIp(ip), ip).equals(true)
  })

  it('reads a record’s coordinates, city, region and country, and nothing without them', () => {
    expect(placeOfRecord(sanDiegoRecord)).deep.equals({
      latitude: 32.7157,
      longitude: -117.1611,
      city: 'San Diego',
      region: 'California',
      country: 'US'
    })
    expect(
      placeOfRecord({
        country: { iso_code: 'US' },
        location: { latitude: 1, longitude: 2 }
      })
    ).deep.equals({
      latitude: 1,
      longitude: 2,
      city: '',
      region: '',
      country: 'US'
    })
    expect(placeOfRecord(null)).equals(null)
    expect(placeOfRecord({ country: { iso_code: 'US' } })).equals(null)
    expect(placeOfRecord({ location: { latitude: 1, longitude: 2 } })).equals(
      null
    )
  })

  it('downloads this month’s file when there is none, swaps it in, and looks addresses up in it', async () => {
    const dir = tempDir()
    const deps = fakeDeps({ '2026-11': gz(sanDiegoRecord) })
    const places = start(dir, deps)
    expect(places.lookup('203.0.113.8')).equals(null)
    await places.ready
    expect(deps.fetched).deep.equals([
      'https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz'
    ])
    expect(readdirSync(dir)).deep.equals([IP_PLACES_FILE, IP_PLACES_MONTH_FILE])
    expect(places.lookup('203.0.113.8')?.city).equals('San Diego')
    expect(places.lookup('::ffff:203.0.113.8')?.city).equals('San Diego')
    expect(places.lookup('192.168.1.1')).equals(null)
    expect(deps.logged).deep.equals([])
  })

  it('takes last month’s file when this month’s is not out yet', async () => {
    const dir = tempDir()
    const deps = fakeDeps({ '2026-10': gz(sanDiegoRecord) })
    const places = start(dir, deps)
    await places.ready
    expect(deps.fetched.map(url => /\d{4}-\d{2}/.exec(url)?.[0])).deep.equals([
      '2026-11',
      '2026-10'
    ])
    expect(places.lookup('203.0.113.8')?.region).equals('California')
  })

  it('keeps this month’s file, and replaces last month’s once this month’s is out', async () => {
    const dir = tempDir()
    const file = join(dir, IP_PLACES_FILE)
    const month = join(dir, IP_PLACES_MONTH_FILE)
    writeFileSync(
      file,
      JSON.stringify({ ...sanDiegoRecord, city: { names: { en: 'Old' } } })
    )
    writeFileSync(month, '2026-11\n')
    const deps = fakeDeps({ '2026-11': gz(sanDiegoRecord) })
    const places = start(dir, deps)
    await places.ready
    expect(deps.fetched).deep.equals([])
    expect(places.lookup('203.0.113.8')?.city).equals('Old')

    // Held since October: November's is fetched, and nothing older.
    writeFileSync(month, '2026-10\n')
    await places.refresh()
    expect(deps.fetched.map(url => /\d{4}-\d{2}/.exec(url)?.[0])).deep.equals([
      '2026-11'
    ])
    expect(places.lookup('203.0.113.8')?.city).equals('San Diego')
    expect(readFileSync(month, 'utf8')).equals('2026-11\n')
  })

  it('falls back to last month’s file, and asks for this month’s again the next day', async () => {
    const dir = tempDir()
    const deps = fakeDeps({ '2026-10': gz(sanDiegoRecord) })
    const places = start(dir, deps)
    await places.ready
    expect(readFileSync(join(dir, IP_PLACES_MONTH_FILE), 'utf8')).equals(
      '2026-10\n'
    )
    deps.fetched.length = 0
    await places.refresh()
    // Only this month's: last month's is the one it holds.
    expect(deps.fetched.map(url => /\d{4}-\d{2}/.exec(url)?.[0])).deep.equals([
      '2026-11'
    ])
    expect(places.lookup('203.0.113.8')?.city).equals('San Diego')
  })

  it('replaces a file that does not open, however new', async () => {
    const dir = tempDir()
    const file = join(dir, IP_PLACES_FILE)
    writeFileSync(file, 'not json')
    writeFileSync(join(dir, IP_PLACES_MONTH_FILE), '2026-11\n')
    const deps = fakeDeps({ '2026-11': gz(sanDiegoRecord) })
    const places = start(dir, deps)
    await places.ready
    expect(deps.logged[0]).includes('unreadable')
    expect(deps.fetched).length(1)
    expect(places.lookup('203.0.113.8')?.city).equals('San Diego')
  })

  it('keeps the file it had when a download fails or is unreadable, and logs no address', async () => {
    const dir = tempDir()
    const file = join(dir, IP_PLACES_FILE)
    writeFileSync(file, JSON.stringify(sanDiegoRecord))
    const stale = new Date(NOW - 40 * DAY)
    utimesSync(file, stale, stale)

    const missing = fakeDeps({ '2026-11': 500, '2026-10': 404 })
    const first = start(dir, missing)
    await first.ready
    expect(missing.fetched).length(2)
    expect(missing.logged).length(1)
    expect(missing.logged[0]).includes('no database from')
    expect(missing.logged[0]).includes('2026-11: HTTP 500')
    expect(missing.cancelled).equals(2)
    expect(first.lookup('203.0.113.8')?.city).equals('San Diego')

    const junk = fakeDeps({
      '2026-11': gzipSync('not a database'),
      '2026-10': gzipSync('not one either')
    })
    const second = start(dir, junk)
    await second.ready
    expect(junk.fetched).length(2)
    expect(junk.logged).length(1)
    expect(readdirSync(dir)).deep.equals([IP_PLACES_FILE])
    expect(second.lookup('203.0.113.8')?.city).equals('San Diego')
    for (const line of [...missing.logged, ...junk.logged])
      expect(line).not.includes('203.0.113.8')
  })

  it('takes last month’s file when this month’s comes down broken', async () => {
    const dir = tempDir()
    const truncated = gz(sanDiegoRecord).subarray(0, 12)
    const corrupt = fakeDeps({
      '2026-11': truncated,
      '2026-10': gz(sanDiegoRecord)
    })
    const places = start(dir, corrupt)
    await places.ready
    expect(corrupt.fetched).length(2)
    expect(readdirSync(dir)).deep.equals([IP_PLACES_FILE, IP_PLACES_MONTH_FILE])
    expect(places.lookup('203.0.113.8')?.city).equals('San Diego')
    expect(corrupt.logged).deep.equals([])
  })

  it('answers null with no file, and never throws on a refresh that fails', async () => {
    const dir = tempDir()
    const deps = fakeDeps({})
    deps.fetch = async () => {
      throw new Error('offline')
    }
    const places = start(dir, deps)
    await places.ready
    expect(places.lookup('203.0.113.8')).equals(null)
    expect(deps.logged[0]).includes('offline')
  })

  it('logs a file it cannot open at start, and answers null until a refresh', async () => {
    const dir = tempDir()
    const file = join(dir, IP_PLACES_FILE)
    writeFileSync(file, 'not json')
    utimesSync(file, new Date(NOW), new Date(NOW))
    const deps = fakeDeps({})
    const places = start(dir, deps)
    await places.ready
    expect(deps.logged[0]).includes('unreadable')
    expect(places.lookup('203.0.113.8')).equals(null)
  })

  it('checks daily, and stops', () => {
    const intervals: number[] = []
    const cleared: unknown[] = []
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    globalThis.setInterval = ((_: () => void, ms: number) => {
      intervals.push(ms)
      return { unref: () => undefined }
    }) as unknown as typeof setInterval
    globalThis.clearInterval = (timer: unknown) => {
      cleared.push(timer)
    }
    try {
      startIpPlaces({ dir: tempDir() }, fakeDeps({})).stop()
    } finally {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
    expect(intervals).deep.equals([DAY])
    expect(cleared).length(1)
  })

  describe('across the cluster', () => {
    /**
     * The cluster's channel: `primary` is the primary as a worker sees it,
     * `worker` the worker as the primary sees it. What the worker sends is
     * kept in `sent`; what the primary sends reaches the worker's listeners.
     */
    function channel(): {
      primary: IpChannel
      worker: IpAsker
      sent: unknown[]
    } {
      const listeners: Array<(message: unknown) => void> = []
      const sent: unknown[] = []
      return {
        sent,
        primary: {
          send: message => {
            sent.push(message)
          },
          on: (_event, listener) => listeners.push(listener)
        },
        worker: {
          send: (message, callback) => {
            for (const listener of listeners) listener(message)
            callback?.(null)
          },
          isConnected: () => true
        }
      }
    }

    const place = {
      latitude: 32.7157,
      longitude: -117.1611,
      city: 'San Diego',
      region: 'California',
      country: 'US'
    }

    it('asks the primary, which answers from its one copy', async () => {
      const { primary, worker, sent } = channel()
      const looked: string[] = []
      const lookups = ipLookupsFrom(primary)
      const asking = lookups.lookup('203.0.113.8')
      expect(sent).length(1)
      answerIpLookup(
        {
          lookup: ip => {
            looked.push(ip)
            return place
          }
        },
        worker,
        sent[0]
      )
      expect(await asking).deep.equals(place)
      expect(looked).deep.equals(['203.0.113.8'])
    })

    it('answers nowhere for an address the primary cannot place, a garbled answer, or none in time', async () => {
      const { primary, worker, sent } = channel()
      const lookups = ipLookupsFrom(primary, 20)
      const unplaced = lookups.lookup('10.0.0.1')
      answerIpLookup({ lookup: () => null }, worker, sent[0])
      expect(await unplaced).equals(null)
      const garbled = lookups.lookup('203.0.113.8')
      worker.send({
        type: 'ipPlaces.place',
        id: (sent[1] as { id: number }).id,
        place: { city: 1 }
      })
      expect(await garbled).equals(null)
      expect(await lookups.lookup('203.0.113.8')).equals(null)
    })

    it('answers no worker that has gone, and lets a send that fails go', () => {
      const ask = { type: 'ipPlaces.lookup', id: 1, ip: '203.0.113.8' }
      const sent: unknown[] = []
      answerIpLookup(
        { lookup: () => place },
        { send: message => sent.push(message), isConnected: () => false },
        ask
      )
      expect(sent).deep.equals([])
      // A worker that disconnects as it is answered: its send fails in the
      // callback, which is there so the failure is not an 'error' event.
      const failures: unknown[] = []
      expect(() => {
        answerIpLookup(
          { lookup: () => place },
          {
            send: (_message, callback) => {
              expect(callback, 'a callback takes the failure').not.equals(
                undefined
              )
              const error = new Error('channel closed')
              failures.push(error)
              callback?.(error)
            },
            isConnected: () => true
          },
          ask
        )
      }).not.throws()
      expect(failures).length(1)
    })

    it('asks no primary whose channel has closed, and answers nowhere when a send fails', async () => {
      const sent: unknown[] = []
      const closed = ipLookupsFrom({
        send: message => sent.push(message),
        on: () => undefined,
        connected: false
      })
      expect(await closed.lookup('203.0.113.8')).equals(null)
      expect(sent).deep.equals([])
      // Closing as the message goes: the send's callback takes the failure.
      const failing = ipLookupsFrom(
        {
          send: (_message, callback) => {
            expect(callback, 'a callback takes the failure').not.equals(
              undefined
            )
            callback?.(new Error('channel closed'))
          },
          on: () => undefined,
          connected: true
        },
        60_000
      )
      expect(await failing.lookup('203.0.113.8')).equals(null)
    })

    it('leaves other messages alone, on both ends', async () => {
      const { primary, worker } = channel()
      const answered: unknown[] = []
      answerIpLookup(
        { lookup: () => place },
        { send: message => answered.push(message), isConnected: () => true },
        { type: 'other' }
      )
      answerIpLookup(
        { lookup: () => place },
        { send: message => answered.push(message), isConnected: () => true },
        null
      )
      expect(answered).deep.equals([])
      const lookups = ipLookupsFrom(primary, 20)
      const asking = lookups.lookup('203.0.113.8')
      worker.send({ type: 'something else' })
      worker.send({ type: 'ipPlaces.place', id: 'not a number', place })
      expect(await asking).equals(null)
    })
  })
})
