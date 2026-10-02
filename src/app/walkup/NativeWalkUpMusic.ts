import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The `WalkUpMusic` TurboModule's codegen spec (GameStationWalkUpMusicSpec):
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
 * lowest and restored levels.
 */
export interface NativeWalkUpMusicState {
  kind: string
  handle?: string
  positionMs?: CodegenTypes.Double
  message?: string
  volume?: CodegenTypes.Double
  fade?: string
  startLevel?: CodegenTypes.Double
  lowestLevel?: CodegenTypes.Double
  restoredLevel?: CodegenTypes.Double
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
}

export default TurboModuleRegistry.getEnforcing<Spec>('WalkUpMusic')
