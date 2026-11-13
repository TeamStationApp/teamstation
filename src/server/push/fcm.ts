import type { KeyObject } from 'node:crypto'

import { privateKeyOf, signJwt } from './jwt'
import type { PushAddress, PushResult, PushTransport } from './send'

export interface FcmSettings {
  projectId: string
  /** The service account's email, which issues the OAuth grant. */
  clientEmail: string
  /** The service account's private key as PEM. */
  privateKey: string
}

/** One data-only FCM message: the app decides what, if anything, is shown. */
export interface FcmMessage {
  platform: 'android'
  /** High wakes a dozing phone at once; normal waits for its next window. */
  priority: 'high' | 'normal'
  /** FCM carries data as strings only. */
  data: Record<string, string>
  ttlSeconds?: number
  collapseKey?: string
}

export const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const FCM_ORIGIN = 'https://fcm.googleapis.com'
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

export interface FcmOptions {
  fetch?: typeof fetch
  tokenUrl?: string
  origin?: string
  now?: () => number
  /** How long the token endpoint and each send have to answer, as APNs. */
  timeoutMs?: number
}

/** The service account's grant: an RS256 JWT for Google's token endpoint. */
export function grantAssertion(
  settings: Pick<FcmSettings, 'clientEmail'>,
  key: KeyObject,
  issuedAtMs: number,
  tokenUrl = FCM_TOKEN_URL
): string {
  const iat = Math.floor(issuedAtMs / 1000)
  return signJwt(
    'RS256',
    { typ: 'JWT' },
    {
      iss: settings.clientEmail,
      scope: FCM_SCOPE,
      aud: tokenUrl,
      iat,
      exp: iat + 3600
    },
    key
  )
}

/** The v1 `messages:send` body for one device. */
export function fcmBody(token: string, message: FcmMessage): unknown {
  return {
    message: {
      token,
      data: message.data,
      android: {
        priority: message.priority === 'high' ? 'HIGH' : 'NORMAL',
        ...(message.ttlSeconds == null
          ? {}
          : { ttl: `${message.ttlSeconds}s` }),
        ...(message.collapseKey == null
          ? {}
          : { collapseKey: message.collapseKey })
      }
    }
  }
}

interface AccessToken {
  value: string
  expiresAt: number
}

/**
 * FCM's HTTP v1 API. The OAuth access token is fetched with the service
 * account's grant, shared by every send in flight, and kept until a minute
 * before it expires.
 */
export function fcmTransport(
  settings: FcmSettings,
  options: FcmOptions = {}
): PushTransport<FcmMessage> {
  const fetcher = options.fetch ?? fetch
  const tokenUrl = options.tokenUrl ?? FCM_TOKEN_URL
  const origin = options.origin ?? FCM_ORIGIN
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 10_000
  const key = privateKeyOf(settings.privateKey)
  let cached: AccessToken | null = null
  let pending: Promise<AccessToken> | null = null

  const fetchToken = async (): Promise<AccessToken> => {
    const at = now()
    const response = await fetcher(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(timeoutMs),
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: grantAssertion(settings, key, at, tokenUrl)
      }).toString()
    })
    if (!response.ok)
      throw new Error(`the token endpoint answered HTTP ${response.status}`)
    const body = (await response.json()) as {
      access_token?: unknown
      expires_in?: unknown
    }
    if (typeof body.access_token !== 'string')
      throw new Error('the token endpoint sent no access token')
    const seconds = typeof body.expires_in === 'number' ? body.expires_in : 3600
    return { value: body.access_token, expiresAt: at + (seconds - 60) * 1000 }
  }
  const accessToken = async (): Promise<string> => {
    if (cached != null && cached.expiresAt > now()) return cached.value
    pending ??= fetchToken().finally(() => {
      pending = null
    })
    cached = await pending
    return cached.value
  }

  return {
    async send(to: PushAddress, message: FcmMessage): Promise<PushResult> {
      let response: Response
      try {
        response = await fetcher(
          `${origin}/v1/projects/${encodeURIComponent(settings.projectId)}/messages:send`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${await accessToken()}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify(fcmBody(to.address, message)),
            signal: AbortSignal.timeout(timeoutMs)
          }
        )
      } catch (error) {
        return { status: 'failed', reason: String(error) }
      }
      // Read to the end either way, so the connection goes back to the pool.
      const text = await response.text().catch(() => '')
      if (response.ok) return { status: 'sent' }
      const { code, token } = errorOf(text)
      const reason = code ?? `HTTP ${response.status}`
      // Only UNREGISTERED says the token is dead: a bare 404, or one for a
      // wrong project, would otherwise delete every registration it touches.
      if (code === 'UNREGISTERED') return { status: 'gone', reason }
      // A token for another sender, or one FCM will not take, is refused
      // again however often it is sent.
      if (
        code === 'SENDER_ID_MISMATCH' ||
        (code === 'INVALID_ARGUMENT' && token)
      )
        return { status: 'rejected', reason }
      // Any other INVALID_ARGUMENT is about the message, not the token.
      if (code === 'INVALID_ARGUMENT') return { status: 'refused', reason }
      if (response.status === 401) cached = null
      return { status: 'failed', reason }
    }
  }
}

/** The part of FCM's error body this reads. */
interface FcmErrorBody {
  error?: {
    status?: unknown
    details?: Array<{
      errorCode?: unknown
      fieldViolations?: Array<{ field?: unknown }>
    }>
  }
}

/**
 * The FcmError `errorCode` of a failed send, or its status, and whether a
 * `BadRequest` detail names the message's token as the field it refused.
 */
function errorOf(text: string): { code: string | null; token: boolean } {
  let parsed: FcmErrorBody | null
  try {
    parsed = JSON.parse(text) as FcmErrorBody | null
  } catch {
    return { code: null, token: false }
  }
  const details = Array.isArray(parsed?.error?.details)
    ? parsed.error.details
    : []
  const token = details.some(
    item =>
      Array.isArray(item?.fieldViolations) &&
      item.fieldViolations.some(
        violation => violation?.field === 'message.token'
      )
  )
  const detail = details.find(item => typeof item?.errorCode === 'string')
  if (typeof detail?.errorCode === 'string')
    return { code: detail.errorCode, token }
  const status = parsed?.error?.status
  return { code: typeof status === 'string' ? status : null, token }
}
