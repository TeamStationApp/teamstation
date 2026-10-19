import type { OnVideoErrorData } from 'react-native-video'

/**
 * Whether the address itself is what is wrong, rather than the network.
 *
 * The distinction decides everything that follows. A playback URL carries a
 * signed, short-lived token; when that has expired the server answers 403 and
 * **asking again for the same URL can never work**. Retrying it on a rising
 * ladder means thirty attempts at an address that is dead, over five minutes,
 * in front of a parent watching a frozen picture — while the fix, a fresh URL
 * from `/videos/:id/playback`, is one call away and is exactly what the
 * caller's `onGiveUp` does.
 *
 * A field that has lost its signal is the opposite case and wants the ladder.
 *
 * Neither platform reports this in a structured way, so the text is what there
 * is: ExoPlayer raises `InvalidResponseCodeException` with the status in it,
 * and AVFoundation a `NSURLError` with the response code beside it. Anything
 * unrecognised is treated as the network, which is the safer way to be wrong —
 * it costs patience rather than a working stream.
 */
export function addressIsWrong(error: OnVideoErrorData): boolean {
  const text = messageOf(error)
  if (/InvalidResponseCode|BadServerResponse/i.test(text)) return true
  // AVFoundation's HTTP 403 for a stream: CoreMedia's -12660, alone in the
  // code or quoted in the reason.
  if (/-12660\b/.test(text)) return true
  // ExoPlayer names the status only in the cause at the foot of its stack.
  if (
    /InvalidResponseCodeException: Response code: 40[13]\b/.test(stackOf(error))
  )
    return true
  // A refusal in the words of the message. Only 401 and 403: the media routes
  // answer those for a bad token, while a 404 can be a live playlist missing
  // for a moment while its writer restarts. Not 5xx either: a server having a
  // bad minute is a transport failure and a fresh URL would not help.
  return /\b40[13]\b/.test(text)
}

/**
 * The words of an error, without its stack.
 *
 * Android hands up the stack trace and its line numbers beside the message,
 * and a frame on any line from 400 to 499 — `DefaultHttpDataSource.java:412`
 * — read as a status code: a phone that lost its signal was told its address
 * had been refused.
 */
const MESSAGE_FIELDS = [
  'errorString',
  'errorException',
  'errorCode',
  'localizedDescription',
  'localizedFailureReason',
  'code',
  'domain'
] as const

function detailOf(
  error: OnVideoErrorData | null | undefined
): Record<string, unknown> | string | undefined {
  const detail = (error as { error?: unknown } | null | undefined)?.error
  if (typeof detail === 'string') return detail
  if (detail == null || typeof detail !== 'object') return undefined
  return detail as Record<string, unknown>
}

function stackOf(error: OnVideoErrorData | null | undefined): string {
  const detail = detailOf(error)
  if (detail == null || typeof detail === 'string') return ''
  const stack = detail.errorStackTrace
  return typeof stack === 'string' ? stack : ''
}

function messageOf(error: OnVideoErrorData | null | undefined): string {
  const detail = detailOf(error)
  if (typeof detail === 'string') return detail
  if (detail == null) return ''
  const fields = detail
  return MESSAGE_FIELDS.map(key => fields[key])
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .join(' ')
}
