import { expect } from 'chai'

import { noteHistoryMove, takeHistoryMove } from './historyMotion'

describe('history motion notes (U3)', function () {
  it('hands the noted move over once', function () {
    noteHistoryMove({ direction: 'back', drawn: true })
    expect(takeHistoryMove()).deep.equals({ direction: 'back', drawn: true })
    expect(takeHistoryMove()).equals(undefined)
  })

  it('keeps only the latest move', function () {
    noteHistoryMove({ direction: 'back', drawn: false })
    noteHistoryMove({ direction: 'none', drawn: false })
    expect(takeHistoryMove()).deep.equals({ direction: 'none', drawn: false })
  })

  it('has nothing when nothing was noted', function () {
    expect(takeHistoryMove()).equals(undefined)
  })
})
