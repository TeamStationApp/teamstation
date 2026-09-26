import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  GUMBO_EVENT_TYPES,
  normalizeEventType
} from '../../common/gumboEventTypes'
import { moreEvents, outcomeEvents } from './scoringContract'

describe('the scoring screen vocabulary', function () {
  it('names only event types a stored play may carry', function () {
    const stored: readonly string[] = GUMBO_EVENT_TYPES
    for (const [label, type] of [
      ...Object.entries(outcomeEvents),
      ...Object.entries(moreEvents)
    ])
      expect(stored, label).to.include(normalizeEventType(type))
  })
})
