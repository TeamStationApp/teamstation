import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The `WalkUpMusic` TurboModule's codegen spec (TeamStationWalkUpMusicSpec):
// MusicKit in ios/TeamStation/WalkUpMusic/, MediaStore and ExoPlayer in
// android/.../co/teamstation/app/walkup/. Types and one line; the adapter the
// screens use is shaped in makeWalkUpMusic.ts, where a test can reach it.

/** A song as the phone's search found it. `source` is catalog, library or device. */
export interface NativeSongCandidate {
  provider: string
  providerId: string
  isrc: string | null
  title: string
  artist: string
  album: string | null
  artworkUrl: string | null
  durationMs: CodegenTypes.Double
  source: string
  handle: string
}

/**
 * `playing` every 250 ms, then `idle`, or `error`. `volume` is the system
 * volume on an iPhone, the player's own on Android; a fade reports its start,
 * lowest and restored levels. An `error` whose `message` was rewritten for a
 * person keeps the platform's own words in `detail`. `prepareOffline` reports
 * an `offline` summary, with its counts, then an `offlineSong` per song, each
 * its own line in the device log; `musicLog` keeps the summary and the songs
 * not yet on the phone.
 */
export interface NativeWalkUpMusicState {
  kind: string
  handle?: string
  positionMs?: CodegenTypes.Double
  message?: string
  detail?: string
  volume?: CodegenTypes.Double
  fade?: string
  startLevel?: CodegenTypes.Double
  lowestLevel?: CodegenTypes.Double
  restoredLevel?: CodegenTypes.Double
  authorized?: boolean
  subscribed?: boolean
  syncLibrary?: boolean
  count?: CodegenTypes.Int32
  added?: CodegenTypes.Int32
  pending?: CodegenTypes.Int32
  downloaded?: CodegenTypes.Int32
  unavailable?: CodegenTypes.Int32
  providerId?: string
  state?: string
}

/**
 * What `prepareOffline` found and did. `authorized` is MusicKit and media
 * library access together; `syncLibrary` is Apple Music's Sync Library. Each
 * song is `downloaded`, `pending` (in the library, not on the phone),
 * `added` (put in the library just now) or `unavailable`.
 */
export interface NativeOfflineReport {
  authorized: boolean
  /** An Apple Music subscription that can play the catalog, as far as known. */
  subscribed: boolean
  syncLibrary: boolean
  songs: Array<{ providerId: string; state: string }>
}

export interface Spec extends TurboModule {
  readonly onWalkUpMusicState: CodegenTypes.EventEmitter<NativeWalkUpMusicState>
  access: () => Promise<string>
  search: (term: string) => Promise<NativeSongCandidate[]>
  pickFile: () => Promise<NativeSongCandidate | null>
  play: (
    handle: string,
    startMs: CodegenTypes.Double,
    endMs: CodegenTypes.Double,
    fadeInMs: CodegenTypes.Double,
    fadeOutMs: CodegenTypes.Double
  ) => Promise<void>
  stop: (fadeMs: CodegenTypes.Double) => Promise<void>
  /**
   * Adds these Apple Music catalog songs to the library and to the
   * TeamStation walkup songs playlist, so Automatic Downloads keeps them on
   * the phone, and says where each one is.
   */
  prepareOffline: (providerIds: string[]) => Promise<NativeOfflineReport>
}

export default TurboModuleRegistry.getEnforcing<Spec>('WalkUpMusic')
