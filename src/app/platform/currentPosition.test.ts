import { expect } from 'chai'
import { describe, it } from 'mocha'

import { currentPosition } from './currentPosition'

describe('the current position on the web', () => {
  it('answers the browser’s position, or null when it refuses or has none', async () => {
    const asked: unknown[] = []
    const answering = {
      getCurrentPosition: (
        found: (position: unknown) => void,
        _refused: () => void,
        options: unknown
      ) => {
        asked.push(options)
        found({ coords: { latitude: 40.02, longitude: -75.22 } })
      }
    } as unknown as Geolocation
    expect(await currentPosition(answering)).deep.equals({
      latitude: 40.02,
      longitude: -75.22
    })
    expect(asked[0]).include({ enableHighAccuracy: false, timeout: 8000 })
    const refusing = {
      getCurrentPosition: (_found: unknown, refused: () => void) => {
        refused()
      }
    } as unknown as Geolocation
    expect(await currentPosition(refusing)).equals(null)
    expect(await currentPosition(undefined)).equals(null)
  })
})
