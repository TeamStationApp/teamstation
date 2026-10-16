import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ingressReceiving } from './receiving'

const snapshot = (bytesPerSecond: number): unknown => ({
  liveStreamId: 'liv_1',
  ingress: {
    publishing: true,
    receivingPackets: bytesPerSecond > 0,
    bytesReceived: 1000,
    bytesPerSecond
  },
  outputs: []
})

describe('whether a stream is sending bytes', () => {
  it('is true only while the last snapshot shows bytes arriving', () => {
    expect(ingressReceiving(snapshot(500))).equals(true)
    expect(ingressReceiving(snapshot(0))).equals(false)
    expect(ingressReceiving(null)).equals(false)
    expect(ingressReceiving({ ingress: { publishing: true } })).equals(false)
  })
})
