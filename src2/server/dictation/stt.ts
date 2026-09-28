import WebSocket from 'ws'

/**
 * Speech to text, streamed to xAI's dictation model.
 *
 * One recogniser socket per at-bat. xAI configures a socket only through its
 * URL — `keyterm` is a repeated query parameter — so the names a socket biases
 * toward are the ones it was opened with. `retarget` opens the next at-bat's
 * socket in the background and swaps to it between utterances; within an
 * at-bat every utterance reuses the open socket and skips the handshake.
 *
 * Measured against the live API on 2026-09-28, and what this module is built
 * on:
 *
 *  - `finalize` ends an utterance and leaves the socket up; `audio.done` ends
 *    the socket. Those, and binary audio, are the only messages it takes.
 *  - The text of an utterance comes in segments. Each `transcript.partial`
 *    flagged `speech_final` carries one segment, and a pause mid-hold ends one
 *    early; the next segment's text does not repeat it. The utterance is every
 *    segment of the hold, ending with the one that answers `finalize`.
 *  - `finalize` after silence still answers, with an empty `speech_final`.
 *  - `transcript.done` carries no text, and arrives only after `audio.done`.
 */

export const DEFAULT_STT_URL = 'wss://api.x.ai/v1/stt'
export const DEFAULT_STT_MODEL = 'grok-voice-transcribe-2.0'

/** How long after `finalize` an utterance waits before it settles on what it has. */
export const FINAL_TIMEOUT_MS = 5000

const MAX_TERMS = 100
const MAX_TERM_CHARS = 50

/** The part of a `ws` socket this module uses, so a test can stand in for it. */
export interface SttSocket {
  send: (data: Buffer | string) => void
  close: () => void
  on: ((event: 'open', listener: () => void) => unknown) &
    ((event: 'message', listener: (data: unknown) => void) => unknown) &
    ((event: 'error', listener: (error: Error) => void) => unknown) &
    ((event: 'close', listener: () => void) => unknown)
}

export interface SttOptions {
  apiKey: string
  url?: string
  model?: string
  finalTimeoutMs?: number
  connect?: (url: string, headers: Record<string, string>) => SttSocket
}

export interface SttHandlers {
  /** The utterance so far, as the scorer speaks. */
  onPartial: (text: string) => void
  /** The utterance's text, once, after `end`. It may be empty. */
  onFinal: (text: string) => void
  /** The utterance in flight failed; nothing more comes for it. */
  onError: (message: string) => void
}

/** xAI takes at most 100 terms of at most 50 characters. */
export function keytermQuery(terms: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const term of terms) {
    const trimmed = term.trim()
    if (trimmed === '' || trimmed.length > MAX_TERM_CHARS) continue
    const lower = trimmed.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(trimmed)
    if (out.length === MAX_TERMS) break
  }
  return out
}

export function sttUrl(
  base: string,
  model: string,
  terms: readonly string[]
): string {
  const query = new URLSearchParams({ model })
  for (const term of keytermQuery(terms)) query.append('keyterm', term)
  return `${base}?${query.toString()}`
}

/** One recogniser socket, and the frames written before it opened. */
class Upstream {
  opened = false
  ready = false
  finished = false
  error: string | null = null
  private readonly pending: Array<Buffer | string> = []

  constructor(
    readonly socket: SttSocket,
    readonly terms: readonly string[]
  ) {}

  onOpen(): void {
    this.opened = true
    for (const frame of this.pending) this.socket.send(frame)
    this.pending.length = 0
  }

  send(frame: Buffer | string): void {
    if (this.finished) return
    if (this.opened) this.socket.send(frame)
    else this.pending.push(frame)
  }

  /** Ends the socket on purpose, so its close is not read as a drop. */
  finish(): void {
    if (this.finished) return
    if (this.opened) this.socket.send(JSON.stringify({ type: 'audio.done' }))
    this.finished = true
    this.pending.length = 0
    this.socket.close()
  }
}

interface Utterance {
  segments: string[]
  ended: boolean
  /** A byte of a 16-bit sample split across two frames. */
  carry: Buffer | null
  timer?: ReturnType<typeof setTimeout>
}

/**
 * The recogniser for one dictation connection. The route calls `retarget`
 * whenever the client sends key terms, `begin`, `write` and `end` for each
 * hold, and `close` when the connection goes.
 */
export class SttSession {
  private current: Upstream | null = null
  private next: Upstream | null = null
  private terms: readonly string[] = []
  private utterance: Utterance | null = null
  private closed = false

  constructor(
    private readonly options: SttOptions,
    private readonly handlers: SttHandlers
  ) {}

  /**
   * The next at-bat's key terms. The socket carrying them opens now and
   * becomes current once xAI reports it ready, but never under an utterance.
   */
  retarget(terms: readonly string[]): void {
    if (this.closed) return
    const wanted = keytermQuery(terms)
    this.terms = wanted
    if (this.next != null && same(this.next.terms, wanted)) return
    this.dropNext()
    // Back to the terms already current: the socket opening for others is not needed.
    if (this.current != null && same(this.current.terms, wanted)) return
    if (this.current == null) this.current = this.open(wanted)
    else this.next = this.open(wanted)
  }

  /** A hold began. Its audio goes to the socket for the latest terms. */
  begin(): void {
    if (this.closed) return
    if (this.utterance != null) this.settle(null)
    if (this.next != null) {
      // Speaking within a handshake of a player change: use the new socket and
      // let its open flush the audio, rather than bias toward the old names.
      this.current?.finish()
      this.current = this.next
      this.next = null
    }
    this.current ??= this.open(this.terms)
    this.utterance = { segments: [], ended: false, carry: null }
  }

  /** 16-bit mono PCM at 16 kHz, relayed as it arrives. */
  write(pcm: Buffer): void {
    const utterance = this.utterance
    if (utterance == null || utterance.ended || this.current == null) return
    let frame =
      utterance.carry == null ? pcm : Buffer.concat([utterance.carry, pcm])
    utterance.carry = null
    if (frame.length % 2 === 1) {
      utterance.carry = frame.subarray(frame.length - 1)
      frame = frame.subarray(0, frame.length - 1)
    }
    if (frame.length > 0) this.current.send(frame)
  }

  /** The hold was released: ask for the utterance's last segment. */
  end(): void {
    const utterance = this.utterance
    if (utterance == null || utterance.ended || this.current == null) return
    utterance.ended = true
    this.current.send(JSON.stringify({ type: 'finalize' }))
    utterance.timer = setTimeout(() => {
      this.settle(utterance.segments.join(' '))
    }, this.options.finalTimeoutMs ?? FINAL_TIMEOUT_MS)
  }

  /** Dictation was switched off. Nothing more is reported. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.settle(null)
    this.dropNext()
    this.current?.finish()
    this.current = null
  }

  private open(terms: readonly string[]): Upstream {
    const url = sttUrl(
      this.options.url ?? DEFAULT_STT_URL,
      this.options.model ?? DEFAULT_STT_MODEL,
      terms
    )
    const headers = { Authorization: `Bearer ${this.options.apiKey}` }
    const connect =
      this.options.connect ??
      ((to: string, with_: Record<string, string>) =>
        new WebSocket(to, { headers: with_ }))
    const upstream = new Upstream(connect(url, headers), terms)
    const { socket } = upstream
    socket.on('open', () => {
      upstream.onOpen()
    })
    socket.on('message', data => {
      this.onMessage(upstream, data)
    })
    socket.on('error', error => {
      upstream.error = error.message
    })
    socket.on('close', () => {
      this.onClose(upstream)
    })
    return upstream
  }

  private onMessage(upstream: Upstream, data: unknown): void {
    if (upstream.finished) return
    const message = parse(data)
    if (message == null) return
    if (message.type === 'transcript.created') {
      upstream.ready = true
      this.swap()
      return
    }
    if (upstream !== this.current) return
    const utterance = this.utterance
    if (message.type === 'error') {
      const text =
        typeof message.message === 'string'
          ? message.message
          : 'The recogniser failed'
      if (utterance != null) this.fail(text)
      return
    }
    if (message.type !== 'transcript.partial' || utterance == null) return
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (message.speech_final === true) {
      if (text !== '') utterance.segments.push(text)
      if (utterance.ended) this.settle(utterance.segments.join(' '))
      else this.handlers.onPartial(utterance.segments.join(' '))
      return
    }
    this.handlers.onPartial(
      [...utterance.segments, text].filter(s => s !== '').join(' ')
    )
  }

  private onClose(upstream: Upstream): void {
    if (upstream.finished) return
    upstream.finished = true
    if (upstream === this.next) {
      this.next = null
      return
    }
    if (upstream !== this.current) return
    this.current = null
    if (this.utterance != null)
      this.fail(
        upstream.error == null
          ? 'The recogniser disconnected'
          : `The recogniser disconnected: ${upstream.error}`
      )
    // A socket that had been working is replaced at once; one that never
    // opened is left for the next hold, so a refused key does not spin.
    if (this.closed || !upstream.ready) return
    if (this.next != null) {
      this.current = this.next
      this.next = null
    } else this.current = this.open(this.terms)
  }

  /** Makes the opened socket current, once no utterance is using the old one. */
  private swap(): void {
    const next = this.next
    if (next == null || !next.ready || this.utterance != null) return
    this.current?.finish()
    this.current = next
    this.next = null
  }

  private dropNext(): void {
    this.next?.finish()
    this.next = null
  }

  private fail(message: string): void {
    const utterance = this.utterance
    if (utterance == null) return
    clearTimeout(utterance.timer)
    this.utterance = null
    this.handlers.onError(message)
    this.swap()
  }

  /** Ends the utterance in flight: with its text, or silently for `null`. */
  private settle(text: string | null): void {
    const utterance = this.utterance
    if (utterance == null) return
    clearTimeout(utterance.timer)
    this.utterance = null
    if (text != null) this.handlers.onFinal(text)
    this.swap()
  }
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((term, i) => term === b[i])
}

function parse(data: unknown): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    )
    return value != null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
