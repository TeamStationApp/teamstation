import type { KeyObject } from 'node:crypto'
import {
  type ClientHttp2Session,
  connect,
  constants,
  type OutgoingHttpHeaders
} from 'node:http2'

import { privateKeyOf, signJwt } from './jwt'
import type {
  PushAddress,
  PushEnvironment,
  PushResult,
  PushTransport
} from './send'

export interface ApnsSettings {
  keyId: string
  teamId: string
  /** The auth key (`AuthKey_<keyId>.p8`) as PEM. */
  p8Key: string
  /** The app's bundle id. */
  topic: string
}

/** One APNs notification. */
export interface ApnsMessage {
  platform: 'ios'
  /** An alert is shown; a background push only wakes the app. */
  pushType: 'alert' | 'background'
  /** 10 delivers at once; 5 when it suits the phone (a background push). */
  priority: 10 | 5
  /** The JSON body: `aps` and the app's own keys. */
  payload: Record<string, unknown>
  /** Notifications with the same id replace each other on the phone. */
  collapseId?: string
  /** Seconds since the epoch after which APNs stops trying; 0 tries once. */
  expiration?: number
}

/** Where each environment's notifications go. */
export const APNS_ORIGINS: Record<PushEnvironment, string> = {
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com'
}

/** Apple refuses a provider token older than an hour; it is made anew sooner. */
export const PROVIDER_TOKEN_MS = 50 * 60_000

export interface ApnsOptions {
  /** The origin for each environment, which a test points at its own server. */
  origins?: Record<PushEnvironment, string>
  connect?: (origin: string) => ClientHttp2Session
  now?: () => number
  timeoutMs?: number
}

/** A transport that can also let go of its connections. */
export interface ApnsTransport extends PushTransport<ApnsMessage> {
  close: () => void
}

/** The provider token: ES256, the key's id in the header, the team as issuer. */
export function providerToken(
  settings: Pick<ApnsSettings, 'keyId' | 'teamId'>,
  key: KeyObject,
  issuedAtMs: number
): string {
  return signJwt(
    'ES256',
    { kid: settings.keyId },
    { iss: settings.teamId, iat: Math.floor(issuedAtMs / 1000) },
    key
  )
}

/**
 * A token APNs says will never reach a device again. `BadDeviceToken` is not
 * one: Apple answers it as well for a good token sent to the other
 * environment, so it is logged with the registration's environment and kept.
 */
const GONE_REASONS = new Set(['Unregistered'])
/**
 * The 400s about the token itself, which no later send to it gets past.
 * Every other 400 is about the server's settings or the message
 * (`BadTopic`, `MissingTopic`, `TopicDisallowed`, `BadExpirationDate`,
 * `BadPriority`, `BadCollapseId`, `PayloadEmpty` and so on): the message is
 * refused, but the token is as good as it was.
 */
const TOKEN_REFUSALS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic'])
/** The 400s a later try may get past. */
const PASSING_REASONS = new Set(['IdleTimeout'])
/** A provider token APNs no longer takes, which is made anew. */
const TOKEN_REASONS = new Set(['ExpiredProviderToken', 'InvalidProviderToken'])

/**
 * APNs over HTTP/2, one connection per environment, kept open between sends
 * until it closes or fails. One that leaves a send unanswered takes no new
 * sends, and closes once those under way on it have ended.
 * The registration's environment picks the server: a development build's
 * token is only good on the sandbox.
 */
export function apnsTransport(
  settings: ApnsSettings,
  options: ApnsOptions = {}
): ApnsTransport {
  const origins = options.origins ?? APNS_ORIGINS
  const open = options.connect ?? (origin => connect(origin))
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 10_000
  const key = privateKeyOf(settings.p8Key)
  const sessions = new Map<string, ClientHttp2Session>()
  let token: { value: string; issuedAt: number } | null = null

  const bearer = (): string => {
    const at = now()
    if (token == null || at - token.issuedAt >= PROVIDER_TOKEN_MS)
      token = { value: providerToken(settings, key, at), issuedAt: at }
    return token.value
  }
  const sessionFor = (origin: string): ClientHttp2Session => {
    const held = sessions.get(origin)
    if (held != null && !held.closed && !held.destroyed) return held
    const session = open(origin)
    const forget = (): void => {
      if (sessions.get(origin) === session) sessions.delete(origin)
    }
    session.on('close', forget)
    session.on('goaway', forget)
    session.on('error', forget)
    sessions.set(origin, session)
    return session
  }
  const retire = (origin: string, session: ClientHttp2Session): void => {
    if (sessions.get(origin) === session) sessions.delete(origin)
    if (session.closed || session.destroyed) return
    // Past the longest a send under way on it can take, it goes anyway.
    const deadline = setTimeout(() => {
      session.destroy()
    }, timeoutMs)
    session.once('close', () => {
      clearTimeout(deadline)
    })
    session.close()
  }
  const post = async (
    origin: string,
    headers: OutgoingHttpHeaders,
    body: string
  ): Promise<{ status: number; body: string }> =>
    await new Promise((resolve, reject) => {
      const session = sessionFor(origin)
      const stream = session.request(headers)
      let status = 0
      let text = ''
      stream.setEncoding('utf8')
      // A stream with no answer is most likely a connection a network blip
      // left half open, which every later send would wait on in turn: the
      // next send connects afresh, and this one closes once the sends under
      // way on it have answered or timed out themselves, which none outlasts
      // by more than `timeoutMs`. A send APNs took but answered too late is
      // cut off all the same: it counts as failed, and its person may be
      // sent it twice.
      stream.setTimeout(timeoutMs, () => {
        stream.close(constants.NGHTTP2_CANCEL)
        retire(origin, session)
        reject(new Error(`no answer in ${timeoutMs} ms`))
      })
      stream.on('response', response => {
        status = Number(response[':status'])
      })
      stream.on('data', (chunk: string) => {
        text += chunk
      })
      stream.on('end', () => {
        resolve({ status, body: text })
      })
      stream.on('error', reject)
      stream.end(body)
    })

  return {
    async send(to: PushAddress, message: ApnsMessage): Promise<PushResult> {
      const headers: OutgoingHttpHeaders = {
        ':method': 'POST',
        ':path': `/3/device/${encodeURIComponent(to.address)}`,
        authorization: `bearer ${bearer()}`,
        'apns-topic': settings.topic,
        'apns-push-type': message.pushType,
        'apns-priority': String(message.priority),
        'content-type': 'application/json'
      }
      if (message.collapseId != null)
        headers['apns-collapse-id'] = message.collapseId
      if (message.expiration != null)
        headers['apns-expiration'] = String(message.expiration)
      let answer: { status: number; body: string }
      try {
        answer = await post(
          origins[to.environment],
          headers,
          JSON.stringify(message.payload)
        )
      } catch (error) {
        return { status: 'failed', reason: String(error) }
      }
      if (answer.status === 200) return { status: 'sent' }
      const reason = reasonOf(answer.body) ?? `HTTP ${answer.status}`
      if (answer.status === 410 || GONE_REASONS.has(reason))
        return { status: 'gone', reason }
      if (answer.status === 400 && TOKEN_REFUSALS.has(reason))
        return {
          status: 'rejected',
          reason:
            reason === 'BadDeviceToken'
              ? `${reason} for a ${to.environment} token`
              : reason
        }
      if (answer.status === 400 && !PASSING_REASONS.has(reason))
        return { status: 'refused', reason }
      if (TOKEN_REASONS.has(reason)) token = null
      return { status: 'failed', reason }
    },
    close() {
      for (const session of sessions.values()) session.close()
      sessions.clear()
    }
  }
}

/** APNs's `{ "reason": … }`, or null for a body without one. */
function reasonOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown } | null
    return typeof parsed?.reason === 'string' ? parsed.reason : null
  } catch {
    return null
  }
}
