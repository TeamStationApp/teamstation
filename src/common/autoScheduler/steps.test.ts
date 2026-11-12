import { expect } from 'chai'
import { describe, it } from 'mocha'

import { input, season } from './fixtures.test'
import { buildOptions, buildOptionsAsync } from './index'
import { finishSteps, finishStepsAsync } from './steps'

describe('cooperative device scheduling', function () {
  this.timeout(30000)
  it('keeps timers running throughout a normal search with identical results', async () => {
    const run = input({
      seasons: [season({ regularGames: 20, exhibitionGames: 0 })]
    })
    let ticks = 0
    const timer = setInterval(() => {
      ticks++
    }, 10)
    try {
      const asyncResult = await buildOptionsAsync(run)
      expect(ticks).greaterThan(5)
      expect(asyncResult).deep.equals(buildOptions(run))
    } finally {
      clearInterval(timer)
    }
  })
  it('returns immediate and blocked results and propagates step failures', async () => {
    function* immediate(): Generator<void, number> {
      return 42
    }
    expect(finishSteps(immediate())).equals(42)
    expect(await finishStepsAsync(immediate())).equals(42)
    const blocked = input({ seasons: [] })
    expect(await buildOptionsAsync(blocked)).deep.equals(buildOptions(blocked))
    function* failure(): Generator<void, never> {
      yield
      throw new Error('step failed')
    }
    expect(() => finishSteps(failure())).throws('step failed')
    let error: unknown
    try {
      await finishStepsAsync(failure())
    } catch (caught) {
      error = caught
    }
    expect(String(error)).includes('step failed')
  })
})
