import { type Kysely, type RawBuilder, sql } from 'kysely'

import { anyOf } from '../db/anyOf'
import type { Database, PushRegistrationsTable } from '../db/database'
import type { ApnsMessage } from './apns'
import type { FcmMessage } from './fcm'
import type { WebPushMessage } from './webPush'

export type PushPlatform = PushRegistrationsTable['platform']
export type PushEnvironment = PushRegistrationsTable['environment']

/**
 * The device's own switch a push is for: chat wakes go only to
 * registrations with `messages` on, and reminders only to those with
 * `rsvp_events` on. A read's clear asks for neither (`null`): it takes down
 * only what a wake already showed, whatever the switch is now.
 */
export type PushSwitch = 'messages' | 'rsvp_events'

/** A registered device a message goes to. */
export interface PushAddress {
  id: string
  userId: string
  platform: PushPlatform
  /** The APNs or FCM token, or the Web Push subscription's JSON. */
  address: string
  environment: PushEnvironment
}

/** One message for one device, in its own platform's shape. */
export type PushMessage = ApnsMessage | FcmMessage | WebPushMessage

/**
 * What a service said: `gone` means the address will never work again (the
 * app was removed, the subscription ended) and its registration goes;
 * `rejected` means the service refused this send for good (a token for
 * another app or environment, a subscription made with another key), so
 * trying it again would only be refused again: the registration stays, but
 * is marked and sent nothing more until the device posts it again;
 * `refused` means the service would take no try of this message, for a
 * reason not about the address (the server's APNs topic, a header or body
 * the service will not take): the registration is left as it is, and the
 * send counts as failed but is not tried again; `failed` is anything a
 * later try may get past.
 */
export type PushResult =
  | { status: 'sent' }
  | { status: 'gone'; reason: string }
  | { status: 'rejected'; reason: string }
  | { status: 'refused'; reason: string }
  | { status: 'failed'; reason: string }

/** Sends a platform's messages. It answers every failure and never throws. */
export interface PushTransport<M extends PushMessage> {
  send: (to: PushAddress, message: M) => Promise<PushResult>
}

/** A transport for each platform that has one; the others are skipped. */
export interface PushTransports {
  ios?: PushTransport<ApnsMessage>
  android?: PushTransport<FcmMessage>
  web?: PushTransport<WebPushMessage>
}

export interface PushReport {
  sent: number
  /** No message for this device, or no transport for its platform. */
  skipped: number
  /** Sends that failed, those a service refused the message of among them. */
  failed: number
  /** Sends a service refused for good, which are not tried again. */
  rejected: number
  /** Registrations deleted because their address is gone. */
  removed: number
  /**
   * The people only failures kept this from: their registrations could not
   * be read, or a device of theirs failed or threw and none was sent to or
   * found gone. A later try may yet reach them.
   */
  unreached: string[]
  /**
   * Those of `unreached`, and the people a device of theirs was skipped for
   * (no transport for its platform) with none sent to or found gone: a
   * reminder written down for them was not delivered. Somebody a service
   * refused the message for, and nothing else, is in neither.
   */
  unsent: string[]
}

/** Writes one line about a failure; the server's log by default. */
export type PushLog = (line: string) => void

/**
 * The one rule for a live registration, as SQL over a `push_registrations`
 * row (`registration`, by table name or alias) and its `auth_sessions` row
 * (`session`): its session not revoked and not expired by the database's
 * clock, no service having refused it for good (`rejected_at`) since it was
 * last posted, and, with `wants`, that switch on. `liveRegistrations` and
 * the reminder sweep's `settled` both read it, so the two never disagree.
 */
export function liveRegistration(
  wants: PushSwitch | null,
  registration = 'push_registrations',
  session = 'auth_sessions'
): RawBuilder<boolean> {
  const row = (column: string): RawBuilder<unknown> =>
    sql.ref(`${registration}.${column}`)
  const switchOn = wants == null ? sql`true` : sql`${row(wants)}`
  return sql<boolean>`(${row('rejected_at')} is null and ${switchOn}
    and ${sql.ref(`${session}.revoked_at`)} is null
    and ${sql.ref(`${session}.expires_at`)} > now())`
}

/**
 * The registrations of these people that are live (`liveRegistration`),
 * with the switch `wants` on, or whatever their switches with `wants` null.
 * A device whose session ended is signed out, and hears nothing; neither
 * does one a service refused for good since it was last posted, nor one
 * whose switch is off. With `exceptSession`, that session's own are left
 * out.
 */
export async function liveRegistrations(
  db: Kysely<Database>,
  userIds: readonly string[],
  wants: PushSwitch | null,
  exceptSession?: string
): Promise<PushAddress[]> {
  if (userIds.length === 0) return []
  let query = db
    .selectFrom('push_registrations')
    .innerJoin(
      'auth_sessions',
      'auth_sessions.id',
      'push_registrations.session_id'
    )
    .select([
      'push_registrations.id as id',
      'push_registrations.user_id as userId',
      'push_registrations.platform as platform',
      'push_registrations.address as address',
      'push_registrations.environment as environment'
    ])
    .where('push_registrations.user_id', '=', anyOf(userIds))
    .where(liveRegistration(wants))
    .orderBy('push_registrations.id')
  if (exceptSession != null)
    query = query.where('push_registrations.session_id', '!=', exceptSession)
  return await query.execute()
}

async function deliver(
  transports: PushTransports,
  to: PushAddress,
  message: PushMessage
): Promise<PushResult | null> {
  if (message.platform !== to.platform) return null
  switch (message.platform) {
    case 'ios':
      return (await transports.ios?.send(to, message)) ?? null
    case 'android':
      return (await transports.android?.send(to, message)) ?? null
    case 'web':
      return (await transports.web?.send(to, message)) ?? null
  }
}

/**
 * How many sends one transport has under way at once, at most: a large
 * chat's wakes, and the push sender's requests settled side by side, wait
 * their turn rather than open hundreds of APNs streams or FCM and Web Push
 * requests together, which the services throttle.
 */
export const SENDS_AT_ONCE = 32

/** `transport`, sending no more than `most` messages at once. */
export function limited<M extends PushMessage>(
  transport: PushTransport<M>,
  most = SENDS_AT_ONCE
): PushTransport<M> {
  let running = 0
  const waiting: Array<() => void> = []
  return {
    async send(to, message) {
      // A send that ends hands its place straight to the next in line.
      if (running < most) running++
      else
        await new Promise<void>(resolve => {
          waiting.push(resolve)
        })
      try {
        return await transport.send(to, message)
      } finally {
        const next = waiting.shift()
        if (next == null) running--
        else next()
      }
    }
  }
}

/** A report of nothing sent yet. */
export function emptyReport(): PushReport {
  return {
    sent: 0,
    skipped: 0,
    failed: 0,
    rejected: 0,
    removed: 0,
    unreached: [],
    unsent: []
  }
}

/**
 * Sends each live device of these people with the switch `wants` on the
 * message `build` makes for it (null sends that device nothing), through its
 * platform's transport (`sendToDevices`). Nobody is reached when their
 * registrations cannot be read: that is logged, and they are all
 * `unreached`.
 */
export async function sendPush(
  db: Kysely<Database>,
  userIds: readonly string[],
  wants: PushSwitch,
  build: (to: PushAddress) => PushMessage | null,
  transports: PushTransports,
  log: PushLog = line => {
    console.warn(line)
  }
): Promise<PushReport> {
  let devices: PushAddress[]
  try {
    devices = await liveRegistrations(db, userIds, wants)
  } catch (error) {
    log(`push: reading registrations failed: ${String(error)}`)
    const everybody = [...new Set(userIds)].sort()
    return { ...emptyReport(), unreached: everybody, unsent: everybody }
  }
  return await sendToDevices(db, devices, build, transports, log)
}

/**
 * Sends each of these devices the message `build` makes for it (null sends
 * that device nothing), through its platform's transport.
 *
 * A device whose address is gone loses its registration, unless it was
 * registered again meanwhile with another address. A send refused for good
 * is logged and counted, and not tried again, and its registration is
 * marked so nothing more is sent to it until the device posts it again. It
 * is not deleted: a `BadDeviceToken` is also what APNs answers a good token
 * sent to the other environment, so a misconfigured server would otherwise
 * delete every phone's registration it sends to. A failure is logged and
 * counted, and the people failures alone kept it from are `unreached`,
 * but for a message a service refused (`refused`), which a later try would
 * only see refused again.
 * Nothing here throws, so the push sender decides from the report whether to
 * try again.
 */
export async function sendToDevices(
  db: Kysely<Database>,
  devices: readonly PushAddress[],
  build: (to: PushAddress) => PushMessage | null,
  transports: PushTransports,
  log: PushLog = line => {
    console.warn(line)
  }
): Promise<PushReport> {
  const report = emptyReport()
  /**
   * People a send to reached, or whose address it found gone. A send refused
   * for good is neither: on its own it leaves nobody to try again.
   */
  const answered = new Set<string>()
  /** People a send to failed. */
  const failing = new Set<string>()
  /** People a device of theirs had no transport or message for. */
  const skipped = new Set<string>()
  await Promise.all(
    devices.map(async to => {
      try {
        const message = build(to)
        const result =
          message == null ? null : await deliver(transports, to, message)
        if (result == null) {
          report.skipped++
          skipped.add(to.userId)
          return
        }
        if (result.status === 'sent') {
          report.sent++
          answered.add(to.userId)
          return
        }
        log(`push: ${to.platform} ${to.id} ${result.status}: ${result.reason}`)
        if (result.status === 'failed' || result.status === 'refused') {
          report.failed++
          if (result.status === 'failed') failing.add(to.userId)
          return
        }
        if (result.status === 'rejected') {
          report.rejected++
          try {
            await db
              .updateTable('push_registrations')
              .set({ rejected_at: new Date() })
              .where('id', '=', to.id)
              .where('address', '=', to.address)
              .execute()
          } catch (error) {
            log(`push: marking ${to.id} rejected failed: ${String(error)}`)
          }
          return
        }
        answered.add(to.userId)
        const removed = await db
          .deleteFrom('push_registrations')
          .where('id', '=', to.id)
          .where('address', '=', to.address)
          .executeTakeFirst()
        if (removed.numDeletedRows > 0n) report.removed++
      } catch (error) {
        report.failed++
        failing.add(to.userId)
        log(`push: ${to.platform} ${to.id} threw: ${String(error)}`)
      }
    })
  )
  report.unreached = [...failing].filter(id => !answered.has(id)).sort()
  report.unsent = [...new Set([...failing, ...skipped])]
    .filter(id => !answered.has(id))
    .sort()
  return report
}
