import type { WalkUpSong } from '../../common/walkUpSong'

/**
 * A song as this phone's music search found it: what a walk-up song stores,
 * without the clip, plus where it was found and how to play it here.
 */
export interface SongCandidate extends Omit<WalkUpSong, 'startMs' | 'endMs'> {
  source: 'catalog' | 'library' | 'device'
  /** Device-local: a catalog or library id on iOS, a content URI on Android. */
  handle: string
}

export type MusicAccess = 'authorized' | 'denied' | 'restricted' | 'unavailable'

export type PlaybackState =
  | { kind: 'idle' }
  | { kind: 'playing'; handle: string; positionMs: number }
  | { kind: 'error'; message: string }

/**
 * The phone's music: Apple Music and the library on an iPhone, the files on
 * an Android phone. Everything the walk-up screens do with sound goes
 * through this, so a screen never knows which of them it is talking to.
 */
export interface WalkUpMusic {
  /** False on the web, which has no music to search or play. */
  available: boolean
  /**
   * Whether this phone offers DJ Game: an iPhone only. Android plays
   * walk-up files from the scoring screen but has no DJ Game.
   */
  djSupported: boolean
  providerName: string
  access: () => Promise<MusicAccess>
  search: (term: string) => Promise<SongCandidate[]>
  /** Android: the system file picker. iOS: always null. */
  pickFile: () => Promise<SongCandidate | null>
  /** fade: fadeInMs from the start, fadeOutMs before endMs; 0 for a hard edge. */
  play: (
    handle: string,
    startMs: number,
    endMs: number,
    fade: { inMs: number; outMs: number }
  ) => Promise<void>
  stop: (fadeMs: number) => Promise<void>
  onState: (listener: (state: PlaybackState) => void) => () => void
}

/**
 * A clip fades out over its last 1.5 s. The fade in covers the same 1.5 s,
 * so the same rate, and only when the clip starts after 0. A clip that
 * starts at the beginning of the song plays at the current volume.
 */
export const WALK_UP_FADE = { inMs: 1500, outMs: 1500 } as const
