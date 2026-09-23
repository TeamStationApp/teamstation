import { expect } from 'chai'
import { describe, it } from 'mocha'

import { dueForPurge, type Purgeable } from './purge'

const now = new Date('2026-10-23T00:00:00.000Z')
const lastMonth = new Date('2026-09-23T00:00:00.000Z')
const nextMonth = new Date('2026-11-23T00:00:00.000Z')

const replaced = (over: Partial<Purgeable> = {}): Purgeable => ({
  id: 'vid_live',
  purgeAfter: lastMonth,
  hidden: true,
  replacedBy: 'vid_upload',
  ...over
})

describe('which replaced recordings are due to go', function () {
  it('takes one whose month is up', function () {
    expect(dueForPurge([replaced()], now)).deep.equals(['vid_live'])
  })

  it('leaves one whose month is not up yet', function () {
    // The month is the whole point: a replacement nobody has checked has four
    // weeks to be noticed and undone.
    expect(dueForPurge([replaced({ purgeAfter: nextMonth })], now)).deep.equals(
      []
    )
  })

  it('leaves a recording nobody dated', function () {
    expect(dueForPurge([replaced({ purgeAfter: null })], now)).deep.equals([])
  })

  it('leaves one somebody has brought back out of hiding', function () {
    // Un-hiding is a person acting on it. An old purge date is not a reason to
    // delete a recording behind them.
    expect(dueForPurge([replaced({ hidden: false })], now)).deep.equals([])
  })

  it('leaves one whose replacement has since been deleted', function () {
    // Deleting the replacement clears the pointer and un-hides this, and the
    // reason it was going to be deleted went with it.
    expect(dueForPurge([replaced({ replacedBy: null })], now)).deep.equals([])
  })

  it('leaves a recording PeerTube still owns', function () {
    // The delete route refuses one of these for the same reason: this server
    // reads that tree and does not own it.
    expect(dueForPurge([replaced({ storage: 'peertube' })], now)).deep.equals(
      []
    )
  })

  it('takes only what is due, out of a mixture', function () {
    const videos = [
      replaced({ id: 'vid_due' }),
      replaced({ id: 'vid_early', purgeAfter: nextMonth }),
      replaced({ id: 'vid_rescued', hidden: false }),
      replaced({ id: 'vid_orphan', replacedBy: null }),
      replaced({ id: 'vid_also_due', purgeAfter: lastMonth })
    ]
    expect(dueForPurge(videos, now)).deep.equals(['vid_due', 'vid_also_due'])
  })
})
