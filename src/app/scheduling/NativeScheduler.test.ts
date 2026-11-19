import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { input } from '../../common/autoScheduler/fixtures.test'
import {
  nativeEngine,
  type NativeSchedulerModule,
  NO_NATIVE_SCHEDULER
} from '../../common/scheduler/nativeEngine'
import { CANCELED, type WireRequest } from '../../common/scheduler/wire'

/**
 * `NativeScheduler` as a phone loads it: the TurboModule React Native registered
 * under that name, or null in a build without it. React Native itself is
 * replaced in the module cache by a registry of this test's.
 */
const reactNative = require.resolve('react-native')
const spec = require.resolve('./NativeScheduler')
const wrapper = require.resolve('../../common/scheduler/engine.native')

function loadWith(modules: Record<string, unknown>): {
  module: unknown
  asked: string[]
} {
  const asked: string[] = []
  Reflect.deleteProperty(require.cache, spec)
  require.cache[reactNative] = {
    id: reactNative,
    filename: reactNative,
    loaded: true,
    exports: {
      TurboModuleRegistry: {
        get: (name: string) => {
          asked.push(name)
          return modules[name] ?? null
        }
      }
    }
  } as unknown as NodeJS.Module
  const loaded = require('./NativeScheduler') as { default: unknown }
  return { module: loaded.default, asked }
}

describe('the scheduler TurboModule spec', function () {
  afterEach(function () {
    Reflect.deleteProperty(require.cache, spec)
    Reflect.deleteProperty(require.cache, wrapper)
    Reflect.deleteProperty(require.cache, reactNative)
  })

  it('asks React Native for NativeScheduler, and is null without it', function () {
    const { module, asked } = loadWith({})
    expect(asked).deep.equals(['NativeScheduler'])
    expect(module).equals(null)
  })

  it('is the registered module when the app carries it', function () {
    const native = { build: () => ({}) }
    expect(loadWith({ NativeScheduler: native }).module).equals(native)
  })
})

const RUN = input({ seasons: [], fields: [] })

const NOTHING = JSON.stringify({
  kind: 'options',
  options: [],
  blocking: null,
  targets: []
})

/** A module that answers as the C++ one does, recording what it was asked. */
function fakeModule(
  answer: () => Promise<string> = async () => NOTHING
): NativeSchedulerModule & {
  requests: string[]
  canceled: number
  progress: Array<(event: string) => void>
} {
  const fake = {
    requests: [] as string[],
    canceled: 0,
    progress: [] as Array<(event: string) => void>,
    build: (request: string, onProgress: (event: string) => void) => {
      fake.requests.push(request)
      fake.progress.push(onProgress)
      return {
        promise: answer(),
        cancel: () => {
          fake.canceled++
        },
        decide: () => undefined
      }
    }
  }
  return fake
}

describe('the phones’ scheduler engine', function () {
  afterEach(function () {
    Reflect.deleteProperty(require.cache, spec)
    Reflect.deleteProperty(require.cache, wrapper)
    Reflect.deleteProperty(require.cache, reactNative)
  })

  it('is noSolver in an app built without the module', async function () {
    const engine = nativeEngine(null)
    expect(engine.available()).equals(false)
    expect(await engine.build({ input: RUN })).deep.equals(NO_NATIVE_SCHEDULER)
  })

  it('sends the request with its offsets, hands on events, and words the answer', async function () {
    const module = fakeModule()
    const engine = nativeEngine(module)
    expect(engine.available()).equals(true)
    const events: unknown[] = []
    const answer = await engine.build(
      { input: RUN, limitMs: 9000 },
      { onProgress: event => events.push(event) }
    )
    expect(answer).include({ kind: 'options' })
    const sent = JSON.parse(module.requests[0]) as WireRequest
    expect(sent.limitMs).equals(9000)
    expect(sent.offsets).deep.equals({})
    module.progress[0]('{"kind":"phase-start","phase":"model"}')
    module.progress[0]('{"kind":"phase","phase":"model","ms":2}')
    expect(events).deep.equals([
      { kind: 'phase-start', phase: 'model' },
      { kind: 'phase', phase: 'model', ms: 2 }
    ])
  })

  it('answers the time limit through decide, and a cancel answer through cancel', async function () {
    const limit = {
      kind: 'limit',
      stage: 'placement',
      bestGames: null,
      boundGames: 338,
      solvedMs: 120_000
    }
    for (const choice of ['continue', 'use', 'cancel'] as const) {
      let finish: (text: string) => void = () => undefined
      const decided: string[] = []
      const module = fakeModule(
        async () =>
          await new Promise<string>(resolve => {
            finish = resolve
          })
      )
      const build = module.build
      module.build = (request, onProgress) => {
        const handle = build(request, onProgress) as {
          decide: (choice: string) => void
        }
        handle.decide = answer => {
          decided.push(answer)
        }
        return handle
      }
      const limits: unknown[] = []
      const pending = nativeEngine(module).build(
        { input: RUN },
        {
          onLimit: async each => {
            limits.push(each)
            return choice
          }
        }
      )
      module.progress[0](JSON.stringify(limit))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(limits).deep.equals([limit])
      expect(decided).deep.equals(choice === 'cancel' ? [] : [choice])
      expect(module.canceled).equals(choice === 'cancel' ? 1 : 0)
      finish(NOTHING)
      expect((await pending).kind).equals('options')
    }
  })

  it('hands on every event the module delivers before its answer, the last phases too', async function () {
    // As the C++ module's outbox delivers on the JS thread: the last events
    // and then the answer, in one task.
    let deliver: () => void = () => undefined
    const module = fakeModule(
      async () =>
        await new Promise<string>(resolve => {
          deliver = () => {
            for (const phase of ['cause', 'polish', 'options']) {
              module.progress[0](JSON.stringify({ kind: 'phase-start', phase }))
              module.progress[0](
                JSON.stringify({ kind: 'phase', phase, ms: 1 })
              )
            }
            resolve(NOTHING)
          }
        })
    )
    const heard: string[] = []
    const pending = nativeEngine(module)
      .build(
        { input: RUN },
        {
          onProgress: event => {
            heard.push(
              event.kind === 'phase'
                ? event.phase
                : event.kind === 'phase-start'
                  ? `+${event.phase}`
                  : event.kind
            )
          }
        }
      )
      .then(answer => {
        heard.push(`answer ${answer.kind}`)
      })
    deliver()
    await pending
    expect(heard).deep.equals([
      '+cause',
      'cause',
      '+polish',
      'polish',
      '+options',
      'options',
      'answer options'
    ])
  })

  it('cancels the native build when the session aborts', async function () {
    let finish: (text: string) => void = () => undefined
    const module = fakeModule(
      async () =>
        await new Promise<string>(resolve => {
          finish = resolve
        })
    )
    const controller = new AbortController()
    const pending = nativeEngine(module).build(
      { input: RUN },
      { signal: controller.signal }
    )
    controller.abort()
    expect(module.canceled).equals(1)
    finish(JSON.stringify(CANCELED))
    expect(await pending).deep.equals(CANCELED)
    // Aborted before: the module is not asked.
    expect(
      await nativeEngine(module).build(
        { input: RUN },
        { signal: controller.signal }
      )
    ).deep.equals(CANCELED)
    expect(module.requests).lengthOf(1)
  })

  it('is broken when the module throws, rejects, or answers no build', async function () {
    const throwing: NativeSchedulerModule = {
      build: () => {
        throw new Error('no thread')
      }
    }
    expect(await nativeEngine(throwing).build({ input: RUN })).deep.equals({
      kind: 'failure',
      failure: 'broken',
      message: 'no thread'
    })
    const rejecting = fakeModule(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'gone'
    })
    expect(await nativeEngine(rejecting).build({ input: RUN })).include({
      failure: 'broken',
      message: 'gone'
    })
    const odd: NativeSchedulerModule = { build: () => ({ promise: 1 }) }
    expect(await nativeEngine(odd).build({ input: RUN })).include({
      failure: 'broken',
      message: 'NativeScheduler answered no build'
    })
  })

  it('builds through the module React Native registered, or answers noSolver', async function () {
    const module = fakeModule()
    loadWith({ NativeScheduler: module })
    const loaded = require('../../common/scheduler/engine.native') as {
      buildSchedule: (request: { input: typeof RUN }) => Promise<unknown>
    }
    expect(await loaded.buildSchedule({ input: RUN })).include({
      kind: 'options'
    })
    expect(module.requests).lengthOf(1)
    Reflect.deleteProperty(require.cache, wrapper)
    loadWith({})
    const without = require('../../common/scheduler/engine.native') as {
      buildSchedule: (request: { input: typeof RUN }) => Promise<unknown>
    }
    expect(await without.buildSchedule({ input: RUN })).deep.equals(
      NO_NATIVE_SCHEDULER
    )
  })
})
