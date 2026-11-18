import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type SchedulerLoader,
  type SchedulerModule,
  type SchedulerReply,
  schedulerWorker
} from './schedulerWorker'

/** The smallest WebAssembly module: the magic number and version 1. */
const EMPTY_MODULE = (): ArrayBuffer =>
  Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]).buffer

/**
 * A stand-in for the glue's module: it instantiates the posted bytes as
 * Emscripten does, through `instantiateWasm`, and answers each request by
 * `respond`. The real module is checked in `buildCsp.integration.test.ts`.
 */
function fakeLoader(
  respond: (
    request: string,
    module: SchedulerModule
  ) => string | null | 'trap' | Promise<string | null | 'trap'>,
  freed: number[] = []
): SchedulerLoader {
  return async options => {
    const { instantiateWasm, locateFile } = options as {
      instantiateWasm: (
        imports: WebAssembly.Imports,
        done: (instance: WebAssembly.Instance) => void
      ) => object
      locateFile: () => string
    }
    expect(locateFile()).equals('scheduler.wasm')
    await new Promise<void>(resolve => {
      instantiateWasm({}, () => {
        resolve()
      })
    })
    const memory = new Map<number, string>()
    let next = 1
    const module: SchedulerModule = {
      stringToNewUTF8: text => {
        memory.set(next, text)
        return next++
      },
      UTF8ToString: pointer => memory.get(pointer) ?? '',
      // As Emscripten's ccall with `async`: a number, or a promise of one
      // when the build pauses.
      ccall: (_name, _returns, _args, [pointer]): number | Promise<number> => {
        const finish = (answer: string | null | 'trap'): number => {
          if (answer === 'trap') throw new Error('RuntimeError: unreachable')
          if (answer == null) return 0
          memory.set(next, answer)
          return next++
        }
        const answer = respond(memory.get(pointer) ?? '', module)
        return answer instanceof Promise ? answer.then(finish) : finish(answer)
      },
      _scheduler_free: pointer => {
        freed.push(pointer)
        memory.delete(pointer)
      },
      _free: pointer => {
        freed.push(pointer)
        memory.delete(pointer)
      }
    }
    return module
  }
}

/** Answers a request and collects what the worker posts. */
async function ask(
  answer: ReturnType<typeof schedulerWorker>['answer'],
  request: unknown
): Promise<SchedulerReply[]> {
  const posted: SchedulerReply[] = []
  await answer(request, reply => posted.push(reply))
  return posted
}

describe('the scheduler worker', function () {
  it('loads the posted module, builds each request, and frees what it used', async function () {
    const freed: number[] = []
    const { answer } = schedulerWorker(
      fakeLoader(request => `{"kind":"options","echo":${request}}`, freed)
    )
    expect(
      await ask(answer, { type: 'init', bytes: EMPTY_MODULE() })
    ).deep.equals([{ type: 'ready' }])
    expect(
      await ask(answer, { type: 'build', id: 4, request: '{"input":1}' })
    ).deep.equals([
      { type: 'result', id: 4, result: '{"kind":"options","echo":{"input":1}}' }
    ])
    // The request's copy, then the answer's.
    expect(freed).deep.equals([1, 2])
  })

  it('hands on each event, waits at the limit for the page’s answer, and builds one at a time', async function () {
    const order: string[] = []
    const { answer } = schedulerWorker(
      fakeLoader(async (request, module) => {
        order.push(`start ${request}`)
        module.onSchedulerEvent?.('{"kind":"phase-start","phase":"context"}')
        module.onSchedulerEvent?.('{"kind":"phase","phase":"context","ms":1}')
        const choice = await module.schedulerDecide?.()
        order.push(`end ${request} ${choice}`)
        return `{"choice":${choice}}`
      })
    )
    await ask(answer, { type: 'init', bytes: EMPTY_MODULE() })
    const posted: SchedulerReply[] = []
    const post = (reply: SchedulerReply): void => {
      posted.push(reply)
    }
    const first = answer({ type: 'build', id: 1, request: '"a"' }, post)
    const second = answer({ type: 'build', id: 2, request: '"b"' }, post)
    await new Promise(resolve => setTimeout(resolve, 5))
    // The second waits its turn; an answer for another build, or one the
    // worker does not know, is dropped.
    expect(order).deep.equals(['start "a"'])
    await answer({ type: 'decide', id: 2, choice: 'use' }, post)
    await answer({ type: 'decide', id: 1, choice: 'maybe' }, post)
    expect(order).deep.equals(['start "a"'])
    await answer({ type: 'decide', id: 1, choice: 'continue' }, post)
    await first
    expect(order.slice(0, 2)).deep.equals(['start "a"', 'end "a" 0'])
    // Then the second runs, and its answer reaches it.
    await new Promise(resolve => setTimeout(resolve, 5))
    await answer({ type: 'decide', id: 2, choice: 'cancel' }, post)
    await second
    expect(order.slice(2)).deep.equals(['start "b"', 'end "b" 2'])
    expect(posted).deep.equals([
      {
        type: 'progress',
        id: 1,
        event: '{"kind":"phase-start","phase":"context"}'
      },
      {
        type: 'progress',
        id: 1,
        event: '{"kind":"phase","phase":"context","ms":1}'
      },
      { type: 'result', id: 1, result: '{"choice":0}' },
      {
        type: 'progress',
        id: 2,
        event: '{"kind":"phase-start","phase":"context"}'
      },
      {
        type: 'progress',
        id: 2,
        event: '{"kind":"phase","phase":"context","ms":1}'
      },
      { type: 'result', id: 2, result: '{"choice":2}' }
    ])
    // An answer said before its build waits is kept for that wait.
    const { answer: early } = schedulerWorker(
      fakeLoader(async (_request, module) => {
        await new Promise(resolve => setTimeout(resolve, 10))
        return `{"choice":${await module.schedulerDecide?.()}}`
      })
    )
    await ask(early, { type: 'init', bytes: EMPTY_MODULE() })
    const pending = ask(early, { type: 'build', id: 5, request: '{}' })
    await new Promise(resolve => setTimeout(resolve, 2))
    await early({ type: 'decide', id: 5, choice: 'use' }, () => undefined)
    expect(await pending).deep.equals([
      { type: 'result', id: 5, result: '{"choice":1}' }
    ])
  })

  it('ignores a message it does not know, and answers a build before the module noSolver', async function () {
    const { answer } = schedulerWorker(fakeLoader(() => '{}'))
    for (const request of [
      null,
      { type: 'nonsense' },
      { type: 'build', id: 'x', request: '{}' },
      { type: 'build', id: 2, request: 7 },
      { type: 'init', bytes: 'not a buffer' }
    ])
      expect(await ask(answer, request)).deep.equals([])
    const [early] = await ask(answer, { type: 'build', id: 3, request: '{}' })
    expect(early).include({ type: 'result', id: 3 })
    if (early.type === 'result')
      expect(JSON.parse(early.result)).include({ failure: 'noSolver' })
  })

  it('is done once the module traps or cannot allocate an answer', async function () {
    for (const answerOf of ['trap', null] as const) {
      const { answer } = schedulerWorker(fakeLoader(() => answerOf))
      await ask(answer, { type: 'init', bytes: EMPTY_MODULE() })
      const [failed] = await ask(answer, {
        type: 'build',
        id: 1,
        request: '{}'
      })
      expect(failed.type).equals('failed')
      const [after] = await ask(answer, { type: 'build', id: 2, request: '{}' })
      if (after.type === 'result')
        expect(JSON.parse(after.result)).include({ failure: 'noSolver' })
      else expect.fail('a result')
    }
  })

  it('reports a module that will not instantiate at once, though the loader never settles', async function () {
    // Emscripten's loader waits on `done` forever when instantiation fails.
    const { answer } = schedulerWorker(async options => {
      ;(
        options as unknown as {
          instantiateWasm: (imports: object, done: () => void) => object
        }
      ).instantiateWasm({}, () => undefined)
      return await new Promise<never>(() => undefined)
    })
    const posted: SchedulerReply[] = []
    const running = answer({ type: 'init', bytes: new ArrayBuffer(8) }, reply =>
      posted.push(reply)
    )
    expect(running).instanceOf(Promise)
    for (let wait = 0; posted.length === 0 && wait < 100; wait++)
      await new Promise(resolve => setTimeout(resolve, 20))
    expect(posted).lengthOf(1)
    expect(posted[0].type).equals('failed')
  })

  it('reports a module that will not load, and a worker with no glue', async function () {
    const { answer } = schedulerWorker(async () => {
      throw new Error('bad module')
    })
    expect(
      await ask(answer, { type: 'init', bytes: new ArrayBuffer(8) })
    ).deep.equals([{ type: 'failed', reason: 'Error: bad module' }])
    // Outside a built worker the bundle carries no glue.
    const bare = schedulerWorker()
    expect(
      await ask(bare.answer, { type: 'init', bytes: new ArrayBuffer(8) })
    ).deep.equals([
      { type: 'failed', reason: 'No scheduler glue in this worker' }
    ])
  })
})
