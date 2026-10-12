import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import type { Database } from '../db/database'
import type { MediaContext } from '../media/mediaContext'
import { stillUrl } from '../media/stills'
import { errorHandler } from '../middleware/withErrors'
import { mediaRoutes } from './media'

/**
 * A still's signed URL, as a list hands it out: the API checks the token and
 * sends the browser to the still in the Space. A stand-in Space holds one
 * still; the database is never asked, because a still the Space already has
 * needs nothing else.
 */
describe('a still by its signed URL', function () {
  let space: Server | undefined
  let api: Server | undefined
  let media: MediaContext
  let origin = ''

  before(async function () {
    space = createServer((req, res) => {
      const found = (req.url ?? '').startsWith('/b/videos/vid_1/stills/150.jpg')
      res.writeHead(found ? 206 : 404).end(found ? 'x' : '')
    })
    await new Promise<void>(resolve => space?.listen(0, '127.0.0.1', resolve))
    const spacePort = (space.address() as AddressInfo).port

    media = {
      mediaRoot: '/nowhere',
      ffmpegPath: '/nowhere/ffmpeg',
      mediaSecret: 'secret',
      publicUrl: 'http://placeholder',
      space: {
        endpoint: `http://127.0.0.1:${spacePort}`,
        region: 'sfo3',
        bucket: 'b',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        pathStyle: true
      }
    }
    const app = express()
    app.use('/api/v1', mediaRoutes({} as unknown as Kysely<Database>, media))
    app.use(errorHandler)
    api = createServer(app)
    await new Promise<void>(resolve => api?.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  })

  after(function () {
    space?.close()
    api?.close()
  })

  const urlFor = (videoId: string, atSec: number): string =>
    stillUrl({ ...media, publicUrl: origin }, videoId, atSec)

  it('redirects to the still in the Space, for an hour', async function () {
    const response = await fetch(urlFor('vid_1', 150), { redirect: 'manual' })
    expect(response.status).equals(302)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.pathname).equals('/b/videos/vid_1/stills/150.jpg')
    expect(location.searchParams.get('X-Amz-Expires')).equals('3600')
    expect(response.headers.get('cache-control')).equals(
      'private, max-age=3540'
    )
  })

  it("refuses a token signed for another video's stills", async function () {
    const borrowed = new URL(urlFor('vid_2', 150))
    const response = await fetch(
      `${origin}/api/v1/videos/vid_1/stills/150.jpg${borrowed.search}`,
      { redirect: 'manual' }
    )
    expect(response.status).equals(403)
  })

  it('refuses a token signed for another second of the same video', async function () {
    // The Space holds 150, so only the token stands between this and a frame.
    const borrowed = new URL(urlFor('vid_1', 151))
    const response = await fetch(
      `${origin}/api/v1/videos/vid_1/stills/150.jpg${borrowed.search}`,
      { redirect: 'manual' }
    )
    expect(response.status).equals(403)
    // And the other way round: 150's token does not open 151.
    const handed = new URL(urlFor('vid_1', 150))
    const moved = await fetch(
      `${origin}/api/v1/videos/vid_1/stills/151.jpg${handed.search}`,
      { redirect: 'manual' }
    )
    expect(moved.status).equals(403)
  })

  it('answers 404 for a name that is not a second', async function () {
    const token = new URL(urlFor('vid_1', 150)).search
    const response = await fetch(
      `${origin}/api/v1/videos/vid_1/stills/poster.png${token}`,
      { redirect: 'manual' }
    )
    expect(response.status).equals(404)
  })
})
