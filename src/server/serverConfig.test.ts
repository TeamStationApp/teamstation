import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asServerConfig } from './serverConfigSchema'

const readOnlySource = {
  endpoint: 'https://shared.example-ts.test',
  region: 'example-region',
  bucket: 'shared',
  accessKeyId: 'READONLYEXAMPLE',
  secretAccessKey: 'EXAMPLE',
  keys: ['images/team/demo/hash-96.png', 'videos/demo/video.mp4']
}

describe('read-only source configuration', function () {
  it('retains legacy default and configured writer behavior without a source', function () {
    expect(asServerConfig({}).space.readOnlySource).equals(undefined)
    expect(asServerConfig({ space: { bucket: 'writer' } }).space.bucket).equals(
      'writer'
    )
  })
  it('keeps separate writer/source fields and validates exact object keys', function () {
    const result = asServerConfig({
      space: { bucket: 'writer', pathStyle: true, readOnlySource }
    }).space
    expect(result.bucket).equals('writer')
    expect(result.pathStyle).equals(true)
    expect(result.readOnlySource).deep.equals({
      ...readOnlySource,
      pathStyle: false
    })
    expect(
      asServerConfig({
        space: {
          readOnlySource: { ...readOnlySource, pathStyle: true, keys: [] }
        }
      }).space.readOnlySource?.pathStyle
    ).equals(true)
  })
  for (const invalid of [
    {},
    { ...readOnlySource, keys: 'all' },
    { ...readOnlySource, keys: [12] },
    { ...readOnlySource, pathStyle: 'yes' }
  ]) {
    it('rejects malformed source fields and key lists', function () {
      expect(() =>
        asServerConfig({ space: { readOnlySource: invalid } })
      ).throws()
    })
  }
})
