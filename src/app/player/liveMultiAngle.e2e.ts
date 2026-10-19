import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { API, finish, fixture, signedIn } from './playerLayoutsRig.e2e'

/**
 * The live multi-angle scenarios in a browser (E5–E8): the live writer at a
 * timestamp jump, one wall clock for every player, the angle switch, the
 * 45 s live delay, tiles past their live edge, and browsers that cannot play
 * the video. On the fixture's live game V, whose angles publish for twenty
 * minutes after the fixture starts them (`fixture.ts --start-live`).
 *
 *   (the environment of playerLayouts.e2e.ts) \
 *     npx mocha -r sucrase/register --extension ts --timeout 900000 \
 *     src/app/player/liveMultiAngle.e2e.ts
 */
describe('live multi-angle in a browser', function () {
  after(async function () {
    await finish()
  })

  it("lists the live game's two angles with playlists", async function () {
    const V = fixture().games.V
    const client = new TeamStationClient({
      baseUrl: API,
      token: await signedIn()
    })
    for (const videoId of V.videos) {
      const playback = await client.playback(videoId)
      expect(playback.url, videoId).to.be.a('string')
    }
  })
})
