import type { DictationModel, Health } from '../../common/api'
import type { Problem, ScoringAction } from '../../common/scoring/actions'
import type { ScoringSessionState } from './scoringTypes'

/**
 * Dictation's types, in a file of their own so the web files and their
 * `.native` stand-ins can share them: a `.native` file that imported its web
 * sibling would resolve back to itself.
 */

export interface Microphone {
  stop: () => void
}

/** Opens the microphone; each chunk of 16 kHz mono 16-bit PCM goes to `onPcm`. */
export type OpenMicrophone = (
  onPcm: (pcm: ArrayBuffer) => void
) => Promise<Microphone>

/** The part of a browser `WebSocket` the hook uses, so a test can stand in. */
export interface DictationSocket {
  readonly readyState: number
  binaryType: string
  send: (data: string | ArrayBuffer) => void
  close: () => void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

export interface DictationAsk {
  question: string
  options: Array<{ label: string }>
}

export interface UseDictationOptions {
  url: string
  gameId: string
  /** The screen's own copy of the game, which is the one the scorer sees. */
  session: ScoringSessionState
  log: readonly ScoringAction[]
  onActions: (transcript: string, actions: ScoringAction[]) => void
  model?: DictationModel
  openSocket?: (url: string) => DictationSocket
  openMicrophone?: OpenMicrophone
}

export interface Dictation {
  enabled: boolean
  connected: boolean
  holding: boolean
  /** From release until the utterance's last reply. */
  busy: boolean
  /** What was heard: partial while speaking, then the transcript. */
  text: string | null
  message: string | null
  ask: DictationAsk | null
  setEnabled: (on: boolean) => void
  hold: () => void
  release: () => void
  answer: (option: number) => void
  dismiss: () => void
}

export interface DictationButtonProps {
  /** Whether this server takes dictation. The control shows only when it does. */
  health: () => Promise<Health>
  url: string
  gameId: string
  session: ScoringSessionState
  log: readonly ScoringAction[]
  /** Why the screen refused the last dictated sentence, if it did. */
  problem?: Problem
  /**
   * Whether Space is the talk key now. Absent means yes; the screen turns it
   * off while the field has a use for Space.
   */
  spaceTalks?: boolean
  onActions: (transcript: string, actions: ScoringAction[]) => void
  openSocket?: (url: string) => DictationSocket
  openMicrophone?: OpenMicrophone
}
