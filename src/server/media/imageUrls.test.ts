import { expect } from 'chai'
import { describe, it } from 'mocha'

import { imageUrl } from './imageUrls'
import type { SpaceSettings } from './spacesHls'

const prefix = 'images/team/demo/hash'
const publicPrefix = `images/team/${'0123456789abcdef'.repeat(2)}`
const sharedPublic = `images/user/${'fedcba9876543210'.repeat(2)}`
const space: SpaceSettings = {
  endpoint: 'https://primary.example-ts.test',
  region: 'writer-region',
  bucket: 'development',
  accessKeyId: 'WRITEREXAMPLE',
  secretAccessKey: 'EXAMPLE',
  readOnlySource: {
    endpoint: 'https://source.example-ts.test',
    region: 'reader-region',
    bucket: 'library',
    accessKeyId: 'READEREXAMPLE',
    secretAccessKey: 'EXAMPLE',
    keys: [
      prefix + '-96.png',
      prefix + '-192.png',
      sharedPublic + '-96.png',
      sharedPublic + '-192.png'
    ]
  }
}

describe('image read source', function () {
  it('forwards shared source selection for both image sizes', function () {
    for (const size of [96, 192] as const) {
      const url = new URL(imageUrl(space, prefix, size) ?? '')
      expect(url.hostname).equals('library.source.example-ts.test')
      expect(url.searchParams.get('X-Amz-Credential')).contains(
        'READEREXAMPLE/'
      )
      expect(url.searchParams.has('X-Amz-Signature')).equals(true)
    }
  })
  it('keeps newly uploaded images and unlisted catalog entries on development', function () {
    expect(
      new URL(imageUrl(space, 'images/team/demo/new') ?? '').hostname
    ).equals('development.primary.example-ts.test')
    expect(
      new URL(imageUrl(space, 'images/catalog/example') ?? '').hostname
    ).equals('development.primary.example-ts.test')
  })
  it('preserves null, empty and unconfigured primary guards', function () {
    expect(imageUrl(space, null)).equals(null)
    expect(imageUrl(space, '')).equals(null)
    expect(imageUrl({ ...space, accessKeyId: '' }, prefix)).equals(null)
    expect(imageUrl({ ...space, accessKeyId: '' }, publicPrefix)).equals(null)
  })
})

describe('public image URLs', function () {
  it('serves a random public prefix from the bucket with no query', function () {
    expect(imageUrl(space, publicPrefix)).equals(
      `https://development.primary.example-ts.test/${publicPrefix}-96.png`
    )
    expect(imageUrl(space, publicPrefix, 192)).equals(
      `https://development.primary.example-ts.test/${publicPrefix}-192.png`
    )
  })
  it('builds on the configured media base, and on the path of a path-style Space', function () {
    expect(
      imageUrl(
        { ...space, mediaBaseUrl: 'https://cdn.example-ts.test/media/' },
        publicPrefix
      )
    ).equals(`https://cdn.example-ts.test/media/${publicPrefix}-96.png`)
    expect(
      imageUrl(
        { ...space, endpoint: 'http://127.0.0.1:9000', pathStyle: true },
        publicPrefix
      )
    ).equals(`http://127.0.0.1:9000/development/${publicPrefix}-96.png`)
  })
  it('serves a public key the read-only source holds from that source, with no query', function () {
    const url = imageUrl(space, sharedPublic, 192) ?? ''
    expect(url).equals(
      `https://library.source.example-ts.test/${sharedPublic}-192.png`
    )
  })
  it('signs a catalog picture and an old prefix', function () {
    for (const signed of [
      'images/catalog/v1/baseball/0123456789ab',
      'images/user/usr_1/aaaaaaaa',
      'demo-startup/hosts'
    ]) {
      const url = new URL(imageUrl(space, signed) ?? '')
      expect(url.searchParams.has('X-Amz-Signature'), signed).equals(true)
      expect(url.pathname).equals(`/${signed}-96.png`)
    }
  })
})
