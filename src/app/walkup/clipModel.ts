import { CLIP_MAX_MS, CLIP_MIN_MS } from '../../common/walkUpSong'

/** The part of a song that plays: `startMs` to `endMs`. */
export interface Clip {
  startMs: number
  endMs: number
}

/** Every clip is fifteen seconds, or the whole song when that is shorter. */
export const DEFAULT_CLIP_MS = 15000
/** How far back from the end "Play from here" starts. */
export const PLAY_FROM_HERE_MS = 3000
/** The window moves in tenths of a second, which is what the readouts show. */
const STEP_MS = 100

function snap(ms: number): number {
  return Math.round(ms / STEP_MS) * STEP_MS
}

/** How long the clip is for a song of `durationMs`. */
export function clipSpan(durationMs: number): number {
  return Math.min(Math.max(0, durationMs), DEFAULT_CLIP_MS)
}

/**
 * A fifteen-second window whose start is `startMs`, kept inside the song.
 * A song shorter than fifteen seconds is the whole song.
 */
export function placeClip(startMs: number, durationMs: number): Clip {
  const span = clipSpan(durationMs)
  if (durationMs <= span) return { startMs: 0, endMs: durationMs }
  const latest = durationMs - span
  const clamped = Math.max(0, Math.min(startMs, latest))
  if (clamped === latest) return { startMs: latest, endMs: durationMs }
  const start = Math.min(snap(clamped), latest)
  return { startMs: start, endMs: start + span }
}

/** A new song's clip: the first fifteen seconds, or the whole of a short song. */
export function defaultClip(durationMs: number): Clip {
  return placeClip(0, durationMs)
}

/** Slides the whole window by `deltaMs`. The length stays fifteen seconds. */
export function nudge(clip: Clip, deltaMs: number, durationMs: number): Clip {
  return placeClip(clip.startMs + deltaMs, durationMs)
}

/**
 * A saved clip brought to fifteen seconds inside this copy of the song,
 * keeping its start where it can.
 */
export function fitClip(clip: Clip, durationMs: number): Clip {
  if (durationMs < CLIP_MIN_MS) return { startMs: 0, endMs: durationMs }
  return placeClip(clip.startMs, durationMs)
}

/** Whether the clip may be saved: fifteen seconds, inside the song. */
export function clipValid(clip: Clip, durationMs: number): boolean {
  const span = clipSpan(durationMs)
  const length = clip.endMs - clip.startMs
  return (
    clip.startMs >= 0 &&
    clip.endMs <= durationMs &&
    length === span &&
    length >= CLIP_MIN_MS &&
    length <= CLIP_MAX_MS
  )
}

/** The last few seconds before the window ends, to hear where it cuts. */
export function playFromHere(clip: Clip): Clip {
  return {
    startMs: Math.max(clip.startMs, clip.endMs - PLAY_FROM_HERE_MS),
    endMs: clip.endMs
  }
}

/** Where a point `x` along a timeline `width` wide falls in the song. */
export function msAt(x: number, width: number, durationMs: number): number {
  if (width <= 0) return 0
  return Math.max(0, Math.min(durationMs, (x / width) * durationMs))
}

/** A window's readout: `1:05.3`. */
export function formatTenths(ms: number): string {
  const tenths = Math.round(ms / 100)
  const minutes = Math.floor(tenths / 600)
  const seconds = Math.floor((tenths % 600) / 10)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`
}

/** A song's length in a list: `3:53`. */
export function formatLength(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
