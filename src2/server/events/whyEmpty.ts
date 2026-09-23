/**
 * Why a game with plays produced no seek points.
 *
 * An empty list with no explanation reads as a broken feature. A highlight is
 * placed by subtracting the video's start from the moment the scorekeeper
 * tapped, and some games were scored from the video afterwards. Those taps
 * are real; they say when somebody sat down with the recording, not when the
 * ball was hit.
 */
export function whyEmpty(
  highlights: unknown[],
  events: Array<{ startTime: unknown }>,
  video: { startAt: unknown; durationSec: number | null }
): string | null {
  if (highlights.length > 0) return null
  if (events.length === 0) return null

  const timed = events.filter(event => event.startTime != null)
  if (timed.length === 0) return 'noPlayTimes'
  if (video.startAt == null) return 'noVideoStart'
  return 'scoredAfterRecording'
}
