import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { deleteObject, putObject } from '../media/images'
import { presignGetUrl } from '../media/presign'
import type { SpaceSettings } from '../media/spacesHls'
import { fakeSpaceHandler, listen, pathOfKey } from './fakeSpace'

/**
 * The stand-in Space (U10): chat keys for every verb, DELETE in CORS, and the
 * recordings' and pictures' keys as before. Started on port 0.
 */
describe('the stand-in Space', function () {
  let server: Server
  let dir: string
  const space: SpaceSettings = {
    endpoint: '',
    region: 'sfo3',
    bucket: 'test-bucket',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    pathStyle: true
  }

  before(async function () {
    dir = await mkdtemp(join(tmpdir(), 'tsFakeSpace-'))
    server = await listen('127.0.0.1', 0, { space, dir })
    space.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async function () {
    server?.close()
    await rm(dir, { recursive: true, force: true })
  })

  const signed = (
    key: string,
    method: 'GET' | 'PUT' | 'DELETE' = 'GET',
    secret = space.secretAccessKey
  ): string =>
    presignGetUrl({
      ...space,
      secretAccessKey: secret,
      method,
      key,
      expiresSec: 600
    })

  const chatKey = 'chat/cnv_one/cat_two'

  it('puts, gets, heads and deletes a chat attachment', async function () {
    const blob = Buffer.from('not a jpeg, just sealed bytes')
    const put = await fetch(signed(chatKey, 'PUT'), {
      method: 'PUT',
      body: new Uint8Array(blob)
    })
    expect(put.status).equals(200)
    expect(await readFile(join(dir, 'chat', 'cnv_one', 'cat_two'))).deep.equals(
      blob
    )

    const got = await fetch(signed(chatKey))
    expect(got.status).equals(200)
    expect(got.headers.get('content-type')).equals('application/octet-stream')
    expect(Buffer.from(await got.arrayBuffer())).deep.equals(blob)

    const head = await fetch(signed(chatKey), { method: 'HEAD' })
    expect(head.status).equals(200)
    expect(head.headers.get('content-length')).equals(String(blob.length))
    expect(await head.text()).equals('')

    const part = await fetch(signed(chatKey), {
      headers: { range: 'bytes=4-' }
    })
    expect(part.status).equals(206)
    expect(part.headers.get('content-range')).equals(
      `bytes 4-${blob.length - 1}/${blob.length}`
    )
    expect(await part.text()).equals(blob.subarray(4).toString())

    // A URL signed to read cannot delete, nor one signed to delete read.
    expect((await fetch(signed(chatKey), { method: 'DELETE' })).status).equals(
      403
    )
    expect((await fetch(signed(chatKey, 'DELETE'))).status).equals(403)

    const gone = await fetch(signed(chatKey, 'DELETE'), { method: 'DELETE' })
    expect(gone.status).equals(204)
    expect((await fetch(signed(chatKey))).status).equals(404)
    // Deleting what is not there is a success, as on S3.
    expect(
      (await fetch(signed(chatKey, 'DELETE'), { method: 'DELETE' })).status
    ).equals(204)
  })

  it('lists DELETE in its CORS methods', async function () {
    const answer = await fetch(`${space.endpoint}/${space.bucket}/${chatKey}`, {
      method: 'OPTIONS'
    })
    expect(answer.status).equals(204)
    expect(answer.headers.get('access-control-allow-methods')).equals(
      'GET,HEAD,PUT,DELETE'
    )
    expect(answer.headers.get('access-control-allow-origin')).equals('*')
    expect(answer.headers.get('access-control-allow-headers')).equals('range')
  })

  it('serves videos/… and images/… as before', async function () {
    const video = 'videos/vid_1/index.m3u8'
    const image = 'images/team/tm_1/abcd1234-96.png'
    for (const [key, type] of [
      [video, 'application/vnd.apple.mpegurl'],
      [image, 'image/png'],
      ['videos/vid_1/video.mp4', 'video/mp4']
    ]) {
      const body = Buffer.from(`body of ${key}`)
      expect(
        (
          await fetch(signed(key, 'PUT'), {
            method: 'PUT',
            body: new Uint8Array(body)
          })
        ).status
      ).equals(200)
      const got = await fetch(signed(key))
      expect(got.status).equals(200)
      expect(got.headers.get('content-type')).equals(type)
      expect(got.headers.get('accept-ranges')).equals('bytes')
      expect(Buffer.from(await got.arrayBuffer())).deep.equals(body)
    }
    expect(pathOfKey(dir, video)).equals(
      join(dir, 'videos', 'vid_1', 'index.m3u8')
    )
    expect(pathOfKey(dir, image)).equals(
      join(dir, 'images', 'team', 'tm_1', 'abcd1234-96.png')
    )
    expect(pathOfKey(dir, chatKey)).equals(
      join(dir, 'chat', 'cnv_one', 'cat_two')
    )
    const ranged = await fetch(signed(video), {
      headers: { range: 'bytes=0-3' }
    })
    expect(ranged.status).equals(206)
    expect(await ranged.text()).equals('body')
  })

  it('refuses what is unsigned, mis-signed, unknown or elsewhere', async function () {
    expect(
      (await fetch(`${space.endpoint}/${space.bucket}/${chatKey}`)).status
    ).equals(403)
    expect((await fetch(signed(chatKey, 'GET', 'wrong'))).status).equals(403)
    const badDate = new URL(signed(chatKey))
    badDate.searchParams.set('X-Amz-Date', 'yesterday')
    expect((await fetch(badDate)).status).equals(403)
    for (const key of ['chat/cnv_one', 'chat/a/b/c', 'other/a/b', 'videos/x']) {
      expect(pathOfKey(dir, key)).equals(undefined)
      expect((await fetch(signed(key))).status).equals(404)
    }
    expect(
      (await fetch(`${space.endpoint}/another-bucket/${chatKey}`)).status
    ).equals(404)
    expect((await fetch(signed('chat/cnv_one/cat_none'))).status).equals(404)
  })

  it('answers 500 when it cannot do what was asked', async function () {
    // A directory where the object would be written.
    await mkdir(join(dir, 'chat', 'cnv_dir', 'cat_dir'), { recursive: true })
    const answer = await fetch(signed('chat/cnv_dir/cat_dir', 'PUT'), {
      method: 'PUT',
      body: new Uint8Array(Buffer.from('x'))
    })
    expect(answer.status).equals(500)
    expect(
      (await stat(join(dir, 'chat', 'cnv_dir', 'cat_dir'))).isDirectory()
    ).equals(true)
  })

  it('takes the media helpers’ PUT and DELETE', async function () {
    const key = 'chat/cnv_helper/cat_helper'
    await putObject({
      space,
      key,
      body: Buffer.from('sealed'),
      contentType: 'application/octet-stream'
    })
    expect((await fetch(signed(key))).status).equals(200)
    await deleteObject({ space, key })
    expect((await fetch(signed(key))).status).equals(404)
    // A key the Space refuses to sign for fails the delete loudly.
    let failed: unknown
    try {
      await deleteObject({
        space: { ...space, secretAccessKey: 'wrong' },
        key
      })
    } catch (error) {
      failed = error
    }
    expect(String(failed)).contains('answered 403')
  })

  it('is a handler a test can mount itself', function () {
    expect(fakeSpaceHandler({ space, dir })).to.be.a('function')
  })
})
