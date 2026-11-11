import { expect } from 'chai'
import { describe, it } from 'mocha'

import { hasNewFocusRequest } from './focusRequest'

describe('capture acknowledgement of a focus tap', function () {
  it('requires a new request in the same generation', function () {
    expect(
      hasNewFocusRequest(
        'focus-state:camera:first',
        'focus-state:camera:second'
      )
    ).equals(true)
    expect(
      hasNewFocusRequest('focus-state:camera:none', 'focus-state:camera:first')
    ).equals(true)
    for (const next of [
      undefined,
      'focus-state:camera:first',
      'focus-state:camera:',
      'focus-state:camera:none',
      'focus-state:replacement:none',
      'focus-state:replacement:second'
    ]) {
      expect(hasNewFocusRequest('focus-state:camera:first', next)).equals(false)
    }
  })
})
