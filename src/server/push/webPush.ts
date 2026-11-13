import { generateRequestDetails, type PushSubscription } from 'web-push'

import type { PushAddress, PushResult, PushTransport } from './send'

export interface WebPushSettings {
  /** The VAPID pair, base64url: the public key is what browsers subscribe with. */
  publicKey: string
  privateKey: string
  /** `mailto:` or `https:`: who a push service writes to about this sender. */
  subject: string
}

/** One Web Push message: its payload is encrypted to the subscription. */
export interface WebPushMessage {
  platform: 'web'
  /** What the service worker's `push` event reads, as text. */
  payload: string
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
  ttlSeconds?: number
  /** Messages with the same topic replace each other while undelivered. */
  topic?: string
}

export interface WebPushOptions {
  fetch?: typeof fetch
  /** How long a push service has to answer, as APNs and FCM. */
  timeoutMs?: number
}

/**
 * Web Push with VAPID through the `web-push` package, which signs the VAPID
 * header and encrypts the payload as `aes128gcm`; the request is sent here,
 * so a test sees exactly what a push service would.
 */
export function webPushTransport(
  settings: WebPushSettings,
  options: WebPushOptions = {}
): PushTransport<WebPushMessage> {
  const fetcher = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  return {
    async send(to: PushAddress, message: WebPushMessage): Promise<PushResult> {
      let response: Response
      try {
        const subscription = JSON.parse(to.address) as PushSubscription
        const request = generateRequestDetails(subscription, message.payload, {
          vapidDetails: settings,
          contentEncoding: 'aes128gcm',
          TTL: message.ttlSeconds ?? 24 * 60 * 60,
          ...(message.urgency == null ? {} : { urgency: message.urgency }),
          ...(message.topic == null ? {} : { topic: message.topic })
        })
        const headers = Object.fromEntries(
          Object.entries(request.headers)
            .filter(([name]) => name.toLowerCase() !== 'content-length')
            .map(([name, value]) => [name, String(value)])
        )
        response = await fetcher(request.endpoint, {
          method: request.method,
          headers,
          body: request.body,
          signal: AbortSignal.timeout(timeoutMs)
        })
      } catch (error) {
        return { status: 'failed', reason: String(error) }
      }
      // Nothing in the answer is read: it is let go, so the connection goes
      // back to the pool.
      await response.body?.cancel().catch(() => undefined)
      if (response.ok) return { status: 'sent' }
      const reason = `HTTP ${response.status}`
      if (response.status === 404 || response.status === 410)
        return { status: 'gone', reason }
      // A malformed subscription, or one made with another VAPID key, is
      // refused again however often it is sent.
      if (response.status === 400 || response.status === 403)
        return { status: 'rejected', reason }
      return { status: 'failed', reason }
    }
  }
}
