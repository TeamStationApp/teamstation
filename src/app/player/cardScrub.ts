/**
 * The event page's video card and its scrub line: where a point along the
 * line takes the video, and how long the card's controls stay up.
 */

/** How long a group of the card's controls stays up after a press or hover. */
export const CARD_HIDE_MS = 1000

/**
 * Seconds into the video for a point `fraction` of the way along the card's
 * scrub line: across its length, or, live, across what can be reached so
 * far. Null when neither is known yet.
 */
export function cardSeekTarget(
  fraction: number,
  video: { duration: number; seekableEnd: number | null }
): number | null {
  const at = Math.min(1, Math.max(0, fraction))
  if (Number.isFinite(video.duration) && video.duration > 0)
    return at * video.duration
  if (video.seekableEnd != null && video.seekableEnd > 0)
    return at * video.seekableEnd
  return null
}
