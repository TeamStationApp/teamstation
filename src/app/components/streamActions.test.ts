import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { LiveStream, TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { asksTwice, phoneStreamActions, runStreamAction } from './streamActions'

function camera(patch: Partial<LiveStream> = {}): LiveStream {
  return {
    id: 'liv_1',
    gameId: 'gam_1',
    userId: userIdOfGumbo(7),
    ownerName: 'Mookie Betts',
    slot: 1,
    label: 'Home Plate',
    keyPrefix: 'ts_0000',
    state: 'idle',
    opensAt: '2026-05-20T16:00:00.000Z',
    closesAt: null,
    videoId: null,
    lastError: null,
    status: null,
    url: undefined,
    ...patch
  }
}

function fakeClient(): { client: TeamStationClient; calls: string[] } {
  const calls: string[] = []
  const answer =
    (name: string) =>
    async (gameId: string, id: string): Promise<LiveStream> => {
      calls.push(`${name} ${gameId} ${id}`)
      return camera({ id, url: `rtmp://ingest.example.test/live/${name}` })
    }
  const client = {
    rotateLiveStream: answer('rotate'),
    endLiveStream: answer('end')
  } as unknown as TeamStationClient
  return { client, calls }
}

describe('stream actions', function () {
  it('narrows a phone to Rotate key and End on its own camera, End on somebody else’s', function () {
    const idle = camera({ state: 'idle' })
    expect(phoneStreamActions(idle, true)).deep.equals(['rotate', 'end'])
    expect(phoneStreamActions(idle, false)).deep.equals(['end'])
    expect(
      phoneStreamActions(camera({ state: 'publishing' }), true)
    ).deep.equals(['rotate', 'end'])
    for (const mine of [true, false]) {
      expect(phoneStreamActions(camera({ state: 'ended' }), mine)).deep.equals(
        []
      )
      expect(
        phoneStreamActions(
          camera({ state: 'publishing', closesAt: '2026-05-20T17:00:00.000Z' }),
          mine
        )
      ).deep.equals([])
    }
  })

  it('confirms actions while video is arriving', function () {
    for (const action of ['rotate', 'end'] as const) {
      expect(asksTwice(action, camera({ state: 'publishing' }))).equals(true)
      expect(asksTwice(action, camera())).equals(false)
    }
  })
  it('rotates and ends through the server', async function () {
    const { client, calls } = fakeClient()
    for (const action of ['rotate', 'end'] as const)
      await runStreamAction(client, 'gam_1', camera(), action)
    expect(calls).deep.equals(['rotate gam_1 liv_1', 'end gam_1 liv_1'])
  })
})
