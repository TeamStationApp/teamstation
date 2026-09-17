import { expect } from 'chai'
import { describe, it } from 'mocha'

import { presignGetUrl } from './presign'

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
      bucket: 'gamestation-media',
      key: 'videos/vid_abc/video.mp4'
    })
    expect(url).contains(
      'https://gamestation-media.sfo3.digitaloceanspaces.com/videos/vid_abc/video.mp4?'
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
  })
})
