import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  exitAfterBuilder,
  forceStop,
  startStatsBuilder,
  type StatsBuilderHandle
} from './serverHooks'

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('startStatsBuilder', function () {
  it('with enabled false forks nothing, logs, and stop resolves at once', async function () {
    const logs: string[] = []
    let supervised = 0
    const builder = startStatsBuilder({
      enabled: false,
      supervise: () => {
        supervised++
        return { stop: async () => undefined }
      },
      log: message => logs.push(message)
    })

    expect(supervised).equals(0)
    expect(logs).deep.equals([
      'stats builder is switched off (statsBuilder is false)'
    ])
    await builder.stop('SIGTERM')
  })

  it('with enabled true returns the supervised builder', function () {
    const handle: StatsBuilderHandle = {
      stop: async () => undefined
    }
    const builder = startStatsBuilder({
      enabled: true,
      supervise: () => handle,
      log: () => undefined
    })
    expect(builder).equals(handle)
  })
})

describe('exitAfterBuilder and forceStop', function () {
  it('exit runs only after stop resolves; exitAfterBuilder uses SIGTERM', async function () {
    const stops: string[] = []
    let resolveStop: (() => void) | undefined
    const builder: StatsBuilderHandle = {
      stop: async signal => {
        stops.push(String(signal))
        await new Promise<void>(resolve => {
          resolveStop = resolve
        })
      }
    }
    const exits: number[] = []
    const exit = exitAfterBuilder(builder, code => exits.push(code))

    exit(0)
    await wait(1)
    expect(stops).deep.equals(['SIGTERM'])
    expect(exits).deep.equals([])

    resolveStop?.()
    await wait(1)
    expect(exits).deep.equals([0])
  })

  it('forceStop stops with SIGKILL before exit', async function () {
    const stops: string[] = []
    let resolveStop: (() => void) | undefined
    const builder: StatsBuilderHandle = {
      stop: async signal => {
        stops.push(String(signal))
        await new Promise<void>(resolve => {
          resolveStop = resolve
        })
      }
    }
    const exits: number[] = []
    const exit = forceStop(builder, code => exits.push(code), 50)

    exit(1)
    await wait(1)
    expect(stops).deep.equals(['SIGKILL'])
    expect(exits).deep.equals([])

    resolveStop?.()
    await wait(1)
    expect(exits).deep.equals([1])
  })

  it('forceStop exits on deadline when stop never resolves', async function () {
    const builder: StatsBuilderHandle = {
      stop: async () => {
        await new Promise(() => undefined)
      }
    }
    const exits: number[] = []
    const exit = forceStop(builder, code => exits.push(code), 20)

    exit(1)
    await wait(1)
    expect(exits).deep.equals([])
    await wait(40)
    expect(exits).deep.equals([1])
  })
})
