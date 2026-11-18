import { createHash } from 'node:crypto'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { input } from '../autoScheduler/fixtures.test'
import {
  buildSchedule,
  CANCELED,
  engineStatus,
  webEngine,
  type WebEngineOptions,
  type WireRequest
} from './engine.web'

const MODULE = Uint8Array.from([0, 97, 115, 109]).buffer

const integrityOf = (bytes: ArrayBuffer): string =>
  `sha384-${createHash('sha384').update(new Uint8Array(bytes)).digest('base64')}`

/** What the engine answers for a run with nothing to build. */
const NOTHING = JSON.stringify({
  kind: 'options',
  options: [],
  blocking: null,
  targets: []
})

type Behaviour = 'ready' | 'failed' | 'error' | 'silent'
type Answer = 'result' | 'failed' | 'error' | 'silent' | 'strange' | 'limit'

/** A worker stand-in that answers as `schedulerWorker.ts` does, or as told. */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly received: unknown[] = []
  terminated = false
  /**
   * What a build answers: a result, a failure, a death without a message,
   * nothing at all, or a pause at the time limit that waits for the page's
   * `decide`.
   */
  answer: Answer = 'result'
  /** The build paused at its limit, waiting for `decide`. */
  paused: number | undefined

  constructor(readonly behaviour: Behaviour = 'ready') {}

  terminate(): void {
    this.terminated = true
  }

  postMessage(message: unknown): void {
    this.received.push(message)
    const data = message as {
      type: string
      id?: number
      request?: string
      choice?: string
    }
    setTimeout(() => {
      if (data.type === 'decide') {
        if (data.id !== this.paused) return
        this.paused = undefined
        this.result(data.id)
        return
      }
      if (data.type === 'init') {
        if (this.behaviour === 'ready')
          this.onmessage?.({ data: { type: 'ready' } })
        else if (this.behaviour === 'failed')
          this.onmessage?.({ data: { type: 'failed', reason: 'bad' } })
        else if (this.behaviour === 'error') this.onerror?.(new Error('boom'))
        return
      }
      if (this.answer === 'silent') return
      if (this.answer === 'failed') {
        this.onmessage?.({ data: { type: 'failed', reason: 'trap' } })
        return
      }
      // A worker that dies without a usable message.
      if (this.answer === 'error') {
        this.onerror?.({ type: 'error' })
        return
      }
      this.onmessage?.({
        data: {
          type: 'progress',
          id: data.id,
          event: '{"kind":"phase-start","phase":"context"}'
        }
      })
      this.onmessage?.({
        data: {
          type: 'progress',
          id: data.id,
          event: '{"kind":"phase","phase":"context","ms":1}'
        }
      })
      this.onmessage?.({ data: { type: 'progress', id: data.id, event: '{' } })
      this.onmessage?.({ data: { type: 'progress', id: 99, event: '{}' } })
      this.onmessage?.({ data: { type: 'other', id: data.id } })
      if (this.answer === 'limit') {
        this.paused = data.id
        this.onmessage?.({
          data: { type: 'progress', id: data.id, event: LIMIT }
        })
        return
      }
      this.result(data.id)
    }, 0)
  }

  result(id: number | undefined): void {
    this.onmessage?.({
      data: {
        type: 'result',
        id,
        result: this.answer === 'strange' ? 42 : NOTHING
      }
    })
  }
}

const LIMIT = JSON.stringify({
  kind: 'limit',
  stage: 'targets',
  bestGames: 330,
  boundGames: 338,
  solvedMs: 3000
})

interface Harness {
  options: WebEngineOptions
  workers: FakeWorker[]
  fetches: Array<{ url: string; arguments: number }>
  logs: string[]
}

function harness(
  changes: Partial<WebEngineOptions> = {},
  behaviours: Behaviour[] = ['ready']
): Harness {
  const workers: FakeWorker[] = []
  const fetches: Harness['fetches'] = []
  const logs: string[] = []
  const options: WebEngineOptions = {
    hasWebAssembly: () => true,
    fetch: async (...args: [string]) => {
      // Only the URL: the module is checked here, not by the browser.
      fetches.push({ url: args[0], arguments: args.length })
      return { ok: true, arrayBuffer: async () => MODULE.slice(0) }
    },
    digest: async bytes =>
      new Uint8Array(
        createHash('sha384').update(new Uint8Array(bytes)).digest()
      ).buffer,
    createWorker: url => {
      expect(url).equals('/scheduler-worker-TEST.js')
      const worker = new FakeWorker(
        behaviours[Math.min(workers.length, behaviours.length - 1)]
      )
      workers.push(worker)
      return worker
    },
    workerUrl: '/scheduler-worker-TEST.js',
    wasmUrl: '/scheduler-0123456789abcdef.wasm',
    integrity: integrityOf(MODULE),
    log: line => logs.push(line),
    readyMs: 50,
    ...changes
  }
  return { options, workers, fetches, logs }
}

const RUN = input({ seasons: [], fields: [] })

describe('the web’s scheduler engine', function () {
  it('fetches the checked module once, posts it to one worker, and builds there', async function () {
    const { options, workers, fetches } = harness()
    const engine = webEngine(options)
    expect(engine.status()).equals('unknown')
    const events: unknown[] = []
    const first = await engine.build(
      { input: RUN, limitMs: 5000 },
      { onProgress: event => events.push(event) }
    )
    expect(first).deep.equals({
      kind: 'options',
      options: [],
      causes: [],
      blocking: null,
      blockingCause: null,
      targets: [],
      provenOptimal: true
    })
    // The events of this build, read; what is not one is dropped.
    expect(events).deep.equals([
      { kind: 'phase-start', phase: 'context' },
      { kind: 'phase', phase: 'context', ms: 1 }
    ])
    expect(engine.status()).equals('ready')
    await engine.build({ input: RUN })
    expect(fetches).deep.equals([
      { url: '/scheduler-0123456789abcdef.wasm', arguments: 1 }
    ])
    expect(workers).lengthOf(1)
    const [init, build] = workers[0].received as Array<{
      type: string
      bytes?: ArrayBuffer
      id?: number
      request?: string
    }>
    expect(init.type).equals('init')
    expect(new Uint8Array(init.bytes!)).deep.equals(new Uint8Array(MODULE))
    expect(build.type).equals('build')
    const sent = JSON.parse(build.request!) as WireRequest
    expect(sent.limitMs).equals(5000)
    expect(sent.offsets).deep.equals({})
  })

  it('cancels by ending the worker, and the next build starts a fresh one', async function () {
    const { options, workers, fetches } = harness()
    const engine = webEngine(options)
    await engine.build({ input: RUN })
    workers[0].answer = 'silent'
    const controller = new AbortController()
    const pending = engine.build({ input: RUN }, { signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    expect(await pending).deep.equals(CANCELED)
    expect(workers[0].terminated).equals(true)
    // A later abort of that signal touches nothing.
    const again = await engine.build({ input: RUN })
    expect(again.kind).equals('options')
    expect(workers).lengthOf(2)
    expect(workers[1].terminated).equals(false)
    expect(fetches).lengthOf(1)
    // Aborted before it starts: nothing is asked of a worker.
    const before = new AbortController()
    before.abort()
    expect(
      await engine.build({ input: RUN }, { signal: before.signal })
    ).deep.equals(CANCELED)
    expect(workers[1].received).lengthOf(2)
  })

  it('builds again on a fresh worker the page’s other builds when one is canceled', async function () {
    const { options, workers, fetches } = harness()
    const engine = webEngine(options)
    await engine.build({ input: RUN })
    workers[0].answer = 'silent'
    // Two screens' builds on the one worker; the first is canceled.
    const canceling = new AbortController()
    const canceled = engine.build({ input: RUN }, { signal: canceling.signal })
    const events: unknown[] = []
    const other = engine.build(
      { input: RUN },
      { onProgress: event => events.push(event) }
    )
    await new Promise(resolve => setTimeout(resolve, 5))
    canceling.abort()
    expect(await canceled).deep.equals(CANCELED)
    // The other is not canceled, nor told this device can't build: it
    // starts again, and is built, on a fresh worker.
    expect((await other).kind).equals('options')
    expect(workers[0].terminated).equals(true)
    expect(workers).lengthOf(2)
    expect(workers[1].terminated).equals(false)
    expect(
      workers[1].received.filter(
        each => (each as { type: string }).type === 'build'
      )
    ).lengthOf(1)
    expect(events).deep.include({ kind: 'phase', phase: 'context', ms: 1 })
    expect(fetches).lengthOf(1)
    // So too when the canceled one's cancel is its answer at the limit,
    // while the other waits at its own.
    workers[1].answer = 'limit'
    const paused = engine.build(
      { input: RUN },
      { onLimit: async () => 'cancel' as const }
    )
    const waiting = engine.build(
      { input: RUN },
      { onLimit: async () => await new Promise(() => undefined) }
    )
    expect(await paused).deep.equals(CANCELED)
    expect((await waiting).kind).equals('options')
    expect(workers[1].terminated).equals(true)
    expect(workers).lengthOf(3)
  })

  it('builds on a fresh worker a build whose worker another’s cancel ended while it loaded', async function () {
    const controller = new AbortController()
    const { options, workers } = harness({
      fetch: async () => {
        controller.abort()
        return { ok: true, arrayBuffer: async () => MODULE.slice(0) }
      }
    })
    const engine = webEngine(options)
    const canceled = engine.build({ input: RUN }, { signal: controller.signal })
    const other = engine.build({ input: RUN })
    expect(await canceled).deep.equals(CANCELED)
    expect((await other).kind).equals('options')
    expect(workers[0].terminated).equals(true)
    expect(workers).lengthOf(2)
  })

  it('answers the time limit through the worker, and a cancel answer ends it', async function () {
    const { options, workers } = harness()
    const engine = webEngine(options)
    await engine.build({ input: RUN })
    const worker = workers[0]
    worker.answer = 'limit'
    for (const choice of ['continue', 'use'] as const) {
      const limits: unknown[] = []
      const events: unknown[] = []
      const answer = await engine.build(
        { input: RUN },
        {
          onProgress: event => events.push(event),
          onLimit: async limit => {
            limits.push(limit)
            return choice
          }
        }
      )
      expect(answer.kind).equals('options')
      expect(limits).deep.equals([JSON.parse(LIMIT)])
      expect(events).deep.include(JSON.parse(LIMIT))
      const sent = worker.received.at(-1) as { type: string; choice: string }
      expect(sent).include({ type: 'decide', choice })
    }
    // Without onLimit the build takes its best schedule.
    await engine.build({ input: RUN })
    expect(worker.received.at(-1)).include({ type: 'decide', choice: 'use' })
    // A cancel answer, or an onLimit that fails, ends the worker.
    for (const onLimit of [
      async () => 'cancel' as const,
      async () => {
        throw new Error('modal gone')
      }
    ]) {
      const { options: fresh, workers: started } = harness()
      const other = webEngine(fresh)
      await other.build({ input: RUN })
      started[0].answer = 'limit'
      expect(await other.build({ input: RUN }, { onLimit })).deep.equals(
        CANCELED
      )
      expect(started[0].terminated).equals(true)
      expect(
        started[0].received.filter(
          each => (each as { type: string }).type === 'decide'
        )
      ).lengthOf(0)
    }
    // An answer that comes after the build has gone is dropped.
    const { options: late, workers: lateWorkers } = harness()
    const lateEngine = webEngine(late)
    await lateEngine.build({ input: RUN })
    lateWorkers[0].answer = 'limit'
    const controller = new AbortController()
    let answerLater: (choice: 'continue') => void = () => undefined
    const pending = lateEngine.build(
      { input: RUN },
      {
        signal: controller.signal,
        onLimit: async () =>
          await new Promise(resolve => {
            answerLater = resolve
          })
      }
    )
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    expect(await pending).deep.equals(CANCELED)
    answerLater('continue')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(
      lateWorkers[0].received.filter(
        each => (each as { type: string }).type === 'decide'
      )
    ).lengthOf(0)
    // The paused worker is gone, and the next build starts a fresh one.
    expect(lateWorkers[0].terminated).equals(true)
    expect((await lateEngine.build({ input: RUN })).kind).equals('options')
    expect(lateWorkers).lengthOf(2)
  })

  it('cancels a build aborted while its worker loads', async function () {
    const controller = new AbortController()
    const { options, workers } = harness({
      fetch: async () => {
        controller.abort()
        return { ok: true, arrayBuffer: async () => MODULE.slice(0) }
      }
    })
    const engine = webEngine(options)
    expect(
      await engine.build({ input: RUN }, { signal: controller.signal })
    ).deep.equals(CANCELED)
    expect(workers[0].terminated).equals(true)
    expect((await engine.build({ input: RUN })).kind).equals('options')
  })

  it('is noSolver for the page without WebAssembly, a module, or the module built', async function () {
    const cases: Array<[Partial<WebEngineOptions>, string]> = [
      [{ hasWebAssembly: () => false }, 'noWebAssembly'],
      [{ wasmUrl: undefined }, 'noModule'],
      [{ workerUrl: undefined }, 'noModule'],
      [{ integrity: 'sha384-other' }, 'integrity'],
      [{ integrity: undefined }, 'integrity'],
      // A module that arrives but is not the one built is refused for the
      // page, not read as one that did not arrive.
      [
        {
          fetch: async () => ({
            ok: true,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
          })
        },
        'integrity'
      ]
    ]
    for (const [changes, reason] of cases) {
      const { options, workers, logs } = harness(changes)
      const engine = webEngine(options)
      const answer = await engine.build({ input: RUN })
      expect(answer).include({ kind: 'failure', failure: 'noSolver' })
      expect(await engine.build({ input: RUN })).deep.equals(answer)
      expect(logs, reason).deep.equals([`scheduler unavailable: ${reason}`])
      expect(workers).lengthOf(0)
      expect(engine.status()).equals('unavailable')
    }
  })

  it('fails a build whose module does not arrive, and fetches it again for the next', async function () {
    for (const failing of [
      async () => ({ ok: false, arrayBuffer: async () => MODULE.slice(0) }),
      async () => {
        throw new Error('offline')
      }
    ]) {
      let calls = 0
      const { options, workers, logs } = harness({
        fetch: async () => {
          calls++
          if (calls === 1) return await failing()
          return {
            ok: true,
            arrayBuffer: async () => MODULE.slice(0)
          }
        }
      })
      const engine = webEngine(options)
      expect(await engine.build({ input: RUN })).deep.equals({
        kind: 'failure',
        failure: 'broken',
        message: 'The scheduler module did not arrive. Try again.'
      })
      expect(logs).deep.equals(['scheduler unavailable: fetchFailed'])
      expect(engine.status()).equals('unknown')
      expect(workers).lengthOf(0)
      // The next build fetches the module again, and builds.
      expect((await engine.build({ input: RUN })).kind).equals('options')
      expect(calls).equals(2)
      expect(workers).lengthOf(1)
      expect(engine.status()).equals('ready')
    }
  })

  it('is noSolver for a worker that fails, and tries a fresh worker next time', async function () {
    const said = {
      failed: ['scheduler worker failed: bad'],
      error: ['scheduler worker failed: boom'],
      silent: []
    }
    for (const behaviour of ['failed', 'error', 'silent'] as const) {
      const { options, workers, logs } = harness({}, [behaviour, 'ready'])
      const engine = webEngine(options)
      expect(await engine.build({ input: RUN }), behaviour).deep.equals({
        kind: 'failure',
        failure: 'noSolver',
        message: 'The scheduler stopped working'
      })
      expect(workers[0].terminated).equals(true)
      expect(logs).deep.equals([
        ...said[behaviour],
        'scheduler unavailable: worker'
      ])
      expect((await engine.build({ input: RUN })).kind).equals('options')
      expect(workers).lengthOf(2)
    }
    const { options, workers } = harness({
      createWorker: () => {
        throw new Error('no workers')
      }
    })
    const engine = webEngine(options)
    expect(await engine.build({ input: RUN })).include({ failure: 'noSolver' })
    expect(workers).lengthOf(0)
    expect(engine.status()).equals('unknown')
  })

  it('says why a build’s worker failed mid-build, and is broken for a strange answer', async function () {
    const { options, workers, logs } = harness()
    const engine = webEngine(options)
    await engine.build({ input: RUN })
    workers[0].answer = 'failed'
    // A worker that had loaded the module says why it stopped, such as a
    // trap or running out of memory on a large league.
    expect(await engine.build({ input: RUN })).deep.equals({
      kind: 'failure',
      failure: 'broken',
      message: 'The scheduler stopped working: trap'
    })
    expect(workers[0].terminated).equals(true)
    expect(logs).deep.equals([
      'scheduler worker failed: trap',
      'scheduler unavailable: worker'
    ])
    expect((await engine.build({ input: RUN })).kind).equals('options')
    workers[1].answer = 'strange'
    expect(await engine.build({ input: RUN })).deep.equals({
      kind: 'failure',
      failure: 'broken',
      message: 'The scheduler stopped working'
    })
  })

  it('is broken, not noSolver, for a worker that dies mid-build without a message', async function () {
    const { options, workers, logs } = harness()
    const engine = webEngine(options)
    expect((await engine.build({ input: RUN })).kind).equals('options')
    workers[0].answer = 'error'
    expect(await engine.build({ input: RUN })).deep.equals({
      kind: 'failure',
      failure: 'broken',
      message: 'The scheduler stopped working'
    })
    expect(workers[0].terminated).equals(true)
    expect(logs).deep.equals(['scheduler unavailable: worker'])
    expect((await engine.build({ input: RUN })).kind).equals('options')
    expect(workers).lengthOf(2)
  })

  it('builds through the page’s engine, which has no module outside a built page', async function () {
    const warn = console.warn
    const warned: unknown[] = []
    console.warn = (...line: unknown[]) => warned.push(line.join(' '))
    try {
      expect(await buildSchedule({ input: RUN })).include({
        kind: 'failure',
        failure: 'noSolver'
      })
      expect(engineStatus()).equals('unavailable')
      expect(warned).deep.equals(['scheduler unavailable: noModule'])
    } finally {
      console.warn = warn
    }
  })
})
