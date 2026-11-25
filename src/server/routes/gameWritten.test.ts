import { expect } from 'chai'
import { describe, it } from 'mocha'

import { eachGameWritten, tellGameWritten } from './gameWritten'

describe('the hooks a committed write to a game tells', function () {
  it('tells each hook in turn, and the ones after a hook that throws', function () {
    const told: string[] = []
    const logged: unknown[][] = []
    const error = console.error
    console.error = (...args: unknown[]) => logged.push(args)
    try {
      eachGameWritten(
        gameId => told.push(`board ${gameId}`),
        () => {
          throw new Error('down')
        },
        gameId => told.push(`halves ${gameId}`)
      )('gam_a')
      tellGameWritten(undefined, 'gam_b')
    } finally {
      console.error = error
    }
    expect(told).deep.equals(['board gam_a', 'halves gam_a'])
    expect(logged).length(1)
    expect(logged[0][1]).equals('gam_a')
  })
})
