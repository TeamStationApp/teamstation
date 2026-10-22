import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  FAILURES_TO_MUTE,
  NarrationQueue,
  type NarrationStep,
  type NarrationTimers,
  SPEECH_CAP_MS
} from './narrationQueue'

/** A player whose fetches and sentences finish when the test says. */
class FakeOutput {
  loads: string[] = []
  aborted: string[] = []
  played: string[] = []
  released: string[] = []
  calls: string[] = []
  private readonly pending = new Map<
    string,
    { resolve: (clip: string) => void; reject: (error: Error) => void }
  >()

  private ending: (() => void) | null = null

  counts: number[] = []

  async load(step: NarrationStep, signal: AbortSignal): Promise<string> {
    const stepKey = step.key
    this.loads.push(stepKey)
    this.counts.push(step.count)
    return await new Promise<string>((resolve, reject) => {
      this.pending.set(stepKey, { resolve, reject })
      signal.addEventListener('abort', () => {
        this.aborted.push(stepKey)
        reject(new Error('aborted'))
      })
    })
  }

  /** Answers a fetch: with audio, or with a failure. */
  answer(stepKey: string, ok = true): void {
    const waiting = this.pending.get(stepKey)
    this.pending.delete(stepKey)
    if (ok) waiting?.resolve(`clip:${stepKey}`)
    else waiting?.reject(new Error('503'))
  }

  async play(clip: string): Promise<void> {
    this.played.push(clip)
    await new Promise<void>(resolve => {
      this.ending = resolve
    })
  }

  /** The sentence playing comes to its end. */
  end(): void {
    const ending = this.ending
    this.ending = null
    ending?.()
  }

  pause(): void {
    this.calls.push('pause')
  }

  resume(): void {
    this.calls.push('resume')
  }

  stop(): void {
    this.calls.push('stop')
    this.end()
  }

  release(clip: string): void {
    this.released.push(clip)
  }
}

class FakeTimers implements NarrationTimers {
  time = 0
  private readonly timers = new Map<number, { at: number; run: () => void }>()
  private next = 1
  set = (run: () => void, ms: number): number => {
    const id = this.next++
    this.timers.set(id, { at: this.time + ms, run })
    return id
  }

  clear = (timer: unknown): void => {
    this.timers.delete(timer as number)
  }

  now = (): number => this.time

  advance(ms: number): void {
    this.time += ms
    for (const [id, timer] of [...this.timers])
      if (timer.at <= this.time) {
        this.timers.delete(id)
        timer.run()
      }
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function queue(): {
  narration: NarrationQueue<string>
  output: FakeOutput
  timers: FakeTimers
  speaking: boolean[]
  unavailable: number[]
} {
  const output = new FakeOutput()
  const timers = new FakeTimers()
  const speaking: boolean[] = []
  const unavailable: number[] = []
  const narration = new NarrationQueue<string>(
    output,
    {
      speaking: value => speaking.push(value),
      unavailable: () => unavailable.push(1)
    },
    timers
  )
  return { narration, output, timers, speaking, unavailable }
}

describe('the announcer’s queue', function () {
  it('says nothing and fetches nothing while muted', async function () {
    const { narration, output, speaking } = queue()
    narration.upcoming([{ key: '0-0', count: 1 }])
    narration.speak({ key: '0-0', count: 1 })
    await settle()
    expect(output.loads).deep.equals([])
    expect(speaking).deep.equals([])
  })

  it('fetches the steps ahead once, and plays a fetched sentence as its step is shown', async function () {
    const { narration, output, speaking } = queue()
    narration.setMuted(false)
    narration.upcoming([
      { key: '0-0', count: 1 },
      { key: '0-1', count: 1 }
    ])
    narration.upcoming([
      { key: '0-0', count: 1 },
      { key: '0-1', count: 1 }
    ])
    expect(output.loads).deep.equals(['0-0', '0-1'])
    output.answer('0-0')
    await settle()
    narration.speak({ key: '0-0', count: 1 })
    await settle()
    expect(speaking).deep.equals([true])
    expect(output.played).deep.equals(['clip:0-0'])
    expect(output.loads).deep.equals(['0-0', '0-1'])
    output.end()
    await settle()
    expect(speaking).deep.equals([true, false])
    expect(output.released).deep.equals(['clip:0-0'])
  })

  it('holds the replay while a sentence is fetched, and for at most eight seconds', async function () {
    const { narration, output, timers, speaking } = queue()
    narration.setMuted(false)
    narration.speak({ key: '0-0', count: 1 })
    expect(speaking).deep.equals([true])
    timers.advance(SPEECH_CAP_MS - 1)
    expect(speaking).deep.equals([true])
    timers.advance(1)
    expect(speaking).deep.equals([true, false])
    // Late audio for a sentence the replay moved past still plays, alone.
    output.answer('0-0')
    await settle()
    expect(output.played).deep.equals(['clip:0-0'])
    narration.speak({ key: '0-1', count: 1 })
    expect(output.calls).includes('stop')
    expect(speaking).deep.equals([true, false, true])
  })

  it('fetches a step again when it has grown, and drops what it had', async function () {
    const { narration, output } = queue()
    narration.setMuted(false)
    narration.upcoming([{ key: '2-3', count: 1 }])
    output.answer('2-3')
    await settle()
    narration.upcoming([{ key: '2-3', count: 3 }])
    expect(output.loads).deep.equals(['2-3', '2-3'])
    // Each fetch asks for the step as it stood then.
    expect(output.counts).deep.equals([1, 3])
    expect(output.released).deep.equals(['clip:2-3'])
    output.answer('2-3')
    await settle()
    narration.speak({ key: '2-3', count: 3 })
    await settle()
    expect(output.played).deep.equals(['clip:2-3'])
    // One that grows before its first answer is aborted.
    narration.upcoming([{ key: '3-0', count: 1 }])
    narration.upcoming([{ key: '3-0', count: 2 }])
    expect(output.aborted).deep.equals(['3-0'])
  })

  it('holds speech and its wait on pause, and resumes both on play', async function () {
    const { narration, output, timers, speaking } = queue()
    narration.setMuted(false)
    narration.speak({ key: '0-0', count: 1 })
    timers.advance(3000)
    narration.setPaused(true)
    narration.setPaused(true)
    expect(output.calls).deep.equals(['stop', 'pause'])
    output.answer('0-0')
    await settle()
    // Paused before the audio came: it waits for play.
    expect(output.played).deep.equals([])
    timers.advance(60000)
    expect(speaking).deep.equals([true])
    narration.setPaused(false)
    await settle()
    expect(output.calls).deep.equals(['stop', 'pause', 'resume'])
    expect(output.played).deep.equals(['clip:0-0'])
    timers.advance(SPEECH_CAP_MS - 3000 - 1)
    expect(speaking).deep.equals([true])
    timers.advance(1)
    expect(speaking).deep.equals([true, false])
  })

  it('skips a sentence that fails, and turns itself off after three in a row', async function () {
    const { narration, output, speaking, unavailable } = queue()
    narration.setMuted(false)
    narration.speak({ key: '0-0', count: 1 })
    output.answer('0-0', false)
    await settle()
    expect(speaking).deep.equals([true, false])
    expect(unavailable).deep.equals([])
    // A sentence read in between starts the count again.
    narration.speak({ key: '0-1', count: 1 })
    output.answer('0-1')
    await settle()
    output.end()
    await settle()
    narration.speak({ key: '0-2', count: 1 })
    output.answer('0-2', false)
    await settle()
    for (let i = 3; i < 3 + FAILURES_TO_MUTE - 1; i++) {
      expect(unavailable).deep.equals([])
      narration.speak({ key: `0-${i}`, count: 1 })
      output.answer(`0-${i}`, false)
      await settle()
    }
    expect(unavailable).deep.equals([1])
    narration.upcoming([{ key: '1-0', count: 1 }])
    expect(output.loads).not.includes('1-0')
    // Turned on again, it tries afresh.
    narration.setMuted(false)
    narration.upcoming([{ key: '1-0', count: 1 }])
    expect(output.loads).includes('1-0')
  })

  it('keeps talking through a drop that fails the sentence and both look-aheads at once, and fetches them again', async function () {
    const { narration, output, unavailable } = queue()
    narration.setMuted(false)
    narration.speak({ key: '0-0', count: 1 })
    narration.upcoming([
      { key: '0-1', count: 1 },
      { key: '0-2', count: 1 }
    ])
    for (const key of ['0-0', '0-1', '0-2']) output.answer(key, false)
    await settle()
    expect(unavailable).deep.equals([])
    // The connection is back: the next step's sentence is fetched afresh.
    narration.speak({ key: '0-1', count: 1 })
    expect(output.loads.filter(key => key === '0-1')).length(2)
    output.answer('0-1')
    await settle()
    expect(output.played).deep.equals(['clip:0-1'])
    output.end()
    await settle()
    narration.upcoming([{ key: '0-2', count: 1 }])
    expect(output.loads.filter(key => key === '0-2')).length(2)
  })

  it('stops speech and fetching at once when muted', async function () {
    const { narration, output, speaking } = queue()
    narration.setMuted(false)
    narration.upcoming([{ key: '0-1', count: 1 }])
    narration.speak({ key: '0-0', count: 1 })
    output.answer('0-0')
    output.answer('0-1')
    await settle()
    expect(output.played).deep.equals(['clip:0-0'])
    narration.setMuted(true)
    narration.setMuted(true)
    await settle()
    expect(speaking).deep.equals([true, false])
    expect(output.released).deep.equals(['clip:0-1', 'clip:0-0'])
    // Audio that comes after muting is freed, never played.
    narration.setMuted(false)
    narration.upcoming([{ key: '0-2', count: 1 }])
    narration.dispose()
    expect(output.aborted).includes('0-2')
  })

  it('stops the sentence being read on a rewind, and reads the next one shown', async function () {
    const { narration, output, timers, speaking } = queue()
    narration.setMuted(false)
    narration.upcoming([{ key: '0-1', count: 1 }])
    narration.speak({ key: '0-0', count: 1 })
    output.answer('0-0')
    await settle()
    expect(output.played).deep.equals(['clip:0-0'])
    const before = output.calls.length
    narration.interrupt()
    await settle()
    expect(output.calls.slice(before)).deep.equals(['stop'])
    expect(speaking).deep.equals([true, false])
    // The interrupted clip is freed once its play settles.
    expect(output.released).deep.equals(['clip:0-0'])
    // Its hold is gone with it.
    timers.advance(SPEECH_CAP_MS)
    expect(speaking).deep.equals([true, false])
    // Still on: the next step shown is read.
    narration.speak({ key: '0-1', count: 1 })
    output.answer('0-1')
    await settle()
    expect(output.played).deep.equals(['clip:0-0', 'clip:0-1'])
    expect(speaking).deep.equals([true, false, true])
  })

  it('never plays a sentence that arrives after the rewind that stopped it', async function () {
    const { narration, output, speaking } = queue()
    narration.setMuted(false)
    narration.speak({ key: '0-0', count: 1 })
    narration.interrupt()
    output.answer('0-0')
    await settle()
    expect(output.played).deep.equals([])
    expect(speaking).deep.equals([true, false])
    // A list of steps ahead drops what it no longer holds, as before.
    narration.upcoming([{ key: '0-2', count: 1 }])
    expect(output.loads).deep.equals(['0-0', '0-2'])
  })

  it('lets go of a sentence waiting out a pause when a rewind stops it', async function () {
    const { narration, output } = queue()
    narration.setMuted(false)
    narration.speak({ key: '0-0', count: 1 })
    narration.setPaused(true)
    output.answer('0-0')
    await settle()
    expect(output.played).deep.equals([])
    narration.interrupt()
    narration.setPaused(false)
    await settle()
    // Let go rather than left waiting: never played, and its clip freed by
    // the next list of steps ahead, which no longer holds it.
    expect(output.played).deep.equals([])
    narration.upcoming([{ key: '0-1', count: 1 }])
    expect(output.released).deep.equals(['clip:0-0'])
    // The next sentence shown plays as usual.
    narration.speak({ key: '0-1', count: 1 })
    output.answer('0-1')
    await settle()
    expect(output.played).deep.equals(['clip:0-1'])
  })

  it('frees audio that comes back after its step was dropped', async function () {
    const output = new FakeOutput()
    const narration = new NarrationQueue<string>(output, {
      speaking: () => undefined,
      unavailable: () => undefined
    })
    narration.setMuted(false)
    // The real timers: a sentence is never left holding the replay.
    narration.speak({ key: '0-0', count: 1 })
    narration.dispose()
    await settle()
    expect(output.aborted).deep.equals(['0-0'])
  })
})
