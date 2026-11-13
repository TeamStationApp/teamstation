import {
  asBoolean,
  asEither,
  asNull,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'

import { asChatMessage, type ChatMessage } from './api'
import { asLiteral } from './asLiteral'

/**
 * What a push carries to a phone or a browser, as the server sends it
 * (`server/push/chatWakes.ts`, `server/push/rsvpReminders.ts`) and the
 * devices read it.
 */

/**
 * What a new chat message tells each member's devices. It holds nothing the
 * server could read of the message: the device opens `env` (or fetches it)
 * with its own keys, and shows a notification only for a DM or a mention of
 * `u`.
 */
const cleanChatWake = asObject({
  t: asLiteral('chat'),
  /** The recipient: which of the device's key records opens it. */
  u: asString,
  /** The conversation. */
  c: asString,
  seq: asNumber,
  dm: asBoolean,
  /** The sender's name as this recipient reads it. */
  from: asString,
  /** The chat's title (`titlesOf`); null for a DM. */
  title: asEither(asNull, asString),
  url: asString,
  /**
   * The stored envelope as `GET …/messages` answers it, when the wake stays
   * within `MAX_INLINE_WAKE`; otherwise the device fetches
   * `GET /chat/conversations/:c/messages?after=<seq - 1>&limit=1`.
   */
  env: asOptional(asChatMessage)
})
export type ChatWake = Omit<ReturnType<typeof cleanChatWake>, 'env'> & {
  env?: ChatMessage
}
/** A wake, with an absent envelope left out rather than undefined. */
export const asChatWake: Cleaner<ChatWake> = raw => {
  const { env, ...wake } = cleanChatWake(raw)
  return env == null ? wake : { ...wake, env }
}

/** What an event's reminder tells one person's devices. */
export const asEventReminder = asObject({
  t: asLiteral('event'),
  /** The recipient. */
  u: asString,
  /** The event's name: "Hawks vs Owls", or a team event's title. */
  title: asString,
  /** "Starts at 5:30 PM", after the player's name for a guardian. */
  body: asString,
  /** `teamstation://games/<eventId>`, for a game and a team event alike. */
  url: asString,
  /** `event:<eventId>`: one notification an event. */
  tag: asString
})
export type EventReminder = ReturnType<typeof asEventReminder>

/**
 * What a person's reading a conversation tells their other devices, after a
 * wake reached them there: take down the notifications tagged `chat:<c>`.
 * It shows nothing.
 */
export const asChatRead = asObject({
  t: asLiteral('read'),
  /** Who read. */
  u: asString,
  c: asString,
  /** Where their read cursor moved to. */
  seq: asNumber
})
export type ChatRead = ReturnType<typeof asChatRead>

/**
 * Web Push services that count against the subscription each push that shows
 * nothing: Safari's ends the subscription, and Firefox's spends a quota that
 * ends it once it is gone, after which that browser hears of nothing at all.
 * These subscriptions get no push that may show nothing (a group wake, a
 * read), and a browser on one shows every push it is sent.
 */
export const SHOW_EVERY_PUSH_HOSTS: ReadonlySet<string> = new Set([
  'web.push.apple.com',
  'updates.push.services.mozilla.com'
])

/** Whether a subscription to `endpoint` must show every push it is sent. */
export function showsEveryPush(endpoint: string): boolean {
  return SHOW_EVERY_PUSH_HOSTS.has(new URL(endpoint).hostname)
}

/** The tag every platform gives a conversation's notifications. */
export function chatTag(conversationId: string): string {
  return `chat:${conversationId}`
}

/** Any push, told apart by `t`. */
export const asPushPayload = asEither(asChatWake, asEventReminder, asChatRead)
export type PushPayload = ReturnType<typeof asPushPayload>
