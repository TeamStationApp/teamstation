import type {
  NativeSongCandidate,
  NativeWalkUpMusicState,
  Spec
} from './NativeWalkUpMusic'
import type {
  MusicAccess,
  PlaybackState,
  SongCandidate,
  WalkUpMusic
} from './walkUpMusicTypes'

/** What of the TurboModule this needs, so a test can hand in a fake. */
export type WalkUpMusicModule = Pick<
  Spec,
  'access' | 'search' | 'pickFile' | 'play' | 'stop' | 'onWalkUpMusicState'
>

export interface WalkUpMusicOptions {
  /** `ios` or `android`: which store the phone searches. */
  platform: string
  /** Every clip asked for, as it starts: the native module reports none. */
  onPlay?: (clip: WalkUpClip) => void
  /** Every raw state report, for the device log. */
  onReport?: (report: NativeWalkUpMusicState) => void
}

/** A clip as it is handed to the native module. */
export interface WalkUpClip {
  handle: string
  startMs: number
  endMs: number
  fadeInMs: number
  fadeOutMs: number
}

const ACCESS: readonly MusicAccess[] = [
  'authorized',
  'denied',
  'restricted',
  'unavailable'
]

/**
 * The phone's `WalkUpMusic`, over the native module.
 *
 * The module speaks in flat strings and numbers, because that is what
 * codegen carries; this turns them into the adapter the screens use — an
 * access answer from a fixed list, candidates checked field by field, state
 * reports as `PlaybackState`, fades as two numbers — and an error from the
 * module into an `Error` carrying the store's own message, which the picker
 * shows as it is.
 */
export function makeWalkUpMusic(
  module: WalkUpMusicModule,
  options: WalkUpMusicOptions
): WalkUpMusic {
  const listeners = new Set<(state: PlaybackState) => void>()

  // One native subscription for the life of the app, made at once: every
  // report is logged whether or not a screen is listening — the iPhone's
  // volume restore after a killed clip arrives before any screen does — and
  // a subscription per screen would only multiply them.
  module.onWalkUpMusicState(report => {
    options.onReport?.(report)
    const state = asPlaybackState(report)
    if (state == null) return
    for (const listener of [...listeners]) listener(state)
  })

  return {
    available: true,
    djSupported: options.platform === 'ios',
    providerName: options.platform === 'ios' ? 'Apple Music' : 'This phone',
    async access() {
      const answer = await module.access().catch(() => 'unavailable')
      return ACCESS.includes(answer as MusicAccess)
        ? (answer as MusicAccess)
        : 'unavailable'
    },
    async search(term) {
      const found = await module.search(term).catch(rethrow)
      return found.flatMap(raw => {
        const candidate = asCandidate(raw)
        return candidate == null ? [] : [candidate]
      })
    },
    async pickFile() {
      const picked = await module.pickFile().catch(rethrow)
      return picked == null ? null : asCandidate(picked)
    },
    async play(handle, startMs, endMs, fade) {
      options.onPlay?.({
        handle,
        startMs,
        endMs,
        fadeInMs: fade.inMs,
        fadeOutMs: fade.outMs
      })
      await module
        .play(handle, startMs, endMs, fade.inMs, fade.outMs)
        .catch(rethrow)
    },
    async stop(fadeMs) {
      await module.stop(fadeMs).catch(rethrow)
    },
    onState(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/** A native report as a `PlaybackState`, or null for one that is not one. */
export function asPlaybackState(
  report: NativeWalkUpMusicState
): PlaybackState | null {
  if (report.kind === 'idle') return { kind: 'idle' }
  if (report.kind === 'playing') {
    return {
      kind: 'playing',
      handle: report.handle ?? '',
      positionMs: report.positionMs ?? 0
    }
  }
  if (report.kind === 'error') {
    return { kind: 'error', message: report.message ?? 'Playback failed' }
  }
  return null
}

/** A candidate with every field the song will need, or null. */
export function asCandidate(raw: NativeSongCandidate): SongCandidate | null {
  const provider =
    raw.provider === 'appleMusic' || raw.provider === 'localFile'
      ? raw.provider
      : null
  const source =
    raw.source === 'catalog' ||
    raw.source === 'library' ||
    raw.source === 'device'
      ? raw.source
      : null
  if (
    provider == null ||
    source == null ||
    raw.providerId === '' ||
    raw.handle === '' ||
    raw.title.trim() === '' ||
    !(raw.durationMs > 0)
  ) {
    return null
  }
  return {
    provider,
    providerId: raw.providerId,
    isrc: blankToNull(raw.isrc),
    title: raw.title.trim(),
    artist: raw.artist.trim() === '' ? '—' : raw.artist.trim(),
    album: blankToNull(raw.album),
    artworkUrl: blankToNull(raw.artworkUrl),
    durationMs: Math.round(raw.durationMs),
    source,
    handle: raw.handle
  }
}

function blankToNull(text: string | null | undefined): string | null {
  return text == null || text.trim() === '' ? null : text.trim()
}

function rethrow(caught: unknown): never {
  if (caught instanceof Error) throw caught
  throw new Error(String(caught))
}
