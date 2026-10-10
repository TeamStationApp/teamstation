import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  isReadOnlySourceKey,
  presignGetUrl,
  type ReadOnlySpaceSource
} from './presign'

/**
 * The first test is AWS's own worked example for a presigned GET, from
 * "Signature Version 4 signing process — Example: presigned URL". Its expected
 * signature is published, so this checks the implementation against the
 * specification rather than against itself.
 */
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  bucket: 'examplebucket',
  key: 'test.txt',
  region: 'us-east-1',
  endpoint: 'https://s3.amazonaws.com',
  expiresSec: 86400,
  now: new Date('2013-05-24T00:00:00Z')
}

describe('presigned Spaces URLs', function () {
  it("matches AWS's published example signature", function () {
    const url = presignGetUrl(AWS_EXAMPLE)
    expect(url).contains(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    )
  })

  it('signs the whole object, so every byte range works', function () {
    // `Range` must not appear anywhere in the signature or its signed headers,
    // or a player could not seek without a new URL per seek.
    const url = presignGetUrl(AWS_EXAMPLE)
    expect(url).contains('X-Amz-SignedHeaders=host')
    expect(url.toLowerCase()).does.not.contain('range')
  })

  it('puts the bucket in the host, as Spaces expects', function () {
    const url = presignGetUrl({
      ...AWS_EXAMPLE,
      endpoint: 'https://sfo3.digitaloceanspaces.com',
      region: 'sfo3',
      bucket: 'example-media-bkt',
      key: 'videos/vid_abc/video.mp4'
    })
    expect(url).contains(
      'https://example-media-bkt.sfo3.digitaloceanspaces.com/videos/vid_abc/video.mp4?'
    )
    expect(url).contains('%2Fsfo3%2Fs3%2Faws4_request')
  })

  it('can put the bucket in the path instead', function () {
    const url = presignGetUrl({ ...AWS_EXAMPLE, pathStyle: true })
    expect(url).contains('https://s3.amazonaws.com/examplebucket/test.txt?')
  })

  it('encodes a key without touching its slashes', function () {
    const url = presignGetUrl({
      ...AWS_EXAMPLE,
      key: 'videos/vid abc/video (1).mp4'
    })
    expect(url).contains('/videos/vid%20abc/video%20%281%29.mp4?')
  })

  it('changes with the expiry, the key and the moment', function () {
    const base = presignGetUrl(AWS_EXAMPLE)
    const signatureOf = (url: string): string =>
      url.slice(url.indexOf('X-Amz-Signature='))

    expect(
      signatureOf(presignGetUrl({ ...AWS_EXAMPLE, expiresSec: 3600 }))
    ).does.not.equal(signatureOf(base))
    expect(
      signatureOf(presignGetUrl({ ...AWS_EXAMPLE, key: 'other.txt' }))
    ).does.not.equal(signatureOf(base))
    expect(
      signatureOf(
        presignGetUrl({ ...AWS_EXAMPLE, now: new Date('2013-05-25T00:00:00Z') })
      )
    ).does.not.equal(signatureOf(base))
    expect(
      signatureOf(presignGetUrl({ ...AWS_EXAMPLE, method: 'POST' }))
    ).does.not.equal(signatureOf(base))
  })
})

describe('read-only object source selection', function () {
  const key = 'videos/demo/video.mp4'
  const source: ReadOnlySpaceSource = {
    endpoint: 'https://source.example-ts.test',
    region: 'source-region',
    bucket: 'shared-library',
    accessKeyId: 'READONLYEXAMPLE',
    secretAccessKey: AWS_EXAMPLE.secretAccessKey,
    keys: [key, 'images/team/demo/hash-96.png']
  }
  const options = { ...AWS_EXAMPLE, key, readOnlySource: source }

  it('selects exact existing reads and preserves date, query and expiry', function () {
    const query = { response: 'image/png', value: 'a b' }
    expect(presignGetUrl({ ...options, query, expiresSec: 300 })).equals(
      presignGetUrl({
        ...source,
        key,
        query,
        expiresSec: 300,
        now: AWS_EXAMPLE.now
      })
    )
    expect(isReadOnlySourceKey(options, key)).equals(true)
    expect(new URL(presignGetUrl(options)).hostname).equals(
      'shared-library.source.example-ts.test'
    )
  })

  for (const method of ['PUT', 'POST', 'DELETE'] as const) {
    it(`keeps ${method} on the primary writer for a source-owned key`, function () {
      expect(presignGetUrl({ ...options, method })).equals(
        presignGetUrl({ ...AWS_EXAMPLE, key, method })
      )
    })
  }

  for (const other of ['videos/demo/new-still.jpg', key + '.extra', '']) {
    it(`keeps an unlisted or bucket-level read on the primary: ${other === '' ? 'listing' : other}`, function () {
      expect(presignGetUrl({ ...options, key: other })).equals(
        presignGetUrl({ ...AWS_EXAMPLE, key: other })
      )
    })
  }

  it('never selects a root listing even when an empty key is configured', function () {
    const query = { 'list-type': '2', prefix: 'videos/demo/' }
    expect(
      presignGetUrl({
        ...options,
        key: '',
        query,
        readOnlySource: { ...source, keys: [''] }
      })
    ).equals(presignGetUrl({ ...AWS_EXAMPLE, key: '', query }))
  })

  it('handles an empty list and absent source without changing old signatures', function () {
    expect(
      presignGetUrl({ ...options, readOnlySource: { ...source, keys: [] } })
    ).equals(presignGetUrl({ ...AWS_EXAMPLE, key }))
    expect(isReadOnlySourceKey({}, key)).equals(false)
  })

  it('uses the source path-style setting independently of the primary', function () {
    expect(presignGetUrl({ ...options, pathStyle: true })).equals(
      presignGetUrl({
        ...source,
        key,
        expiresSec: AWS_EXAMPLE.expiresSec,
        now: AWS_EXAMPLE.now
      })
    )
    expect(
      new URL(
        presignGetUrl({
          ...options,
          readOnlySource: { ...source, pathStyle: true }
        })
      ).pathname
    ).equals('/shared-library/videos/demo/video.mp4')
  })
})
