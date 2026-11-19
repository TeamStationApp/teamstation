import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ROWS_PER_STATEMENT, runsOf } from './runs'

describe('runs of rows', () => {
  it('splits rows into runs of one statement each, in order', () => {
    expect(runsOf([])).deep.equals([])
    expect(runsOf([1, 2, 3])).deep.equals([[1, 2, 3]])
    const rows = Array.from({ length: 2 * ROWS_PER_STATEMENT + 1 }, (_, i) => i)
    const runs = runsOf(rows)
    expect(runs.map(run => run.length)).deep.equals([
      ROWS_PER_STATEMENT,
      ROWS_PER_STATEMENT,
      1
    ])
    expect(runs.flat()).deep.equals(rows)
  })
})
