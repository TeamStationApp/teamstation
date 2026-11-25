import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { VideoSummary } from '../../common/api'
import {
  findSampleRecording,
  homeAngleOf,
  loopSeek,
  type SampleClient,
  sampleWindow
} from './sampleRecording'

const video = (
  id: string,
  title: string,
  durationSec: number | null = 3600
): VideoSummary => ({
  id,
  title,
  durationSec,
  numCameras: 1,
  kind: 'camera',
  status: 'ready',
  receiving: false,
  storage: 'local',
  startAt: null,
  syncOffsetSec: 0,
  width: 1920,
  height: 1080,
  codecs: null,
  posterUrl: null
})

interface World {
  seasons: Record<string, Array<{ id: string; startAt: string | null }>>
  games: Record<string, VideoSummary[]>
  unavailable?: string[]
  anywhere?: string[]
  groupFails?: boolean
}

/** A client over `world`, recording each read it was asked for. */
function fakeClient(world: World): SampleClient & { reads: string[] } {
  const reads: string[] = []
  const client = {
    reads,
    group: async ({ id }: { id: string }) => {
      reads.push(`group ${id}`)
      if (world.groupFails === true) throw new Error('offline')
      return {
        children: Object.keys(world.seasons)
          .map(season => ({
            id: season,
            kind: 'season'
          }))
          .concat([{ id: 'tea_one', kind: 'team' }])
      }
    },
    seasonGamesPage: async (seasonId: string, query: unknown) => {
      reads.push(`season ${seasonId} ${JSON.stringify(query)}`)
      if (seasonId === 'sea_broken') throw new Error('offline')
      return { items: world.seasons[seasonId] ?? [] }
    },
    game: async (gameId: string) => {
      reads.push(`game ${gameId}`)
      if (!(gameId in world.games)) throw new Error('not found')
      return { videos: world.games[gameId] }
    },
    playback: async (videoId: string) => {
      reads.push(`playback ${videoId}`)
      return {
        url: `https://media.example/${videoId}.m3u8`,
        unavailable: world.unavailable?.includes(videoId) === true
      }
    },
    videoGames: async (options: unknown) => {
      reads.push(`videoGames ${JSON.stringify(options)}`)
      if (world.anywhere == null) throw new Error('offline')
      return (world.anywhere ?? []).map(id => ({ id }))
    }
  }
  return client as unknown as SampleClient & { reads: string[] }
}

describe('the sponsor sample recording', () => {
  it('takes a home angle with a length, and not another camera', () => {
    expect(homeAngleOf([video('a', 'Home')])?.id).equals('a')
    expect(homeAngleOf([video('b', 'Home Plate')])?.id).equals('b')
    expect(homeAngleOf([video('c', 'Homer Cam')])).equals(undefined)
    expect(homeAngleOf([video('d', 'First Base')])).equals(undefined)
    expect(
      homeAngleOf([video('e', 'Home', null), video('f', 'home plate')])?.id
    ).equals('f')
  })

  it('takes the newest game across the league’s seasons', async () => {
    const client = fakeClient({
      seasons: {
        sea_spring: [{ id: 'gam_april', startAt: '2026-04-10T18:00:00Z' }],
        sea_broken: [],
        sea_fall: [
          { id: 'gam_october', startAt: '2026-10-02T18:00:00Z' },
          { id: 'gam_unscheduled', startAt: null }
        ]
      },
      games: {
        gam_april: [video('vid_april', 'Home')],
        gam_october: [
          video('vid_side', 'First Base'),
          video('vid_october', 'Home Plate')
        ]
      }
    })
    expect(await findSampleRecording(client, 'lea_demo')).deep.equals({
      kind: 'found',
      gameId: 'gam_october',
      videoId: 'vid_october',
      url: 'https://media.example/vid_october.m3u8',
      durationSec: 3600
    })
    expect(client.reads).includes(
      'season sea_fall {"when":"past","order":"desc","hasVideo":true,"limit":10}'
    )
    expect(client.reads.some(read => read.startsWith('season tea_one'))).equals(
      false
    )
  })

  it('passes over a game whose playback is unavailable, or that cannot be read', async () => {
    const client = fakeClient({
      seasons: {
        sea_fall: [
          { id: 'gam_newest', startAt: '2026-10-09T18:00:00Z' },
          { id: 'gam_gone', startAt: '2026-10-05T18:00:00Z' },
          { id: 'gam_no_home', startAt: '2026-10-04T18:00:00Z' },
          { id: 'gam_older', startAt: '2026-10-02T18:00:00Z' }
        ]
      },
      games: {
        gam_newest: [video('vid_newest', 'Home')],
        gam_no_home: [video('vid_first', 'First Base')],
        gam_older: [video('vid_older', 'Home', 1500)]
      },
      unavailable: ['vid_newest']
    })
    const found = await findSampleRecording(client, 'lea_demo')
    expect(found).deep.equals({
      kind: 'found',
      gameId: 'gam_older',
      videoId: 'vid_older',
      url: 'https://media.example/vid_older.m3u8',
      durationSec: 1500
    })
  })

  it('falls back to every recording the administrator can see, and then to none', async () => {
    const elsewhere = fakeClient({
      seasons: {
        sea_fall: [{ id: 'gam_side', startAt: '2026-10-09T18:00:00Z' }]
      },
      games: {
        gam_side: [video('vid_side', 'First Base')],
        gam_other: [video('vid_other', 'Home')]
      },
      anywhere: ['gam_other']
    })
    const found = await findSampleRecording(elsewhere, 'lea_demo')
    expect(found).deep.include({ kind: 'found', gameId: 'gam_other' })
    expect(elsewhere.reads).includes('videoGames {"sort":"date","limit":10}')

    const nowhere = fakeClient({ seasons: {}, games: {}, anywhere: [] })
    expect(await findSampleRecording(nowhere, 'lea_demo')).deep.equals({
      kind: 'none'
    })
  })

  it('gives none, without throwing, when the league cannot be read', async () => {
    const client = fakeClient({ seasons: {}, games: {}, groupFails: true })
    expect(await findSampleRecording(client, 'lea_demo')).deep.equals({
      kind: 'none'
    })
  })

  it('loops 30:00 to 32:00 of a long recording, else its first two minutes', () => {
    expect(sampleWindow(3600)).deep.equals([1800, 1920])
    expect(sampleWindow(1920)).deep.equals([1800, 1920])
    expect(sampleWindow(1919)).deep.equals([0, 120])
    expect(sampleWindow(90)).deep.equals([0, 90])
  })

  it('seeks back to the start at the end or outside the window, and not inside it', () => {
    expect(loopSeek(1920, [1800, 1920])).equals(1800)
    expect(loopSeek(1925, [1800, 1920])).equals(1800)
    expect(loopSeek(12, [1800, 1920])).equals(1800)
    expect(loopSeek(1800, [1800, 1920])).equals(null)
    expect(loopSeek(1850.5, [1800, 1920])).equals(null)
  })
})
