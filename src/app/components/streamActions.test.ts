import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { LiveStream, TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import {
  asksTwice,
  copyStreamUrl,
  runStreamAction,
  streamActionsFor
} from './streamActions'

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
    revealLiveStream: answer('reveal'),
    rotateLiveStream: answer('rotate'),
    endLiveStream: answer('end'),
    removeLiveStream: async (gameId: string, id: string) => {
      calls.push(`remove ${gameId} ${id}`)
    },
    deleteVideo: async (videoId: string) => {
      calls.push(`deleteVideo ${videoId}`)
      return { id: videoId, removedFromSpace: 0 }
    }
  } as unknown as TeamStationClient
  return { client, calls }
}

describe('stream actions', function () {
  it('offers on each camera what the stream panel offers', function () {
    expect(streamActionsFor(camera(), true)).deep.equals([
      'reveal',
      'rotate',
      'end',
      'remove'
    ])
    expect(streamActionsFor(camera({ state: 'publishing' }), true)).deep.equals(
      ['reveal', 'rotate', 'end']
    )
    expect(
      streamActionsFor(camera({ state: 'ended', videoId: 'vid_1' }), true)
    ).deep.equals(['reveal', 'rotate', 'deleteVideo', 'remove'])
    expect(
      streamActionsFor(camera({ state: 'publishing', videoId: 'vid_1' }), true)
    ).deep.equals(['reveal', 'rotate', 'end'])
    expect(streamActionsFor(camera(), false)).deep.equals(['end'])
    expect(
      streamActionsFor(camera({ state: 'publishing' }), false)
    ).deep.equals(['end'])
    expect(streamActionsFor(camera({ state: 'ended' }), false)).deep.equals([])
  })

  it('asks twice on the air, always before deleting, and never to reveal', function () {
    const live = camera({ state: 'publishing' })
    const idle = camera()
    for (const action of ['rotate', 'end', 'remove'] as const) {
      expect(asksTwice(action, live), action).equals(true)
      expect(asksTwice(action, idle), action).equals(false)
    }
    expect(asksTwice('deleteVideo', idle)).equals(true)
    expect(asksTwice('reveal', live)).equals(false)
  })

  it('makes each call, and answers the camera when the call does', async function () {
    const { client, calls } = fakeClient()
    const stream = camera({ videoId: 'vid_1' })
    expect(
      (await runStreamAction(client, 'gam_1', stream, 'reveal'))?.url
    ).equals('rtmp://ingest.example.test/live/reveal')
    expect(
      (await runStreamAction(client, 'gam_1', stream, 'rotate'))?.url
    ).equals('rtmp://ingest.example.test/live/rotate')
    expect((await runStreamAction(client, 'gam_1', stream, 'end'))?.url).equals(
      'rtmp://ingest.example.test/live/end'
    )
    expect(
      await runStreamAction(client, 'gam_1', stream, 'deleteVideo')
    ).equals(undefined)
    expect(await runStreamAction(client, 'gam_1', stream, 'remove')).equals(
      undefined
    )
    // Nothing to delete without a recording.
    await runStreamAction(client, 'gam_1', camera(), 'deleteVideo')
    expect(calls).deep.equals([
      'reveal gam_1 liv_1',
      'rotate gam_1 liv_1',
      'end gam_1 liv_1',
      'deleteVideo vid_1',
      'remove gam_1 liv_1'
    ])
  })

  it('copies the URL it holds, or asks for it, and says when there is none', async function () {
    const { client, calls } = fakeClient()
    const copied: string[] = []
    const copy = (text: string): void => {
      copied.push(text)
    }
    expect(
      await copyStreamUrl(
        client,
        'gam_1',
        camera({ url: 'rtmp://ingest.example.test/live/held' }),
        copy
      )
    ).equals('rtmp://ingest.example.test/live/held')
    expect(calls).deep.equals([])
    await copyStreamUrl(client, 'gam_1', camera(), copy)
    expect(copied).deep.equals([
      'rtmp://ingest.example.test/live/held',
      'rtmp://ingest.example.test/live/reveal'
    ])
    const empty = {
      revealLiveStream: async () => camera()
    } as unknown as TeamStationClient
    let refused: unknown
    try {
      await copyStreamUrl(empty, 'gam_1', camera(), copy)
    } catch (error) {
      refused = error
    }
    expect((refused as Error).message).equals('This camera has no URL to copy')
  })
})
