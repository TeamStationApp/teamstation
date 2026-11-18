import { expect } from 'chai'
import { describe, it } from 'mocha'

import { finishSteps } from './steps'

describe('cooperative engine steps', function () {
  it('returns an immediate result and propagates step failures', () => {
    function* immediate(): Generator<void, number> {
      return 42
    }
    expect(finishSteps(immediate())).equals(42)
    function* stepped(): Generator<void, number> {
      yield
      yield
      return 7
    }
    expect(finishSteps(stepped())).equals(7)
    function* failure(): Generator<void, never> {
      yield
      throw new Error('step failed')
    }
    expect(() => finishSteps(failure())).throws('step failed')
  })
})
