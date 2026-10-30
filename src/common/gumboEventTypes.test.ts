import { expect } from 'chai'
import { describe, it } from 'mocha'

import { describePlay } from './describePlay'
import { mlbEventName, STORED_EVENT_TYPES } from './gumbo/reference'
import {
  eventTypeName,
  GUMBO_EXTENSION_EVENT_TYPES,
  isGumboEventType,
  isLegacyEventType,
  normalizeEventType
} from './gumboEventTypes'
import { outcomeName } from './outcomes'

describe('the pinch runner who keeps the batting order (U4c)', function () {
  it('is an extension with its own name, and normalises to itself', function () {
    expect(isGumboEventType('ts_courtesy_runner')).equals(true)
    expect(isLegacyEventType('ts_courtesy_runner')).equals(false)
    expect(GUMBO_EXTENSION_EVENT_TYPES).includes('ts_courtesy_runner')
    expect(STORED_EVENT_TYPES.has('ts_courtesy_runner')).equals(true)
    expect(normalizeEventType('ts_courtesy_runner')).equals(
      'ts_courtesy_runner'
    )
    expect(eventTypeName('ts_courtesy_runner')).equals(
      'Pinch runner (order unchanged)'
    )
    expect(mlbEventName('ts_courtesy_runner')).equals(
      'Pinch runner (order unchanged)'
    )
  })

  it('reads as a pinch runner in a play and on a player page', function () {
    expect(
      describePlay({
        eventType: 'ts_courtesy_runner',
        inning: 3,
        halfInning: 'top',
        credits: []
      })
    ).equals('Top 3rd: Pinch runner (order unchanged).')
    expect(
      outcomeName({
        eventType: 'ts_courtesy_runner',
        head: 'Runner',
        credit: { role: 'runner' }
      })
    ).equals('Pinch runner')
  })
})
