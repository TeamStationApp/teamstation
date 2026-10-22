import type React from 'react'

import type { NarrationStepRef } from '../../common/api'
import type { NarrationOutput } from './narrationQueue'

/** What a narration player needs of the API client. */
export interface NarrationClient {
  narrationAudio: (
    gameId: string,
    step: NarrationStepRef,
    signal?: AbortSignal
  ) => Promise<Blob>
  narrationReady: (
    gameId: string,
    step: NarrationStepRef,
    signal?: AbortSignal
  ) => Promise<void>
  narrationSource: (
    gameId: string,
    step: NarrationStepRef
  ) => { uri: string; headers: Record<string, string> }
}

/** A player; `C` is what it keeps of a fetched sentence until it plays it. */
export interface NarrationPlayer<C = string> {
  output: NarrationOutput<C>
  /** Called inside the speaker's tap, where a browser allows sound to start. */
  unlock: () => void
  /** What the player draws, if anything. */
  element: React.ReactElement | null
}
