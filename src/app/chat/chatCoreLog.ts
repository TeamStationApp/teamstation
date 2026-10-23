import type { CoreUnavailableReason } from '../../common/chatCrypto/coreCall'
import { HttpError } from '../../common/errors'
import { UnreadableKeyRecordError } from './keyRecord'

type Post = (url: string, body: string) => Promise<unknown>

const defaultPost: Post = async (url, body) =>
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  })

/**
 * Why chat's crypto core is not there, to the console and to the server's
 * `/logs` as `[client chatCore-<platform>]`, each reason once for as long as
 * this log lives (the app makes one per page). A post that fails is dropped.
 */
export function chatCoreLog(
  apiBaseUrl: string,
  platform: string,
  post: Post = defaultPost
): (reason: CoreUnavailableReason) => void {
  const told = new Set<CoreUnavailableReason>()
  return reason => {
    if (told.has(reason)) return
    told.add(reason)
    const text = `Chat crypto core unavailable: ${reason}`
    console.warn(text)
    const body = JSON.stringify({
      source: `chatCore-${platform}`,
      run: Math.random().toString(36).slice(2, 10),
      lines: [
        { at: new Date().toISOString(), level: 'warn', text, data: { reason } }
      ]
    })
    post(`${apiBaseUrl}/logs`, body).catch(() => undefined)
  }
}

/**
 * Why chat did not start, in words that carry nothing of the keys:
 * `storedRecord:<reason>` for a saved record this device cannot read,
 * `http:<code>` for a server's answer, or the error's name.
 */
export function chatStartFailure(error: unknown): string {
  if (error instanceof UnreadableKeyRecordError)
    return `storedRecord:${error.reason}`
  if (error instanceof HttpError) return `http:${error.code}`
  return error instanceof Error ? error.name : typeof error
}

/**
 * Why chat did not start on this device (`ChatGate`), to the console and to
 * the server's `/logs` as `[client chatStart-<platform>]`, each reason once
 * for as long as this log lives. A post that fails is dropped.
 */
export function chatStartLog(
  apiBaseUrl: string,
  platform: string,
  post: Post = defaultPost
): (error: unknown) => void {
  const told = new Set<string>()
  return error => {
    const reason = chatStartFailure(error)
    if (told.has(reason)) return
    told.add(reason)
    const text = `Chat could not start: ${reason}`
    console.warn(text)
    const body = JSON.stringify({
      source: `chatStart-${platform}`,
      run: Math.random().toString(36).slice(2, 10),
      lines: [
        { at: new Date().toISOString(), level: 'warn', text, data: { reason } }
      ]
    })
    post(`${apiBaseUrl}/logs`, body).catch(() => undefined)
  }
}
