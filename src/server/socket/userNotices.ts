import {
  asArray,
  asBoolean,
  asObject,
  asOptional,
  asString,
  asTuple
} from 'cleaners'
import { type Kysely, sql } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import type { UserTopic } from '../../common/gameSocket'
import type { ChangeFeed } from '../changeFeed/feed'
import type { Database } from '../db/database'

export const USER_NOTICES_CHANNEL = 'user_notices'

const asTopic = asLiteral('badge', 'offlineSet', 'tess')

/**
 * What a person's user topic should read again, as the database triggers
 * (`130refreshNotices`) and the server's own notices say it: whom by their
 * ids (`u`), by the scopes a request's sides ask (`s`), or by the teams of a
 * game or a season link (`g`, `l` when roles carried down may have moved).
 * `at` makes it a moment, not a change: when the topic next changes with
 * nothing written.
 */
export const asUserNoticePayload = asObject({
  t: asTopic,
  u: asOptional(asArray(asString)),
  s: asOptional(
    asArray(asTuple(asLiteral('league', 'season', 'team', 'user'), asString))
  ),
  g: asOptional(asArray(asString)),
  l: asOptional(asBoolean),
  /** A request whose people beyond its sides' staff are told too. */
  r: asOptional(asString),
  at: asOptional(asString)
})
export type UserNoticePayload = ReturnType<typeof asUserNoticePayload>

export interface UserNoticeListenerOptions {
  feed: ChangeFeed
  deliver: (payload: UserNoticePayload) => Promise<void>
  /** Notices may have gone unheard: every topic is read once. */
  onResync: () => void
  log?: (message: string) => void
}

/** Hears `user_notices` and hands each notice that reads to `deliver`. */
export class UserNoticeListener {
  readonly listening: Promise<void>
  private readonly stop: () => void

  constructor(options: UserNoticeListenerOptions) {
    const log =
      options.log ??
      ((message: string) => {
        console.error(`user notices: ${message}`)
      })
    const subscription = options.feed.subscribe(USER_NOTICES_CHANNEL, {
      onPayload: raw => {
        if (raw == null) return
        let payload: UserNoticePayload
        try {
          payload = asUserNoticePayload(JSON.parse(raw))
        } catch {
          log(`ignoring a notice that does not read: ${raw}`)
          return
        }
        options.deliver(payload).catch((error: unknown) => {
          log(`delivering ${raw}: ${String(error)}`)
        })
      },
      onListening: first => {
        if (!first) options.onResync()
      }
    })
    this.listening = subscription.listening
    this.stop = subscription.stop
  }

  close(): void {
    this.stop()
  }
}

/**
 * Tells these people's sockets, on every worker, to read a topic again, or
 * (with `at`) when it next changes with nothing written. Outside any
 * transaction: a moment is a schedule, and the change it follows has
 * committed.
 */
export async function publishUserNotice(
  db: Kysely<Database>,
  userIds: readonly string[],
  topic: UserTopic,
  at?: Date
): Promise<void> {
  if (userIds.length === 0) return
  const payload = JSON.stringify({
    t: topic,
    u: [...userIds].slice(0, 100),
    ...(at == null ? {} : { at: at.toISOString() })
  })
  await sql`select pg_notify(${USER_NOTICES_CHANNEL}, ${payload})`.execute(db)
}
