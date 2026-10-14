import { expect } from 'chai'

import { nativePlaybackSeconds } from './nativePlaybackClock'

describe('native playback acceptance clock', () => {
  it('reads the iOS value when the normalized label hides it', () => {
    expect(
      nativePlaybackSeconds(
        JSON.stringify({ nodes: [{ label: 'Elapsed time', value: '0:07' }] }),
        'ios'
      )
    ).equals(7)
    expect(
      nativePlaybackSeconds(
        '<XCUIElementTypeStaticText label="Elapsed time" value="1:02:03"/>',
        'ios'
      )
    ).equals(3723)
  })
  it('reads Android elapsed position rather than the duration or status bar', () => {
    expect(
      nativePlaybackSeconds(
        '<hierarchy><node text="14:20" resource-id="clock"/><node text="01:30" resource-id="app.example.test:id/exo_duration"/><node text="00:09" resource-id="app.example.test:id/exo_position"/></hierarchy>',
        'android'
      )
    ).equals(9)
  })
  it('rejects absent, hidden, ambiguous and non-clock values', () => {
    for (const nodes of [
      [{ label: 'Duration', value: '01:30' }],
      [{ label: 'Elapsed time', value: '00:04', visible: false }],
      [
        { label: 'Elapsed time', value: '00:04' },
        { label: 'Elapsed time', value: '00:05' }
      ],
      [{ label: 'Elapsed time', value: 'unavailable' }]
    ])
      expect(() =>
        nativePlaybackSeconds(JSON.stringify({ nodes }), 'ios')
      ).throws()
  })
})
