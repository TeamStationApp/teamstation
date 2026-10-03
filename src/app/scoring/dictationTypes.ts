import type { DictationModel, Health } from '../../common/api'
import type { Problem, ScoringAction } from '../../common/scoring/actions'
import type { DictationQuestion, ScoringSessionState } from './scoringTypes'

/**
 * Dictation's types, in a file of their own so the web files and their
 * `.native` stand-ins can share them: a `.native` file that imported its web
 * sibling would resolve back to itself.
 */

export interface Microphone {
  stop: () => void
}

/**
 * Opens the microphone. Each chunk of 16 kHz mono 16-bit PCM goes to
 * `onPcm`. `onEnded` runs when the microphone stops on its own after
 * `start` has already succeeded.
 */
export type OpenMicrophone = (
  onPcm: (pcm: ArrayBuffer) => void,
  onEnded?: (message: string) => void
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
  /** A sentence's actions; `undo` first takes back the last thing scored. */
  onActions: (
    transcript: string,
    actions: ScoringAction[],
    undo?: boolean
  ) => void
  model?: DictationModel
  /** The session token a phone puts on the socket. The browser uses its cookie. */
  token?: string
  /** How long audio keeps flowing after a release. Tests shorten it. */
  tailMs?: number
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
  /**
   * Starts an utterance. `since` is when the press began: the audio heard
   * from then, kept while nobody was talking, leads it.
   */
  hold: (since?: number) => void
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
  /** What the screen asks about a dictated sentence, with its answers. */
  question?: DictationQuestion
  onAnswer?: (answer: { option?: number; picks?: number[] }) => void
  onDismissQuestion?: () => void
  /** The plays the last applied sentence made, for the log; `id` changes per sentence. */
  played?: { id: number; lines: string[] }
  /** What a dictated undo took back, for the log; `id` changes per undo. */
  undone?: { id: number; line: string }
  /** A press shorter than this is a tap. Tests shorten it. */
  tapMs?: number
  /** How long audio keeps flowing after a release. Tests shorten it. */
  tailMs?: number
  /** How long the log stays up after its last new line. Tests shorten it. */
  lingerMs?: number
  /**
   * Whether Space is the talk key now. Absent means yes; the screen turns it
   * off while the field has a use for Space.
   */
  spaceTalks?: boolean
  onActions: (
    transcript: string,
    actions: ScoringAction[],
    undo?: boolean
  ) => void
  /** The LLM the scorer picked in settings; absent, the server's own. */
  model?: DictationModel
  /**
   * The session token. A phone sends it as a bearer header, because it has
   * no cookie. The browser's socket ignores it and sends the cookie.
   */
  token?: string
  openSocket?: (url: string) => DictationSocket
  openMicrophone?: OpenMicrophone
}
