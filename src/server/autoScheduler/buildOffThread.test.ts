import { expect } from 'chai'
import { describe, it } from 'mocha'

import { buildOptions } from '../../common/autoScheduler'
import { input } from '../../common/autoScheduler/fixtures.test'
import { buildOffThread } from './buildOffThread'

describe('building a schedule off the server’s thread', function () {
  this.timeout(60000)

  it('gives the options building in place gives, while the server goes on', async () => {
    const run = input()
    let turns = 0
    let building = true
    const tick = (): void => {
      if (!building) return
      turns++
      setImmediate(tick)
    }
    setImmediate(tick)
    const result = await buildOffThread(run)
    building = false
    expect(result).deep.equals(buildOptions(run))
    // The event loop kept turning while the worker built.
    expect(turns).greaterThan(0)
  })

  it('runs builds one at a time, in turn, and goes on after one fails', async () => {
    const run = input()
    const done: string[] = []
    const one = buildOffThread(run).then(() => done.push('one'))
    // The failing build is quick, but waits its turn.
    const failed = buildOffThread({ ...run, seasons: null as never }).catch(
      () => done.push('failed')
    )
    const two = buildOffThread(run).then(() => done.push('two'))
    await Promise.all([one, failed, two])
    expect(done).deep.equals(['one', 'failed', 'two'])
  })

  it('stops a build that runs too long', async () => {
    let failure: unknown
    await buildOffThread(input(), 1).catch((error: unknown) => {
      failure = error
    })
    expect(String(failure)).includes('took too long')
    // The next build still runs.
    expect((await buildOffThread(input())).options.length).greaterThan(0)
  })

  it('rejects when the build fails', async () => {
    let failure: unknown
    await buildOffThread({ ...input(), seasons: null as never }).catch(
      (error: unknown) => {
        failure = error
      }
    )
    expect(failure).instanceOf(Error)
  })
})
