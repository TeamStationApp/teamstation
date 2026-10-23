import type { DictationModel, Health } from '../../common/api'
import type { Problem, ScoringAction } from '../../common/scoring/actions'
import type { SaidRosterCommand } from '../../common/scoring/rosterCommands'
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

/**
 * A sentence's actions and its roster commands as said, for the screen to
 * find the players of; `undo` first takes back the last thing scored.
 */
export type OnDictated = (
  transcript: string,
  actions: ScoringAction[],
  roster: SaidRosterCommand[],
  undo?: boolean
) => void

/** What a sentence is about, and the game the model is told of with it. */
export interface DictationTopic {
  /** The server's scope for the sentence: `scoring` when absent. */
  scope?: string
  /** What the scope speaks about: `{ gameId }` when absent. */
  target?: Record<string, unknown>
  /**
   * The game as the model is told of it: `dictationContext` of the session
   * when absent. A hold with neither starts nothing.
   */
  contextOf?: () => string
}

/**
 * Where a sentence's answer goes. A screen about a game passes its session
 * and takes `onActions`; one that only wants the words, as Tess does, passes
 * no session and takes `onTranscript`. Key terms and player tags are sent
 * only with a session.
 */
export interface DictationListener {
  gameId?: string
  /** The screen's own copy of the game, which is the one the scorer sees. */
  session?: ScoringSessionState
  log?: readonly ScoringAction[]
  onActions?: OnDictated
  /**
   * The words of a hold that heard some, for a scope that ends at its
   * transcript. The button is free for the next hold when it runs.
   */
  onTranscript?: (text: string) => void
}

export interface UseDictationOptions extends DictationTopic, DictationListener {
  url: string
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

/**
 * What `useDictationControls` takes. Tess passes no game: a `tess` scope,
 * `contextOf`, `onTranscript`, and `spaceTalks: false`, so Space stays the
 * page's beside her chat.
 */
export interface DictationControlsProps
  extends DictationTopic, DictationListener {
  /**
   * The scoring screen's pill above Bunt and Swing, or the roster screen's
   * round button in its bottom bar, `size` across. A round control leaves its
   * question to the screen, which shows it in its chat.
   */
  shape?: 'pill' | 'round'
  size?: number
  /** Switched on as soon as the server is known to dictate. */
  startEnabled?: boolean
  suspended?: boolean
  /** Whether this server takes dictation. The control shows only when it does. */
  health: () => Promise<Health>
  url: string
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
  /**
   * Why the screen took nothing from a sentence it did not score, such as a
   * substitution said with a play, for the log; `id` changes per refusal.
   */
  refused?: { id: number; message: string }
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

/** The controls on a screen about a game: scoring's, and the roster sheet's. */
export interface DictationButtonProps extends DictationControlsProps {
  gameId: string
  session: ScoringSessionState
  log: readonly ScoringAction[]
  onActions: OnDictated
}
