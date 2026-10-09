import type { Event, EventHint } from '@sentry/core'

/**
 * Whether an error is one the screen already explains, and so not reported:
 * an `HttpError` (an answer from the API, which the screen shows) or the
 * network failure the API client raises as `offline`.
 */
export function isExplained(
  event: Event,
  hint: EventHint | undefined
): boolean {
  // Only the error that was thrown counts: one whose `cause` is an HttpError
  // is an unplanned failure, and Sentry lists the cause chain first.
  const original = hint?.originalException
  if (original instanceof Error) return original.name === 'HttpError'
  return event.exception?.values?.at(-1)?.type === 'HttpError'
}
