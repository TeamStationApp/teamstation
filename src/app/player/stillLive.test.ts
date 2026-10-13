import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GameDetail } from '../../common/api'
import { isStillLive } from './stillLive'

describe('whether the game still lists a video as live', function () {
  const client = {
    game: async (gameId: string) =>
      ({
        id: gameId,
        videos: [
          { id: 'vid_000000000001', status: 'live' },
          { id: 'vid_000000000002', status: 'ready' }
        ]
      }) as unknown as GameDetail
  }

  it('says so for a live angle, and not for a finished or a missing one', async function () {
    expect(
      await isStillLive(client, 'gam_000000000001', 'vid_000000000001')
    ).equals(true)
    expect(
      await isStillLive(client, 'gam_000000000001', 'vid_000000000002')
    ).equals(false)
    expect(
      await isStillLive(client, 'gam_000000000001', 'vid_000000000003')
    ).equals(false)
  })
})
