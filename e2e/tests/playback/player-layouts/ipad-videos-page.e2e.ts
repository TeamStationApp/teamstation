import { expect } from 'chai'

import { picturedVideosPage, playerDeviceSpec } from './device-videos-page.e2e'

// The legacy run's iPad was a simulator, which plays the stack's HEVC too.
export default playerDeviceSpec(
  'playback/player-layouts/ipad-videos-page',
  "A scored game's videos page opens on an iPad, in Safari and in the app",
  { ios: 'ipad' },
  'allowed',
  async ctx => {
    expect(await picturedVideosPage(ctx), 'the iPad pictured its screen').above(
      0
    )
  }
)
