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
  const text = JSON.stringify(error ?? {})
  if (/InvalidResponseCode|BadServerResponse/i.test(text)) return true
  // A 4xx anywhere in the message. Not 5xx: a server having a bad minute is a
  // transport failure and a fresh URL would not help.
  return /\b4\d\d\b/.test(text)
}
