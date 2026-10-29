import { execFile } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { drainPublishForTest, finishStream } from '../live/controller'
import { originFixture } from '../live/originFixtures'
import { clearFragmentCache } from './spaceFrames'
import { ensureStill, stillUrl } from './stills'

describe('stills of a closed live Space recording', function () {
  this.timeout(60000)
  it('serves the same JPEG through either still route after the ingest scratch is gone', async () => {
    const f = await originFixture()
    clearFragmentCache()
    try {
      await f.stage(12)
      await f.begin()
      await drainPublishForTest(f.videoId)
      const reference = join(f.root, 'reference.mp4')
      const referencePlaylist = join(f.dir, 'reference.m3u8')
      await writeFile(
        referencePlaylist,
        (await readFile(join(f.dir, 'master.m3u8'), 'utf8')) +
          '#EXT-X-ENDLIST\n'
      )
      await promisify(execFile)(f.options.ffmpegPath, [
        '-v',
        'error',
        '-i',
        referencePlaylist,
        '-c',
        'copy',
        reference
      ])
      const expected = await ensureStill({
        ffmpegPath: f.options.ffmpegPath,
        source: { kind: 'file', path: reference },
        space: f.options.space!,
        videoId: 'vid_reference',
        atSec: 8
      })
      await finishStream(f.options, f.stream.id, 'Finished')
      await drainPublishForTest(f.videoId)
      expect(await stat(f.dir).catch(() => undefined)).equals(undefined)
      f.requests.length = 0
      const response = await fetch(
        `${f.f.h.origin}/api/v1/videos/${f.videoId}/still?t=8`,
        {
          headers: { authorization: `Bearer ${f.f.h.tokens.get(105)}` },
          redirect: 'manual'
        }
      )
      expect(response.status).equals(302)
      const jpeg = Buffer.from(
        await (await fetch(response.headers.get('location')!)).arrayBuffer()
      )
      expect(jpeg.equals(await readFile(join(f.remote, expected)))).equals(true)
      expect(
        f.requests
          .filter(r => r.method === 'GET' && r.key.endsWith('.m4s'))
          .map(r => r.key.split('/').at(-1))
      ).deep.equals(['seg000008.m4s'])
      expect(f.requests.some(r => r.key.endsWith('video.mp4'))).equals(false)
      const signed = stillUrl(f.media, f.videoId, 9).replace(
        f.media.publicUrl + '/api/v1',
        ''
      )
      const publicResponse = await fetch(`${f.f.h.origin}/api/v1${signed}`, {
        redirect: 'manual'
      })
      expect(publicResponse.status).equals(302)
      expect(
        (await fetch(publicResponse.headers.get('location')!)).headers.get(
          'content-type'
        )
      ).equals('image/jpeg')
      console.log(
        'still from segment:',
        response.status,
        'JPEG bytes:',
        jpeg.length,
        'scratch absent:',
        true
      )
    } finally {
      await f.close()
    }
  })
})
