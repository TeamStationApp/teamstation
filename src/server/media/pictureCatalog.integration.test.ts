import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { asCatalogId, pictureCatalog } from '../../common/pictureCatalog'
import { userIdOfGumbo } from '../../common/userId'
import {
  type AccountHarness,
  accountHarness,
  accountTestPicture
} from '../../test/accountHarness'
import { asPictureBody, storePlayerAvatar } from '../teams/storeTeamPictures'
import { sha256Of } from './images'
import {
  availablePictures,
  publishPictureCatalog,
  selectAccountCatalogPicture
} from './pictureCatalog'
import type { SpaceSettings } from './spacesHls'

describe('shared sports picture catalog', function () {
  this.timeout(60000)
  let h: AccountHarness
  before(async () => {
    h = await accountHarness()
  })
  after(async () => {
    await h?.close()
  })
  it('contains 28 originals and three creation icons with immutable hashes and transparency', async () => {
    expect(pictureCatalog.filter(entry => entry.kind === 'photo')).length(28)
    expect(pictureCatalog.filter(entry => entry.kind === 'creation')).length(3)
    expect(new Set(pictureCatalog.map(entry => entry.id)).size).equals(31)
    for (const entry of pictureCatalog) {
      const bytes = await readFile(
        resolve(`src/app/assets/sports/${entry.id}-192.png`)
      )
      expect(sha256Of(bytes)).equals(entry.sha256)
      expect(bytes.readUInt32BE(16)).equals(192)
      expect(bytes.readUInt32BE(20)).equals(192)
      expect(bytes[25]).equals(6) // PNG RGBA.
      const svg = await readFile(
        resolve(`src/app/assets/sports/${entry.id}.svg`),
        'utf8'
      )
      expect(new Set(svg.match(/#[a-fA-F0-9]{6}/g)).size).at.most(4)
    }
    expect(asCatalogId('baseball')).equals('baseball')
    expect(() => asCatalogId('https://example.com/foreign')).throws(TypeError)
  })
  it('publishes once and reuses the same objects across accounts', async () => {
    expect(
      await publishPictureCatalog(h.space, resolve('src/app/assets/sports'))
    ).equals(62)
    expect(
      await publishPictureCatalog(h.space, resolve('src/app/assets/sports'))
    ).equals(0)
    const count = h.objects.size
    await selectAccountCatalogPicture(h.db, userIdOfGumbo(101), 'baseball')
    await selectAccountCatalogPicture(h.db, userIdOfGumbo(102), 'baseball')
    const users = await h.db
      .selectFrom('users')
      .select(['avatar_path', 'picture_catalog_id'])
      .orderBy('id')
      .execute()
    expect(users[0]).deep.equals(users[1])
    expect(h.objects.size).equals(count)
    const first = (await availablePictures(h.space)).entries[0]
    expect((await fetch(first.url)).status).equals(200)
    await selectAccountCatalogPicture(h.db, userIdOfGumbo(102), 'basketball')
    expect(h.objects.size).equals(count)
    expect(
      await availablePictures({ ...h.space, accessKeyId: '' }).then(
        () => null,
        (error: unknown) => error
      )
    ).instanceOf(Error)
    expect(
      await selectAccountCatalogPicture(h.db, userIdOfGumbo(101), 'flag').then(
        () => null,
        (error: unknown) => error
      )
    ).instanceOf(TypeError)
  })
  it('refuses missing renditions and allows retry after publication', async () => {
    const entry = pictureCatalog[0]
    h.objects.delete(`/${h.space.bucket}/${entry.prefix}-192.png`)
    expect(
      await availablePictures(h.space).then(
        () => null,
        (error: unknown) => error
      )
    ).instanceOf(Error)
    await publishPictureCatalog(h.space, resolve('src/app/assets/sports'))
    expect((await availablePictures(h.space)).entries).length(31)
  })
  it('reads a signature-enforcing private catalog with GET and recovers when a rendition is missing', async () => {
    const fixtureSecret = 'synthetic-catalog-signature-secret'
    const bucket = 'synthetic-pictures'
    const objects = new Set(
      pictureCatalog.map(entry => `/${bucket}/${entry.prefix}-192.png`)
    )
    const image = await readFile(
      resolve('src/app/assets/sports/baseball-192.png')
    )
    let rangeReads = 0
    const hmac = (key: Buffer, value: string): Buffer =>
      createHmac('sha256', key).update(value).digest()
    const encode = (value: string): string =>
      encodeURIComponent(value).replace(
        /[!'()*]/g,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      )
    const validSignature = (request: IncomingMessage): boolean => {
      const url = new URL(request.url!, `http://${request.headers.host}`)
      const credential = url.searchParams.get('X-Amz-Credential')?.split('/')
      if (credential?.length !== 5) return false
      const [access, date, region, service, terminator] = credential
      if (
        access !== 'fixture-access' ||
        service !== 's3' ||
        terminator !== 'aws4_request'
      )
        return false
      const supplied = url.searchParams.get('X-Amz-Signature')
      url.searchParams.delete('X-Amz-Signature')
      const query = [...url.searchParams]
        .map(([key, value]) => [encode(key), encode(value)])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([key, value]) => `${key}=${value}`)
        .join('&')
      const canonical = [
        request.method,
        url.pathname,
        query,
        `host:${request.headers.host}\n`,
        'host',
        'UNSIGNED-PAYLOAD'
      ].join('\n')
      const digest = createHash('sha256').update(canonical).digest('hex')
      const scope = [date, region, service, terminator].join('/')
      const key = hmac(
        hmac(
          hmac(hmac(Buffer.from(`AWS4${fixtureSecret}`), date), region),
          service
        ),
        terminator
      )
      return (
        hmac(
          key,
          [
            'AWS4-HMAC-SHA256',
            url.searchParams.get('X-Amz-Date'),
            scope,
            digest
          ].join('\n')
        ).toString('hex') === supplied
      )
    }
    const server = createServer((request, response) => {
      if (!validSignature(request)) {
        response.writeHead(403).end('SignatureDoesNotMatch')
        return
      }
      if (
        !objects.has(
          new URL(request.url!, `http://${request.headers.host}`).pathname
        )
      ) {
        response.writeHead(404).end()
        return
      }
      if (request.headers.range === 'bytes=0-0') {
        rangeReads++
        response
          .writeHead(206, {
            'content-type': 'image/png',
            'content-range': `bytes 0-0/${image.length}`
          })
          .end(image.subarray(0, 1))
      } else response.writeHead(200, { 'content-type': 'image/png' }).end(image)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const space: SpaceSettings = {
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      bucket,
      region: 'fixture-region',
      accessKeyId: 'fixture-access',
      secretAccessKey: fixtureSecret,
      pathStyle: true
    }
    try {
      const available = await availablePictures(space)
      expect(available.entries).length(31)
      expect(rangeReads).equals(31)
      const get = await fetch(available.entries[0].url)
      expect(get.status).equals(200)
      expect(Buffer.from(await get.arrayBuffer())).deep.equals(image)
      expect(
        (await fetch(available.entries[0].url, { method: 'HEAD' })).status
      ).equals(403)
      const missing = [...objects][0]
      objects.delete(missing)
      expect(
        await availablePictures(space).then(
          () => null,
          (error: unknown) => error
        )
      ).instanceOf(Error)
      objects.add(missing)
      expect((await availablePictures(space)).entries).length(31)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    }
  })
  it('protects a manual catalog choice from imports and clears its marker on upload', async () => {
    const store = { space: h.space, ffmpegPath: 'ffmpeg' }
    const picture = asPictureBody({
      image: accountTestPicture,
      source: 'import'
    })
    expect(
      await storePlayerAvatar(h.db, store, userIdOfGumbo(101), picture, false)
    ).deep.equals({ stored: false, kept: 'upload' })
    expect(
      (
        await h.db
          .selectFrom('users')
          .select('picture_catalog_id')
          .where('id', '=', userIdOfGumbo(101))
          .executeTakeFirstOrThrow()
      ).picture_catalog_id
    ).equals('baseball')
    await storePlayerAvatar(
      h.db,
      store,
      userIdOfGumbo(101),
      { ...picture, source: 'upload' },
      true
    )
    expect(
      (
        await h.db
          .selectFrom('users')
          .select('picture_catalog_id')
          .where('id', '=', userIdOfGumbo(101))
          .executeTakeFirstOrThrow()
      ).picture_catalog_id
    ).equals(null)
  })
  it('refuses unavailable stores, failed upload and mismatched immutable objects', async () => {
    expect(
      await publishPictureCatalog({ ...h.space, accessKeyId: '' }, '').then(
        () => null,
        (error: unknown) => error
      )
    ).instanceOf(Error)
    const first = pictureCatalog[0]
    const key = `/${h.space.bucket}/${first.prefix}-96.png`
    h.objects.set(key, Buffer.from('changed'))
    expect(
      await publishPictureCatalog(
        h.space,
        resolve('src/app/assets/sports')
      ).then(
        () => null,
        (error: unknown) => error
      )
    ).instanceOf(Error)
    h.objects.delete(key)
    h.controls.failPut = true
    expect(
      await publishPictureCatalog(
        h.space,
        resolve('src/app/assets/sports')
      ).then(
        () => null,
        (error: unknown) => error
      )
    ).instanceOf(Error)
    h.controls.failPut = false
    expect(
      await publishPictureCatalog(
        h.space,
        resolve('src/app/assets/sports')
      ).then(
        () => 'ok',
        () => 'error'
      )
    ).equals('ok')
  })
})
