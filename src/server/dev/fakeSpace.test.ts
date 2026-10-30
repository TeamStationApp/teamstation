import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'

import { deleteObject, putObject } from '../media/images'
import { presignGetUrl } from '../media/presign'
import type { SpaceSettings } from '../media/spacesHls'
import { deleteSpacePrefix, listSpaceObjects } from '../media/spacesVideo'
import {
  fakeSpaceHandler,
  listen,
  pathOfKey,
  startFakeSpace
} from './fakeSpace'

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
    method: 'GET' | 'HEAD' | 'PUT' | 'DELETE' = 'GET',
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

    const head = await fetch(signed(chatKey, 'HEAD'), { method: 'HEAD' })
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

describe('the live-origin Space fixture', function () {
  let fixture: Awaited<ReturnType<typeof startFakeSpace>>
  let dir: string
  let space: SpaceSettings
  let log: string
  before(async function () {
    dir = await mkdtemp(join(tmpdir(), 'tsOriginSpace-'))
    space = {
      endpoint: '',
      region: 'test',
      bucket: 'test',
      accessKeyId: 'example',
      secretAccessKey: 'example',
      pathStyle: true
    }
    log = join(dir, 'requests.log')
    fixture = await startFakeSpace({ space, dir, log })
    space.endpoint = fixture.url
  })
  after(async function () {
    fixture.server.close()
    await rm(dir, { recursive: true, force: true })
  })
  afterEach(() => {
    fixture.faults.clear()
  })
  const key = 'videos/vid_origin/stills/7.jpg'
  const sign = (
    method: 'GET' | 'HEAD' | 'PUT' | 'DELETE',
    name = key,
    query?: Record<string, string>
  ): string =>
    presignGetUrl({ ...space, method, key: name, query, expiresSec: 300 })
  const put = async (name = key, body = 'picture'): Promise<Response> =>
    await fetch(sign('PUT', name), {
      method: 'PUT',
      body,
      headers: { 'content-type': 'image/jpeg' }
    })

  it('stores nested objects and their content types and lists only objects with MD5 ETags', async function () {
    await put()
    const got = await fetch(sign('GET'))
    expect(got.headers.get('content-type')).equals('image/jpeg')
    expect(await got.text()).equals('picture')
    const head = await fetch(sign('HEAD'), { method: 'HEAD' })
    expect(head.headers.get('content-type')).equals('image/jpeg')
    expect(head.headers.get('content-length')).equals('7')
    expect((await fetch(sign('GET'), { method: 'HEAD' })).status).equals(403)
    const xml = await (
      await fetch(sign('GET', '', { 'list-type': '2', prefix: 'videos/' }))
    ).text()
    expect(xml).contains(
      `<Key>${key}</Key><Size>7</Size><ETag>&quot;${createHash('md5').update('picture').digest('hex')}&quot;</ETag>`
    )
    expect(xml).not.contains('content-type')
    expect(await listSpaceObjects(space, 'videos/')).deep.equals([key])
    expect(await deleteSpacePrefix(space, 'videos/')).deep.equals({
      deleted: 1
    })
    expect((await fetch(sign('GET'))).status).equals(404)
    expect(
      await stat(join(dir, key + '.content-type')).catch(() => undefined)
    ).equals(undefined)
    expect(await readFile(log, 'utf8')).contains(
      'PUT /test/videos/vid_origin/stills/7.jpg 200 127.0.0.1'
    )
    expect(await readFile(log, 'utf8')).not.contains('X-Amz')
  })

  it('lists and deletes recordings larger than the whole-file read limit', async function () {
    this.timeout(60000)
    const prefix = 'videos/vid_large/'
    const key = `${prefix}video.mp4`
    await mkdir(join(dir, prefix), { recursive: true })
    const file = await open(join(dir, key), 'w')
    try {
      await file.truncate(2147483648)
    } finally {
      await file.close()
    }
    try {
      const response = await fetch(
        sign('GET', '', { 'list-type': '2', prefix })
      )
      expect(response.status).equals(200)
      expect(await response.text()).contains(
        `<Key>${key}</Key><Size>2147483648</Size><ETag>&quot;a981130cf2b7e09f4686dc273cf7187e&quot;</ETag>`
      )
      expect(await deleteSpacePrefix(space, prefix)).deep.equals({ deleted: 1 })
      expect(await stat(join(dir, key)).catch(() => undefined)).equals(
        undefined
      )
    } finally {
      await rm(join(dir, prefix), { recursive: true, force: true })
    }
  })

  it('paginates escaped keys and signs every listing query parameter', async function () {
    const names = ['videos/vid_origin/a&.mp4', 'videos/vid_origin/b<>"\'.mp4']
    for (const name of names) await put(name)
    const url = sign('GET', '', {
      'list-type': '2',
      prefix: 'videos/',
      'max-keys': '1'
    })
    const body = await (await fetch(url)).text()
    expect(body).contains('<IsTruncated>true</IsTruncated>')
    expect(body).contains(
      '<NextContinuationToken>videos/vid_origin/a&amp;.mp4</NextContinuationToken>'
    )
    const second = await (
      await fetch(
        sign('GET', '', {
          'list-type': '2',
          prefix: 'videos/',
          'max-keys': '1',
          'continuation-token': names[0]
        })
      )
    ).text()
    expect(second).contains('b&lt;&gt;&quot;&apos;.mp4')
    expect(second).contains('<IsTruncated>false</IsTruncated>')
    const tampered = new URL(url)
    tampered.searchParams.set('prefix', 'chat/')
    expect((await fetch(tampered)).status).equals(403)
    const wrongHost = new URL(
      presignGetUrl({
        ...space,
        endpoint: 'http://elsewhere.example.test',
        key,
        expiresSec: 300
      })
    )
    expect(
      (await fetch(space.endpoint + wrongHost.pathname + wrongHost.search))
        .status
    ).equals(403)
    expect(await listSpaceObjects(space, 'videos/')).deep.equals(names)
    await deleteSpacePrefix(space, 'videos/')
  })

  it('applies delay, status, truncation and read-back faults and clears them', async function () {
    fixture.faults.set({
      method: 'PUT',
      key: /stills/g,
      delayMs: 40,
      truncateTo: 3
    })
    const started = Date.now()
    await put()
    expect(Date.now() - started).at.least(35)
    expect(await (await fetch(sign('GET'))).text()).equals('pic')
    fixture.faults.set({ method: 'DELETE', key: /absent/, status: 500 })
    fixture.faults.set({ method: 'GET', readBack: Buffer.from('changed') })
    expect(
      await (
        await fetch(sign('GET'), { headers: { range: 'bytes=2-4' } })
      ).text()
    ).equals('ang')
    fixture.faults.set({ method: 'PUT', status: 503 })
    expect((await put()).status).equals(503)
    fixture.faults.clear()
    await put()
    expect(await (await fetch(sign('GET'))).text()).equals('picture')
  })

  it('rejects unsafe keys and invalid ranges, and serves suffix ranges', async function () {
    for (const name of [
      'videos/a/../x',
      'videos/a/./x',
      'videos/a//x',
      'videos/a/x\\y',
      'videos/a/x\0',
      'videos/a/x.content-type',
      'videos/a/.upload-x'
    ])
      expect(pathOfKey(dir, name)).equals(undefined)
    expect((await fetch(sign('GET'), { method: 'POST' })).status).equals(405)
    await put()
    expect(
      (await fetch(sign('GET'), { headers: { range: 'bytes=100-200' } })).status
    ).equals(416)
    expect(
      await (
        await fetch(sign('GET'), { headers: { range: 'bytes=-3' } })
      ).text()
    ).equals('ure')
    expect(
      await (
        await fetch(sign('GET'), { headers: { range: 'bytes=4-100' } })
      ).text()
    ).equals('ure')
    await mkdir(join(dir, 'videos/vid_origin/directory'), { recursive: true })
    expect(
      (await fetch(sign('GET', 'videos/vid_origin/directory'))).status
    ).equals(404)
    await writeFile(join(dir, 'videos/vid_origin/raw.m4s'), 'raw')
    expect(
      (await fetch(sign('GET', 'videos/vid_origin/raw.m4s'))).headers.get(
        'content-type'
      )
    ).equals('video/iso.segment')
  })
})
