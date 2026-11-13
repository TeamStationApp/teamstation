import type { Kysely } from 'kysely'

import type { ChatRead } from '../../common/push'
import type { Database } from '../db/database'
import {
  ANDROID_WAKE_TTL_SECONDS,
  expiresAfter,
  IOS_BACKGROUND_WAKE_SECONDS,
  showsEverything
} from './chatWakes'
import type { PushQueue } from './queue'
import type { ReadPushRequest } from './requests'
import {
  emptyReport,
  liveRegistrations,
  type PushAddress,
  type PushLog,
  type PushMessage,
  type PushReport,
  type PushTransport,
  type PushTransports,
  sendToDevices
} from './send'

/**
 * A read in each platform's shape, to take down the notifications tagged
 * `chat:<c>` that a wake left on a device:
 *
 * - Android: data only, at normal priority, kept as long as a wake is.
 * - iOS: a background push (`content-available`), which iOS delivers at its
 *   own pace and never to an app the person swiped away, kept by APNs as
 *   long as an Android read, from `now`.
 * - Web: Chrome and Edge only, kept as long as an Android read: longer than
 *   a web wake, since the notification it takes down can stay on screen
 *   after its wake would have expired. Safari would show it, and Firefox
 *   counts a push that shows nothing against the subscription's quota; their
 *   notifications go when a TeamStation tab opens the conversation.
 */
export function readMessage(
  to: PushAddress,
  read: ChatRead,
  now: Date = new Date()
): PushMessage | null {
  const text = JSON.stringify(read)
  switch (to.platform) {
    case 'ios':
      return {
        platform: 'ios',
        pushType: 'background',
        priority: 5,
        expiration: expiresAfter(now, IOS_BACKGROUND_WAKE_SECONDS),
        payload: { aps: { 'content-available': 1 }, ...read }
      }
    case 'android':
      return {
        platform: 'android',
        priority: 'normal',
        ttlSeconds: ANDROID_WAKE_TTL_SECONDS,
        data: { payload: text }
      }
    case 'web':
      if (showsEverything(to.address)) return null
      return {
        platform: 'web',
        payload: text,
        urgency: 'normal',
        ttlSeconds: ANDROID_WAKE_TTL_SECONDS
      }
  }
}

export interface ChatReadOptions {
  transports: PushTransports
  queue: Pick<PushQueue, 'wokenAt' | 'readPast'>
  log?: PushLog
  /** Now, which an iOS clear's expiration counts from. */
  now?: Date
}

/** What a read sent, and the devices to send it again. */
export interface ReadReport extends PushReport {
  /**
   * The registrations whose send failed, which a later try sends to again;
   * empty when the registrations could not be read at all (then everyone is
   * `unreached`, and a later try sends to every device).
   */
  retry: string[]
}

/**
 * `transport`, also noting in `failed` each device a send to failed or
 * threw at.
 */
function noting<M extends PushMessage>(
  transport: PushTransport<M> | undefined,
  failed: string[]
): PushTransport<M> | undefined {
  if (transport == null) return undefined
  return {
    async send(to, message) {
      try {
        const result = await transport.send(to, message)
        if (result.status === 'failed') failed.push(to.id)
        return result
      } catch (error) {
        failed.push(to.id)
        throw error
      }
    }
  }
}

/**
 * The push sender's work for a read: when a wake reached the reader in the
 * conversation and their cursor now covers the latest one, their devices,
 * less the one that read, are told to take its notifications down, and the
 * mark goes. Nothing is sent when no wake is marked, or a later one is:
 * that one is still unread, and its own read will clear it.
 *
 * A device whose send failed keeps the mark, and is in `retry`: a later
 * try (`request.devices`) sends to it alone, since a clear sent twice takes
 * down nothing more.
 */
export async function clearRead(
  db: Kysely<Database>,
  request: Pick<ReadPushRequest, 'u' | 'c' | 'seq' | 'session' | 'devices'>,
  options: ChatReadOptions
): Promise<ReadReport | null> {
  const woken = await options.queue.wokenAt(request.u, request.c)
  if (woken == null || woken > request.seq) return null
  const read: ChatRead = {
    t: 'read',
    u: request.u,
    c: request.c,
    seq: request.seq
  }
  const log =
    options.log ??
    ((line: string) => {
      console.warn(line)
    })
  let devices: PushAddress[]
  try {
    devices = await liveRegistrations(db, [request.u], request.session)
  } catch (error) {
    log(`push: reading registrations failed: ${String(error)}`)
    return { ...emptyReport(), unreached: [request.u], retry: [] }
  }
  const only = request.devices
  if (only != null) devices = devices.filter(to => only.includes(to.id))
  const retry: string[] = []
  const report = await sendToDevices(
    db,
    devices,
    to => readMessage(to, read, options.now),
    {
      ios: noting(options.transports.ios, retry),
      android: noting(options.transports.android, retry),
      web: noting(options.transports.web, retry)
    },
    log
  )
  if (retry.length === 0 && report.unreached.length === 0)
    await options.queue.readPast(request.u, request.c, request.seq)
  return { ...report, retry: retry.sort() }
}
