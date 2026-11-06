import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { addGame, addTeam, scratchDatabase } from '../../test/scoreboardKit'
import type { MediaContext } from './mediaContext'
import { verifyQueryToken } from './mediaTokens'
import { posterSecond, postersFor, posterUrl, warmPosters } from './posters'
import { clearFragmentCache } from './spaceFrames'
import { stillKey, stillSubject } from './stills'
import { warmVideoStills } from './videoStills'

describe('a game poster', function () {
  it('is a signed URL to the API for a still kept beside the video in the Space', function () {
    const media = {
      publicUrl: 'https://app.teamstation.app',
      mediaSecret: 'secret'
    } as unknown as Parameters<typeof posterUrl>[0]
    const url = new URL(posterUrl(media, 'vid_1', 150.4, Date.UTC(2026, 9, 2)))
    expect(url.origin + url.pathname).equals(
      'https://app.teamstation.app/api/v1/videos/vid_1/stills/150.jpg'
    )
    const token = url.searchParams.get('t')
    expect(
      verifyQueryToken(
        'secret',
        stillSubject('vid_1', 150),
        token,
        Date.UTC(2026, 9, 2)
      )
    ).equals(true)
    // Good for that one frame only: not another second, not another video.
    for (const [videoId, atSec] of [
      ['vid_1', 151],
      ['vid_1', 0],
      ['vid_2', 150]
    ] as const)
      expect(
        verifyQueryToken(
          'secret',
          stillSubject(videoId, atSec),
          token,
          Date.UTC(2026, 9, 2)
        ),
        `${videoId} at ${atSec}`
      ).equals(false)
    expect(stillKey('vid_1', 150.4)).equals('videos/vid_1/stills/150.jpg')
  })

  it('asks for the frame it cut, whatever the video is worth', function () {
    // Two and a half minutes in for anything long enough to have one.
    expect(posterSecond(3600)).equals(150)
    expect(posterSecond(301)).equals(150)
    // And the middle of anything shorter. The list's URL used to ask for 150
    // while the cutter cut the middle, so a four-minute video's picture was
    // filed where nobody looked for it.
    expect(posterSecond(240)).equals(120)
    expect(posterSecond(20)).equals(10)
    // Nothing known about the length: assume it is long enough.
    expect(posterSecond(null)).equals(150)
    expect(posterSecond(undefined)).equals(150)
  })
})

describe('a poster or highlight still of a secret-path video', function () {
  this.timeout(30000)
  const SECRET = '0123456789abcdef0123456789abcdef'
  let server: Server
  const reads: string[] = []
  let media: MediaContext

  before(async function () {
    server = createServer((req, res) => {
      reads.push(new URL(req.url ?? '/', 'http://x').pathname)
      res.writeHead(404).end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    media = {
      mediaRoot: tmpdir(),
      ffmpegPath: 'ffmpeg',
      mediaSecret: 'secret',
      publicUrl: 'http://app.example.test',
      space: {
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        region: 'test',
        bucket: 'b',
        accessKeyId: 'example',
        secretAccessKey: 'example',
        pathStyle: true
      }
    }
  })
  after(function () {
    server.close()
  })

  it('reads its frames from the secret path, for the poster and for highlights', async function () {
    clearFragmentCache()
    reads.length = 0
    await warmPosters(media, [
      {
        gameId: 'gam_1',
        videoId: 'vid_poster',
        storage: 'spaces',
        spaceSecret: SECRET,
        durationSec: 600
      }
    ])
    await warmVideoStills(media, 'spaces', 'vid_still', SECRET, [
      { playOffsetSec: 30 }
    ])
    const media_ = reads.filter(path => !path.includes('/stills/'))
    expect(media_).deep.equals([
      `/b/videos/vid_poster-${SECRET}/master.m3u8`,
      `/b/videos/vid_still-${SECRET}/master.m3u8`
    ])
  })

  it('lists each game’s poster video with its secret', async function () {
    const { db, drop } = await scratchDatabase('posters_secret')
    try {
      const gameId = await addGame(db, {
        homeTeamId: await addTeam(db, 'Pioneers'),
        awayTeamId: await addTeam(db, 'Visitors'),
        startAt: new Date()
      })
      await db
        .insertInto('videos')
        .values({
          id: 'vid_poster',
          game_id: gameId,
          kind: 'program',
          title: 'Programme',
          storage: 'spaces',
          status: 'ready',
          hidden: false,
          space_secret: SECRET
        })
        .execute()
      expect((await postersFor(db, [gameId])).get(gameId)).deep.equals({
        gameId,
        videoId: 'vid_poster',
        storage: 'spaces',
        spaceSecret: SECRET,
        durationSec: null
      })
    } finally {
      await drop()
    }
  })
})
