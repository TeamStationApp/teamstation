import { expect } from 'chai'
import { describe, it } from 'mocha'

import { imageUrl } from './imageUrls'
import type { SpaceSettings } from './spacesHls'

const prefix = 'images/team/demo/hash'
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
    keys: [prefix + '-96.png', prefix + '-192.png']
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
  })
})
