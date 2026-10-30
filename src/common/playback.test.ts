import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asPlayback } from './api'

const missing = {
  videoId: 'vid_recording',
  storage: 'local',
  url: null,
  expiresAt: null,
  durationSec: 3,
  unavailable: true
}

describe('pending playback publication', () => {
  it('preserves the pending signal while accepting an older response', () => {
    expect(asPlayback({ ...missing, pending: true }).pending).equals(true)
    expect(asPlayback({ ...missing, pending: false }).pending).equals(false)
    expect(asPlayback(missing).pending).equals(undefined)
    expect(() => asPlayback({ ...missing, pending: 'yes' })).throws()
  })
})
