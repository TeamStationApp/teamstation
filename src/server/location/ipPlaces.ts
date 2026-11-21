import type { Serializable } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { createGunzip } from 'node:zlib'

import maxmind from 'maxmind'

/**
 * Where an IP address is, roughly: the city DB-IP's free "IP to City Lite"
 * database places it in. CC BY 4.0, credited on About TeamStation.
 */
export interface IpPlace {
  latitude: number
  longitude: number
  city: string
  /** The region's English name, as the places catalog writes it. */
  region: string
  /** ISO 3166-1 alpha-2, as the places catalog writes it. */
  country: string
}

export interface IpPlacesConfig {
  /** Where the database file is kept. */
  dir: string
  /** Its download address, `{month}` for `YYYY-MM`. */
  source?: string
}

/** What the lookup reads a database file with: `maxmind.open`'s reader. */
export interface IpReader {
  get: (ip: string) => unknown
}

export interface IpPlacesDeps {
  fetch: (url: string) => Promise<Response>
  open: (path: string) => Promise<IpReader>
  now: () => number
  log: (message: string) => void
}

export interface IpPlaces {
  /** The place an address is in, or null; the address is not kept. */
  lookup: (ip: string) => IpPlace | null
  /** Downloads a new file when there is none or it is a month old. */
  refresh: () => Promise<void>
  /** Resolves once the first open and refresh are done. */
  ready: Promise<void>
  stop: () => void
}

export const DB_IP_SOURCE =
  'https://download.db-ip.com/free/dbip-city-lite-{month}.mmdb.gz'
export const IP_PLACES_FILE = 'dbip-city-lite.mmdb'
export const IP_PLACES_MONTH_FILE = 'dbip-city-lite.month'

/** DB-IP publishes a month's file at the start of the month. */
const DAY_MS = 24 * 60 * 60 * 1000

const defaultDeps: IpPlacesDeps = {
  fetch: async url => await fetch(url),
  open: async path => await maxmind.open(path),
  now: Date.now,
  log: message => {
    console.warn(message)
  }
}

/**
 * Where the database is kept: the configured folder; with none configured,
 * `ipPlaces` in the service's systemd state directory (`STATE_DIRECTORY`,
 * the first when it names several); nowhere when it is turned off
 * (`false`) or there is no state directory.
 */
export function ipPlacesConfigOf(
  configured: IpPlacesConfig | false | undefined,
  stateDirectory: string | undefined = process.env.STATE_DIRECTORY
): IpPlacesConfig | undefined {
  if (configured === false) return undefined
  if (configured != null) return configured
  const state = stateDirectory?.split(':')[0] ?? ''
  return state === '' ? undefined : { dir: join(state, 'ipPlaces') }
}

/** `YYYY-MM` of a time, `back` months before it, in UTC. */
export function monthOf(time: number, back = 0): string {
  const date = new Date(time)
  const month = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - back, 1)
  )
  return month.toISOString().slice(0, 7)
}

/** Loopback, private, link-local and unique-local addresses are nowhere. */
export function isPublicIp(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    )
  }
  if (family === 6) {
    const lower = ip.toLowerCase()
    if (lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4)
      return isPublicIp(lower.slice(7))
    return !(
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith('ff')
    )
  }
  return false
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined

const englishName = (value: unknown): string => {
  const name = record(record(value)?.names)?.en
  return typeof name === 'string' ? name : ''
}

/** A database record as a place, when it has coordinates and a country. */
export function placeOfRecord(found: unknown): IpPlace | null {
  const at = record(found)
  const location = record(at?.location)
  const latitude = location?.latitude
  const longitude = location?.longitude
  const country = record(at?.country)?.iso_code
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    typeof country !== 'string'
  )
    return null
  const subdivisions = at?.subdivisions
  return {
    latitude,
    longitude,
    city: englishName(at?.city),
    region: Array.isArray(subdivisions) ? englishName(subdivisions[0]) : '',
    country
  }
}

/**
 * Opens the database kept in `config.dir`, downloads this month's at once
 * when it holds another month's, none, or one that does not open, and
 * checks again daily. Nothing it does
 * throws: a failure is logged and leaves the lookup answering from the file
 * it had, or answering null. No address is logged or kept.
 *
 * The database is over 100 MB in memory, so a server runs this in one
 * process: the cluster's primary, which answers its workers' lookups
 * (`answerIpLookups`, `ipLookupsFrom`), or the only process there is.
 */
export function startIpPlaces(
  config: IpPlacesConfig,
  deps: IpPlacesDeps = defaultDeps
): IpPlaces {
  const file = join(config.dir, IP_PLACES_FILE)
  // Which month the file is, written beside it once it opens.
  const monthFile = join(config.dir, IP_PLACES_MONTH_FILE)
  const source = config.source ?? DB_IP_SOURCE
  let reader: IpReader | undefined

  const modified = async (): Promise<number | undefined> =>
    await stat(file).then(
      found => found.mtimeMs,
      () => undefined
    )

  async function open(): Promise<void> {
    if ((await modified()) == null) return
    try {
      reader = await deps.open(file)
    } catch (error) {
      deps.log(`IP places: ${file} is unreadable: ${String(error)}`)
    }
  }

  /**
   * One month's file, downloaded to `temp` and opened; a reason it is not
   * there or does not open.
   */
  async function fetchMonth(
    month: string,
    temp: string
  ): Promise<IpReader | string> {
    try {
      const response = await deps.fetch(source.replace('{month}', month))
      if (!response.ok || response.body == null) {
        await response.body?.cancel()
        return `${month}: HTTP ${response.status}`
      }
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
        createGunzip(),
        createWriteStream(temp)
      )
      return await deps.open(temp)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      return `${month}: ${String(error)}`
    }
  }

  async function refresh(): Promise<void> {
    const temp = join(config.dir, `.${IP_PLACES_FILE}.${process.pid}.tmp`)
    try {
      const now = deps.now()
      const have = await readFile(monthFile, 'utf8').then(
        text => text.trim(),
        () => undefined
      )
      // Up to date: this month's, and it opened.
      if (reader != null && have === monthOf(now)) return
      await mkdir(config.dir, { recursive: true })
      const failed: string[] = []
      // This month's file may not be out yet, or may have come down broken:
      // last month's then, unless that is the one already held.
      const monthsBack =
        reader != null && have === monthOf(now, 1) ? [0] : [0, 1]
      for (const back of monthsBack) {
        const month = monthOf(now, back)
        const opened = await fetchMonth(month, temp)
        if (typeof opened === 'string') {
          failed.push(opened)
          continue
        }
        await rename(temp, file)
        await writeFile(monthFile, `${month}\n`)
        reader = opened
        return
      }
      deps.log(`IP places: no database from ${source} (${failed.join('; ')})`)
    } catch (error) {
      deps.log(`IP places: refresh failed: ${String(error)}`)
      await unlink(temp).catch(() => undefined)
    }
  }

  const ready = (async () => {
    await open()
    await refresh()
  })()
  const timer = setInterval(() => {
    refresh().catch(() => undefined)
  }, DAY_MS)
  ;(timer as { unref?: () => void }).unref?.()

  return {
    lookup: ip => {
      if (reader == null || !isPublicIp(ip)) return null
      const mapped = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip
      try {
        return placeOfRecord(reader.get(isIP(mapped) === 4 ? mapped : ip))
      } catch {
        return null
      }
    },
    refresh,
    ready,
    stop: () => {
      clearInterval(timer)
    }
  }
}

/** Where an address is, looked up here or in another process. */
export interface IpLookup {
  lookup: (ip: string) => IpPlace | null | Promise<IpPlace | null>
}

/** A process that messages: a cluster worker, or the primary as a worker sees it. */
export interface IpChannel {
  send: (
    message: Serializable,
    callback?: (error: Error | null) => void
  ) => unknown
  /** Whether the channel is still open; `process.connected` in a worker. */
  connected?: boolean
  on: (event: 'message', listener: (message: unknown) => void) => unknown
}

const ASK = 'ipPlaces.lookup'
const ANSWER = 'ipPlaces.place'
/** How long a worker waits on the primary before it places the reader nowhere. */
export const IP_LOOKUP_TIMEOUT_MS = 300

/** A worker as the primary answers it: `cluster.Worker`. */
export interface IpAsker {
  send: (
    message: Serializable,
    callback?: (error: Error | null) => void
  ) => unknown
  isConnected: () => boolean
}

/**
 * The primary's answer to one of a worker's messages, when it asks where an
 * address is; any other message is left alone. The address goes no further.
 * A worker that has gone (it crashed, or a deploy is stopping it) gets no
 * answer, and a send that fails as it goes is let go: an unanswered failure
 * would be an `'error'` on the worker, which takes the primary down.
 */
export function answerIpLookup(
  places: Pick<IpPlaces, 'lookup'>,
  worker: IpAsker,
  message: unknown
): void {
  const asked = record(message)
  if (asked?.type !== ASK || typeof asked.ip !== 'string') return
  if (!worker.isConnected()) return
  worker.send(
    { type: ANSWER, id: asked.id, place: places.lookup(asked.ip) },
    () => undefined
  )
}

/** A worker's lookups, answered by the primary over the cluster's channel. */
export function ipLookupsFrom(
  primary: IpChannel,
  timeoutMs = IP_LOOKUP_TIMEOUT_MS
): IpLookup {
  const waiting = new Map<number, (place: IpPlace | null) => void>()
  let next = 0
  primary.on('message', message => {
    const answer = record(message)
    if (answer?.type !== ANSWER || typeof answer.id !== 'number') return
    waiting.get(answer.id)?.(asIpPlace(answer.place))
  })
  return {
    lookup: async ip =>
      await new Promise(resolve => {
        const id = ++next
        const timer = setTimeout(() => {
          waiting.delete(id)
          resolve(null)
        }, timeoutMs)
        const settle = (place: IpPlace | null): void => {
          clearTimeout(timer)
          waiting.delete(id)
          resolve(place)
        }
        // A channel that has closed (a deploy is stopping this worker, or
        // the primary has gone) places the reader nowhere: a send on it
        // with no callback would be an uncaught 'error' on the process.
        if (primary.connected === false) {
          settle(null)
          return
        }
        waiting.set(id, settle)
        primary.send({ type: ASK, id, ip }, error => {
          if (error != null) settle(null)
        })
      })
  }
}

/** A place as the primary sent it, or null. */
function asIpPlace(value: unknown): IpPlace | null {
  const at = record(value)
  if (
    typeof at?.latitude !== 'number' ||
    typeof at.longitude !== 'number' ||
    typeof at.city !== 'string' ||
    typeof at.region !== 'string' ||
    typeof at.country !== 'string'
  )
    return null
  return {
    latitude: at.latitude,
    longitude: at.longitude,
    city: at.city,
    region: at.region,
    country: at.country
  }
}
