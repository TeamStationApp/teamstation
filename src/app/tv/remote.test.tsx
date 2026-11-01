import { expect } from 'chai'
import { describe, it } from 'mocha'

import { normalizeRemote } from './remote'

describe('TV remote input normalization', () => {
  it('keeps native press and touch phases distinct', () => {
    for (const direction of ['Left', 'Right', 'Up', 'Down']) {
      const lower = direction.toLowerCase()
      expect(normalizeRemote({ eventType: lower, eventKeyAction: 0 })).equals(
        null
      )
      expect(
        normalizeRemote({ eventType: lower, eventKeyAction: 1 })
      ).deep.equals({ kind: 'click', direction: lower })
      expect(
        normalizeRemote({ eventType: lower, eventKeyAction: 0 }, false)
      ).deep.equals({ kind: 'click', direction: lower })
      expect(
        normalizeRemote({ eventType: lower, eventKeyAction: 1 }, false)
      ).equals(null)
      expect(
        normalizeRemote({
          eventType: `swipe${direction}`,
          body: { state: 'Ended' }
        })
      ).deep.equals({ kind: 'swipe', direction: lower })
      expect(
        normalizeRemote({
          eventType: `swipe${direction}`,
          body: { state: 'Began' }
        })
      ).equals(null)
      for (const action of [0, 1])
        expect(
          normalizeRemote({
            eventType: `long${direction}`,
            eventKeyAction: action
          })
        ).deep.equals({
          kind: 'hold',
          direction: lower,
          phase: action === 0 ? 'begin' : 'end'
        })
      expect(normalizeRemote({ eventType: `long${direction}` })).equals(null)
    }
    for (const [state, phase] of [
      ['Began', 'begin'],
      ['Changed', 'change'],
      ['Ended', 'end'],
      ['Cancelled', 'cancel']
    ])
      expect(
        normalizeRemote({ eventType: 'pan', body: { state, x: 25 } })
      ).deep.equals({ kind: 'pan', phase, x: 25 })
    expect(normalizeRemote({ eventType: 'pan' })).equals(null)
    expect(
      normalizeRemote({ eventType: 'pan', body: { state: 'Began', x: NaN } })
    ).equals(null)
    expect(normalizeRemote({ eventType: 'swipeLeft' })).deep.equals({
      kind: 'swipe',
      direction: 'left'
    })
    expect(normalizeRemote({ eventType: 'cancel' })).deep.equals({
      kind: 'cancel'
    })
    expect(normalizeRemote({ eventType: 'disconnect' })).deep.equals({
      kind: 'cancel'
    })
    expect(normalizeRemote({ eventType: 'playPause' })).deep.equals({
      kind: 'playPause'
    })
    expect(normalizeRemote({ eventType: 'focus' })).equals(null)
  })
})
