import type { Kysely } from 'kysely'

import { chatTag, type ChatWake, showsEveryPush } from '../../common/push'
import { blockedSenderIds, blockingRecipientIds } from '../chat/blocks'
import { type ChatMessageView, messagesOf } from '../chat/messages'
import {
  scopeIdentities,
  scopesOf,
  type Titled,
  titlesOf
} from '../chat/titles'
import { anyOf } from '../db/anyOf'
import type { Database } from '../db/database'
import { formatForReader, readerNaming } from '../groups/playerNamePrivacy'
import { outsideSpoken, readersInFull } from '../users/readerNames'
import type { ChatPushRequest } from './requests'
import {
  emptyReport,
  liveRegistrations,
  type PushAddress,
  type PushLog,
  type PushMessage,
  type PushReport,
  type PushTransports,
  sendToDevices
} from './send'

/**
 * The most a wake (`common/push.ts`) may encode to with its envelope, in
 * bytes: under the APNs (4096), FCM (4000) and Web Push payload limits with
 * room for each one's own keys.
 */
export const MAX_INLINE_WAKE = 3000

/**
 * How long FCM keeps an Android chat wake for a phone it cannot reach: 8 h,
 * past Doze's longest idle stretch (6 h), so a normal-priority mention still
 * reaches a phone left asleep overnight, and well short of FCM's four weeks,
 * so a phone that was off for days is not handed every wake it missed, each
 * long since read elsewhere.
 */
export const ANDROID_WAKE_TTL_SECONDS = 8 * 60 * 60

/**
 * How old a post may be and still wake anybody: an hour. A wake later than
 * that, after the push sender was down or the request waited out its tries,
 * would notify of a message most people have read in the app by then, on
 * every device at once.
 */
export const STALE_WAKE_MS = 60 * 60 * 1000

/**
 * How long a push service keeps a web chat wake for a browser it cannot
 * reach: `STALE_WAKE_MS`, an hour. A browser has no Doze to sleep through,
 * so a wake it was not handed within the hour was for a browser that was
 * closed, and would arrive, with every other one it missed, as stale as a
 * wake the sender would no longer send.
 */
export const WEB_WAKE_TTL_SECONDS = STALE_WAKE_MS / 1000

/**
 * How long APNs keeps an iOS alert wake (a DM, or a group message with
 * `iosFiltering`) for a phone it cannot reach: an hour, as on the web. An
 * alert goes at priority 10, which APNs hands a reachable phone at once, so
 * one it still holds after an hour was for a phone that was off, and would
 * show, when it came back, a message long since read elsewhere.
 */
export const IOS_ALERT_WAKE_SECONDS = WEB_WAKE_TTL_SECONDS

/**
 * How long APNs keeps an iOS background wake, and a read's clear: 8 h, as an
 * Android wake. Priority 5 is APNs' and iOS's to hold back to suit the
 * phone's battery, as Doze does, so an hour could lose a mention's wake to a
 * phone asleep in a pocket; and a clear must outlive the alert it takes down.
 */
export const IOS_BACKGROUND_WAKE_SECONDS = ANDROID_WAKE_TTL_SECONDS

/** An `apns-expiration`: `seconds` after `now`, in seconds since the epoch. */
export function expiresAfter(now: Date, seconds: number): number {
  return Math.floor(now.getTime() / 1000) + seconds
}

export interface ChatWakeOptions {
  transports: PushTransports
  /** Group messages go to iPhones as alerts the app may hide. */
  iosFiltering: boolean
  log?: PushLog
  /** Now, for `STALE_WAKE_MS`; a post older than that wakes nobody. */
  now?: Date
  /**
   * Told whom a wake may go to, before anything else is read of them, so
   * their reading the conversation from then on takes its notification down
   * from their other devices (`chatReads.ts`). Answers those it marked who
   * had no mark before.
   */
  woke?: (
    userIds: string[],
    conversationId: string,
    seq: number
  ) => Promise<readonly string[]>
  /**
   * Told of those `woke` newly marked who have seen the message after all,
   * so a mark no wake follows does not stay.
   */
  unwoke?: (
    userIds: string[],
    conversationId: string,
    seq: number
  ) => Promise<void>
}

/**
 * Who hears of a message: the conversation's current members, less the
 * sender, anyone in a block with the sender either way, those who muted the
 * chat, and those whose `messages` switch is off.
 */
async function recipientsOf(
  db: Kysely<Database>,
  conversationId: string,
  senderId: string
): Promise<string[]> {
  const members = (
    await db
      .selectFrom('chat_members')
      .select('user_id')
      .where('conversation_id', '=', conversationId)
      .where('left_at', 'is', null)
      .where('user_id', '!=', senderId)
      .execute()
  ).map(row => row.user_id)
  if (members.length === 0) return []
  const [blocking, blockedBy, muted, listening] = await Promise.all([
    blockingRecipientIds(db, senderId),
    blockedSenderIds(db, senderId),
    db
      .selectFrom('chat_conversation_preferences')
      .select('user_id')
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', anyOf(members))
      .where('muted', '=', true)
      .execute()
      .then(rows => new Set(rows.map(row => row.user_id))),
    db
      .selectFrom('user_notification_settings')
      .select('user_id')
      .where('user_id', '=', anyOf(members))
      .where('messages', '=', true)
      .execute()
      .then(rows => new Set(rows.map(row => row.user_id)))
  ])
  const blocked = new Set([...blocking, ...blockedBy])
  return members.filter(
    id => !blocked.has(id) && !muted.has(id) && listening.has(id)
  )
}

/**
 * Those of `recipients` who have seen the message at `seq` already: their
 * read cursor is at it or past it, or they have written in the conversation
 * since, so they are there.
 */
async function seenBy(
  db: Kysely<Database>,
  conversationId: string,
  seq: number,
  recipients: readonly string[]
): Promise<Set<string>> {
  if (recipients.length === 0) return new Set()
  const [read, wrote] = await Promise.all([
    db
      .selectFrom('chat_read_cursors')
      .select('user_id')
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', anyOf(recipients))
      .where('seq', '>=', seq)
      .execute(),
    db
      .selectFrom('chat_messages')
      .select('sender_user_id as user_id')
      .distinct()
      .where('conversation_id', '=', conversationId)
      .where('seq', '>', seq)
      .where('sender_user_id', '=', anyOf(recipients))
      .execute()
  ])
  return new Set([...read, ...wrote].map(row => row.user_id))
}

/**
 * The sender as the public reads them, and in full, as `chatNames` names
 * them for a reader who may not or may read them in full; null for nobody.
 */
async function senderNames(
  db: Kysely<Database>,
  senderId: string
): Promise<{ public: string; full: string } | null> {
  const person = await db
    .selectFrom('users')
    .select([
      'id',
      'display_name as displayName',
      'first_name as firstName',
      'last_name as lastName'
    ])
    .where('id', '=', senderId)
    .executeTakeFirst()
  if (person == null) return null
  const naming = await readerNaming(db, [{ person }], undefined)
  return {
    public: naming.names.get(person.id) ?? person.displayName,
    full:
      formatForReader([{ person, format: 'full' }]).get(person.id) ??
      person.displayName
  }
}

/** The conversation a message is in, as `wakesFor` titles it. */
async function conversationOf(
  db: Kysely<Database>,
  conversationId: string
): Promise<Titled> {
  return await db
    .selectFrom('chat_conversations')
    .select(['id', 'kind', 'scope_type as scopeType', 'scope_id as scopeId'])
    .where('id', '=', conversationId)
    .executeTakeFirstOrThrow()
}

/** Each recipient's wake, with the sender named as that recipient reads them. */
async function wakesFor(
  db: Kysely<Database>,
  message: ChatMessageView,
  conversation: Titled,
  recipients: string[]
): Promise<Map<string, ChatWake>> {
  const title =
    titlesOf(
      [conversation],
      await scopeIdentities(db, scopesOf([conversation]))
    ).get(conversation.id) ?? null
  const sender = message.senderUserId
  const [from, admins] = await Promise.all([
    senderNames(db, sender),
    db
      .selectFrom('users')
      .select('id')
      .where('id', '=', anyOf(recipients))
      .where('is_admin', '=', true)
      .execute()
      .then(rows => new Set(rows.map(row => row.id)))
  ])
  // Who reads the sender in full is each reader's own, asked of them all at
  // once; the names themselves were worked out once above.
  const readsFull =
    from == null
      ? new Set<string>()
      : await readersInFull(
          db,
          recipients.map(userId => ({ userId, isAdmin: admins.has(userId) })),
          sender
        )
  const wakes = new Map<string, ChatWake>()
  for (const userId of recipients) {
    const wake: ChatWake = {
      t: 'chat',
      u: userId,
      c: message.conversationId,
      seq: message.seq,
      dm: conversation.kind === 'dm',
      from:
        from == null
          ? 'Someone'
          : readsFull.has(userId)
            ? from.full
            : from.public,
      title,
      url: `teamstation://chat/${message.conversationId}`
    }
    const inline: ChatWake = { ...wake, env: message }
    wakes.set(
      userId,
      Buffer.byteLength(JSON.stringify(inline)) <= MAX_INLINE_WAKE
        ? inline
        : wake
    )
  }
  return wakes
}

/**
 * Whether a stored subscription (`routes/push.ts`) is to a push service that
 * gets no push that may show nothing (`showsEveryPush`): Safari's and
 * Firefox's, the only Apple and Mozilla hosts that route takes.
 */
export function showsEverything(subscription: string): boolean {
  return showsEveryPush(
    (JSON.parse(subscription) as { endpoint: string }).endpoint
  )
}

/**
 * Whether `wakeMessage` sends `to` anything for a wake of this kind: every
 * device but a Safari or Firefox subscription, for a group message. A
 * subscription that cannot be read is sent to, and fails.
 */
function wakes(to: PushAddress, dm: boolean): boolean {
  if (to.platform !== 'web' || dm) return true
  try {
    return !showsEverything(to.address)
  } catch {
    return true
  }
}

/**
 * A wake in each platform's shape. The device decides what is shown, so a
 * group wake is as quiet as each platform allows:
 *
 * - iOS: a DM is an alert the Notification Service Extension rewrites
 *   (`mutable-content`), with a body for when it cannot, kept by APNs for
 *   `IOS_ALERT_WAKE_SECONDS` after `now`. A group message is the same with
 *   `iosFiltering` (the extension may then hide it), and a background push
 *   kept `IOS_BACKGROUND_WAKE_SECONDS` without it.
 * - Android: data only, kept by FCM for `ANDROID_WAKE_TTL_SECONDS`; a DM at
 *   high priority, a group message at normal, since FCM demotes an app whose
 *   high-priority messages show nothing. No wake collapses into another: the
 *   server cannot tell a mention from a plain message, and a later one would
 *   replace the mention, which then never notifies.
 * - Web: every wake, kept for `WEB_WAKE_TTL_SECONDS`, but no group wake to
 *   Safari, which would show it, or to Firefox, whose quota of silent pushes
 *   would end the subscription.
 */
export function wakeMessage(
  to: PushAddress,
  wake: ChatWake,
  iosFiltering: boolean,
  now: Date = new Date()
): PushMessage | null {
  const text = JSON.stringify(wake)
  switch (to.platform) {
    case 'ios': {
      if (!wake.dm && !iosFiltering)
        return {
          platform: 'ios',
          pushType: 'background',
          priority: 5,
          expiration: expiresAfter(now, IOS_BACKGROUND_WAKE_SECONDS),
          payload: { aps: { 'content-available': 1 }, ...wake }
        }
      const body =
        wake.title == null
          ? `New message from ${wake.from}`
          : `New message in ${wake.title}`
      return {
        platform: 'ios',
        pushType: 'alert',
        priority: 10,
        expiration: expiresAfter(now, IOS_ALERT_WAKE_SECONDS),
        payload: {
          aps: {
            alert: { body },
            'mutable-content': 1,
            sound: 'default',
            // The tag every platform gives a chat's notifications, which a
            // read takes down by.
            'thread-id': chatTag(wake.c)
          },
          ...wake
        }
      }
    }
    case 'android':
      return {
        platform: 'android',
        priority: wake.dm ? 'high' : 'normal',
        ttlSeconds: ANDROID_WAKE_TTL_SECONDS,
        data: { payload: text }
      }
    case 'web':
      if (!wakes(to, wake.dm)) return null
      return {
        platform: 'web',
        payload: text,
        urgency: wake.dm ? 'high' : 'normal',
        ttlSeconds: WEB_WAKE_TTL_SECONDS
      }
  }
}

/**
 * Wakes the devices of everybody `message` should reach (`recipientsOf`), or
 * of those of them in `only`, each with its own `ChatWake`, less those who
 * have seen it (`seenBy`). Only those with a live device to wake are named.
 *
 * Whom a wake may go to is told to `options.woke` before their read cursors
 * are, so a read at any moment is either seen here, and nobody is woken, or
 * finds them marked, and takes the wake down from their other devices (a
 * mark for a device the wake then misses costs a clear that finds nothing).
 * A mark made here for somebody found to have seen the message is taken
 * back (`options.unwoke`).
 *
 * A failure to read who they are, or their devices, throws, and a failure to
 * reach somebody is in the report's `unreached`: the push sender tries
 * either again.
 */
export async function chatWakes(
  db: Kysely<Database>,
  message: ChatMessageView,
  options: ChatWakeOptions,
  only?: readonly string[]
): Promise<PushReport> {
  const { conversationId, seq } = message
  // A mark that fails to be kept, or taken back, costs a clear, never a wake.
  const said =
    (what: string) =>
    (error: unknown): void => {
      ;(options.log ?? console.warn)(
        `push: ${what} ${conversationId} seq ${seq} woken failed: ${String(error)}`
      )
    }
  // Names here go to other people, whoever made the request.
  return await outsideSpoken(async () => {
    const members = await recipientsOf(db, conversationId, message.senderUserId)
    const wanted =
      only == null ? members : members.filter(id => only.includes(id))
    const [live, conversation] = await Promise.all([
      liveRegistrations(db, wanted),
      wanted.length === 0 ? null : conversationOf(db, conversationId)
    ])
    if (conversation == null || live.length === 0) return emptyReport()
    const dm = conversation.kind === 'dm'
    const marked = [
      ...new Set(live.filter(to => wakes(to, dm)).map(to => to.userId))
    ].sort()
    const fresh =
      marked.length === 0 || options.woke == null
        ? []
        : await options
            .woke(marked, conversationId, seq)
            .catch((error: unknown) => {
              said('marking')(error)
              return []
            })
    const seen = await seenBy(db, conversationId, seq, [
      ...new Set(live.map(to => to.userId))
    ])
    const unwoken = fresh.filter(id => seen.has(id))
    if (unwoken.length > 0 && options.unwoke != null)
      await options
        .unwoke(unwoken, conversationId, seq)
        .catch(said('unmarking'))
    const devices = live.filter(to => !seen.has(to.userId))
    const recipients = [...new Set(devices.map(to => to.userId))].sort()
    const wakesOf =
      recipients.length === 0
        ? new Map<string, ChatWake>()
        : await wakesFor(db, message, conversation, recipients)
    // Every device left is a recipient's, so has its wake.
    return await sendToDevices(
      db,
      devices,
      to =>
        wakeMessage(
          to,
          wakesOf.get(to.userId)!,
          options.iosFiltering,
          options.now
        ),
      options.transports,
      options.log
    )
  })
}

/**
 * The push sender's work for a chat request: the post at `seq` wakes the
 * members' devices (`chatWakes`), or nobody when it is not there, not the
 * sender's, not a post, cleared since, or posted more than `STALE_WAKE_MS`
 * before `options.now`, which is said in the log.
 */
export async function wakeChat(
  db: Kysely<Database>,
  request: Pick<ChatPushRequest, 'c' | 'seq' | 'sender' | 'to'>,
  options: ChatWakeOptions
): Promise<PushReport | null> {
  const [message] = await messagesOf(db, request.c, {
    after: request.seq - 1,
    limit: 1
  })
  if (
    message?.seq !== request.seq ||
    message.senderUserId !== request.sender ||
    message.kind !== 'post' ||
    message.clearedAt != null
  )
    return null
  if (
    options.now != null &&
    options.now.getTime() - Date.parse(message.createdAt) > STALE_WAKE_MS
  ) {
    options.log?.(
      `push: no wake for ${request.c} seq ${request.seq}, posted ${message.createdAt}: too old`
    )
    return null
  }
  return await chatWakes(db, message, options, request.to)
}
