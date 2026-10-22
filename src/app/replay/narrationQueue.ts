/**
 * When the replay's announcer speaks, shared by the web's and the phone's
 * players, which only fetch, play and stop. A step's sentence is fetched
 * ahead while the speaker is on, played as the step is shown, and the replay
 * waits for it to end, for at most eight seconds. Audio is keyed by the step
 * and how many actions it holds, so a step that grows is fetched again and
 * the announcer always reads the sentence on the card.
 */

/** What the players do; a clip is whatever one of them can play. */
export interface NarrationOutput<C> {
  /** Fetches a step's sentence as it stood; rejects on any failure. */
  load: (step: NarrationStep, signal: AbortSignal) => Promise<C>
  /** Plays a clip, settling when it ends, fails or is stopped. */
  play: (clip: C) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  /** Frees a clip that will not be played again. */
  release: (clip: C) => void
}

export interface NarrationEvents {
  /** Whether the replay should wait for the announcer. */
  speaking: (speaking: boolean) => void
  /** Three sentences in a row could not be read; the queue muted itself. */
  unavailable: () => void
}

/** A step as the announcer reads it: its key and how many actions it has. */
export interface NarrationStep {
  key: string
  count: number
}

export interface NarrationTimers {
  set: (run: () => void, ms: number) => unknown
  clear: (timer: unknown) => void
  now: () => number
}

/** The longest the replay waits for a sentence. */
export const SPEECH_CAP_MS = 8000
/**
 * Sentences in a row that could not be fetched as their steps were shown,
 * which turn the announcer off. A sentence fetched ahead that fails is
 * fetched again when its step comes, so the look-aheads one short drop
 * fails together count as nothing.
 */
export const FAILURES_TO_MUTE = 3
/** Steps fetched ahead of the one playing, in a replay. */
export const PREFETCH = 2

interface Entry<C> {
  controller: AbortController
  clip: Promise<C | null>
  loaded?: C
  /** The fetch failed, rather than being called off. */
  failed?: boolean
}

const idOf = (step: NarrationStep): string => `${step.key}#${step.count}`

const realTimers: NarrationTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: timer => {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  },
  now: () => Date.now()
}

export class NarrationQueue<C> {
  private readonly entries = new Map<string, Entry<C>>()
  private muted = true
  private paused = false
  private speakingNow = false
  private failures = 0
  /** Bumped by every new sentence and by muting, so a stale one stops. */
  private turn = 0
  private cap: unknown = null
  private capLeft = SPEECH_CAP_MS
  private capFrom = 0
  private resumed: (() => void) | null = null
  /** The sentence being read, which no list of steps ahead drops. */
  private current: string | null = null

  constructor(
    private readonly output: NarrationOutput<C>,
    private readonly events: NarrationEvents,
    private readonly timers: NarrationTimers = realTimers
  ) {}

  /** Turns the announcer on or off; off stops speech and fetching at once. */
  setMuted(muted: boolean): void {
    if (muted === this.muted) return
    this.muted = muted
    if (!muted) {
      this.failures = 0
      return
    }
    this.turn++
    this.current = null
    this.output.stop()
    this.clearCap()
    for (const id of [...this.entries.keys()]) this.drop(id)
    this.setSpeaking(false)
  }

  /** Holds speech, and the wait for it, while the replay is paused. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return
    this.paused = paused
    if (paused) {
      this.output.pause()
      if (this.cap != null) {
        this.timers.clear(this.cap)
        this.cap = null
        this.capLeft = Math.max(
          0,
          this.capLeft - (this.timers.now() - this.capFrom)
        )
      }
      return
    }
    this.output.resume()
    this.resumed?.()
    this.resumed = null
    if (this.speakingNow) this.startCap(this.turn)
  }

  /**
   * The steps that come next: their sentences are fetched, and any fetched
   * sentence for a step no longer among them, or that has since grown, is
   * dropped.
   */
  upcoming(steps: readonly NarrationStep[]): void {
    if (this.muted) return
    const keep = new Set(steps.map(idOf))
    for (const id of [...this.entries.keys()])
      if (!keep.has(id) && id !== this.current) this.drop(id)
    for (const step of steps) this.fetch(step)
  }

  /** Reads a step that has just been shown, and holds the replay meanwhile. */
  speak(step: NarrationStep): void {
    if (this.muted) return
    const turn = ++this.turn
    this.output.stop()
    this.clearCap()
    this.capLeft = SPEECH_CAP_MS
    this.setSpeaking(true)
    if (!this.paused) this.startCap(turn)
    const id = idOf(step)
    this.current = id
    const entry = this.fetch(step)
    ;(async () => {
      const clip = await entry.clip
      if (turn !== this.turn) return
      if (entry.failed === true) this.failed()
      else if (clip != null) this.failures = 0
      // The third failure in a row has muted the queue.
      if (turn !== this.turn) return
      if (clip != null) {
        if (this.paused)
          await new Promise<void>(resolve => {
            this.resumed = resolve
          })
        if (turn !== this.turn) return
        await this.output.play(clip)
        this.drop(id)
      }
      if (turn === this.turn) {
        this.current = null
        this.clearCap()
        this.setSpeaking(false)
      }
    })().catch(() => undefined)
  }

  /**
   * Stops the sentence being read, as a rewind does, and leaves the
   * announcer on: the next step shown is read as usual.
   */
  interrupt(): void {
    this.turn++
    this.current = null
    // A sentence waiting out a pause lets go and sees its turn is over; its
    // clip, no longer the one being read, goes with the next list ahead.
    const resume = this.resumed
    this.resumed = null
    resume?.()
    this.output.stop()
    this.clearCap()
    this.setSpeaking(false)
  }

  /** Stops everything for good, as the replay closes. */
  dispose(): void {
    this.setMuted(true)
  }

  private fetch(step: NarrationStep): Entry<C> {
    const id = idOf(step)
    const known = this.entries.get(id)
    if (known != null) return known
    const controller = new AbortController()
    const entry: Entry<C> = {
      controller,
      clip: this.output.load(step, controller.signal).then(
        clip => {
          if (controller.signal.aborted) {
            this.output.release(clip)
            return null
          }
          entry.loaded = clip
          return clip
        },
        () => {
          if (controller.signal.aborted) return null
          entry.failed = true
          // Fetched again if its step is shown.
          if (this.entries.get(id) === entry) this.entries.delete(id)
          return null
        }
      )
    }
    this.entries.set(id, entry)
    return entry
  }

  private failed(): void {
    this.failures++
    if (this.failures < FAILURES_TO_MUTE) return
    this.setMuted(true)
    this.events.unavailable()
  }

  private drop(id: string): void {
    const entry = this.entries.get(id)
    if (entry == null) return
    this.entries.delete(id)
    if (entry.loaded != null) this.output.release(entry.loaded)
    else entry.controller.abort()
  }

  private startCap(turn: number): void {
    this.capFrom = this.timers.now()
    this.cap = this.timers.set(() => {
      this.cap = null
      if (turn === this.turn) this.setSpeaking(false)
    }, this.capLeft)
  }

  private clearCap(): void {
    if (this.cap != null) this.timers.clear(this.cap)
    this.cap = null
  }

  private setSpeaking(speaking: boolean): void {
    if (speaking === this.speakingNow) return
    this.speakingNow = speaking
    this.events.speaking(speaking)
  }
}
