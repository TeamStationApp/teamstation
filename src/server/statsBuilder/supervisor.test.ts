import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type ForkFn,
  type SupervisedChild,
  superviseStatsBuilder
} from './supervisor'

interface FakeChild extends SupervisedChild {
  signal: string | null
  exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >
  exit: (code: number | null, signal: NodeJS.Signals | null) => void
}

interface Harness {
  forks: Array<{
    modulePath: string
    args: string[]
    options: { execArgv?: string[]; stdio?: string }
  }>
  children: FakeChild[]
  logs: string[]
  nowMs: number
  timers: Array<{ due: number; fn: () => void; cleared: boolean }>
  fork: ForkFn
  clock: () => Date
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  fireDue: () => void
  advance: (ms: number) => void
}

function makeHarness(): Harness {
  const harness: Harness = {
    forks: [],
    children: [],
    logs: [],
    nowMs: 1_000_000,
    timers: [],
    fork: (modulePath, args, options) => {
      harness.forks.push({
        modulePath,
        args,
        options: {
          execArgv: options.execArgv,
          stdio: options.stdio as string | undefined
        }
      })
      const child: FakeChild = {
        signal: null,
        exitListeners: [],
        kill(signal) {
          child.signal = signal == null ? 'SIGTERM' : String(signal)
          return true
        },
        on(_event, listener) {
          child.exitListeners.push(listener)
        },
        exit(code, signal) {
          for (const listener of [...child.exitListeners]) {
            listener(code, signal)
          }
        }
      }
      harness.children.push(child)
      return child
    },
    clock: () => new Date(harness.nowMs),
    setTimeout: ((fn: () => void, ms?: number) => {
      const entry = {
        due: harness.nowMs + (ms ?? 0),
        fn,
        cleared: false
      }
      harness.timers.push(entry)
      return entry as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clearTimeout: (handle: unknown) => {
      const entry = handle as { cleared: boolean }
      entry.cleared = true
    },
    fireDue() {
      const due = harness.timers
        .filter(t => !t.cleared && t.due <= harness.nowMs)
        .sort((a, b) => a.due - b.due)
      for (const timer of due) {
        if (timer.cleared) continue
        timer.cleared = true
        timer.fn()
      }
    },
    advance(ms: number) {
      harness.nowMs += ms
      harness.fireDue()
    }
  }
  return harness
}

function start(harness: Harness): ReturnType<typeof superviseStatsBuilder> {
  return superviseStatsBuilder({
    fork: harness.fork,
    log: message => harness.logs.push(message),
    clock: harness.clock,
    setTimeout: harness.setTimeout,
    clearTimeout: harness.clearTimeout
  })
}

describe('superviseStatsBuilder', function () {
  it('forks on start with require.resolve, execArgv and inherit stdio', function () {
    const harness = makeHarness()
    start(harness)

    expect(harness.forks).length(1)
    expect(harness.forks[0].modulePath).equals(require.resolve('./start'))
    expect(harness.forks[0].args).deep.equals([])
    expect(harness.forks[0].options.execArgv).deep.equals(process.execArgv)
    expect(harness.forks[0].options.stdio).equals('inherit')
  })

  it('restarts with backoff 1s, 2s, 4s … capped at 60s', function () {
    const harness = makeHarness()
    start(harness)

    const delays: number[] = []
    for (let i = 0; i < 8; i++) {
      const before = harness.forks.length
      harness.children[harness.children.length - 1].exit(1, null)
      const restart = harness.timers.find(t => !t.cleared)
      expect(restart != null, `restart ${i}`).equals(true)
      delays.push(restart!.due - harness.nowMs)
      harness.advance(restart!.due - harness.nowMs)
      expect(harness.forks.length).equals(before + 1)
    }

    expect(delays).deep.equals([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000
    ])
  })

  it('resets the delay to 1s after a child has lived 60s', function () {
    const harness = makeHarness()
    start(harness)

    harness.children[0].exit(1, null)
    harness.advance(1000)
    expect(harness.forks).length(2)

    // Lived long enough that the next crash should wait only 1 s.
    harness.advance(60_000)
    harness.children[1].exit(1, null)
    const restart = harness.timers.find(t => !t.cleared)
    expect(restart!.due - harness.nowMs).equals(1000)
    expect(harness.logs.at(-1)).match(/restarting in 1s/)
  })

  it('stop sends the signal and does not fork again', async function () {
    const harness = makeHarness()
    const supervisor = start(harness)

    const stopped = supervisor.stop('SIGTERM')
    expect(harness.children[0].signal).equals('SIGTERM')

    harness.children[0].exit(0, 'SIGTERM')
    await stopped

    expect(harness.forks).length(1)
    harness.advance(120_000)
    expect(harness.forks).length(1)
  })

  it('SIGKILLs a child that ignores the stop signal after 5s', async function () {
    const harness = makeHarness()
    const supervisor = start(harness)

    const stopped = supervisor.stop('SIGTERM')
    expect(harness.children[0].signal).equals('SIGTERM')

    harness.advance(5_000)
    expect(harness.children[0].signal).equals('SIGKILL')

    harness.children[0].exit(null, 'SIGKILL')
    await stopped
  })

  it('stop(SIGKILL) kills at once', async function () {
    const harness = makeHarness()
    const supervisor = start(harness)

    const stopped = supervisor.stop('SIGKILL')
    expect(harness.children[0].signal).equals('SIGKILL')
    // No deferred kill timer.
    expect(
      harness.timers.every(t => t.cleared || t.due > harness.nowMs + 1)
    ).equals(true)

    harness.children[0].exit(null, 'SIGKILL')
    await stopped
  })

  it('a second stop returns the same promise', function () {
    const harness = makeHarness()
    const supervisor = start(harness)

    const first = supervisor.stop('SIGTERM')
    const second = supervisor.stop('SIGKILL')
    expect(second).equal(first)
    // First signal wins; SIGKILL is not re-sent by the second call.
    expect(harness.children[0].signal).equals('SIGTERM')
  })

  it('stop resolves at once when no child is running', async function () {
    const harness = makeHarness()
    const supervisor = start(harness)
    harness.children[0].exit(1, null)
    // Mid-restart delay: no live child.
    await supervisor.stop('SIGTERM')
  })
})
