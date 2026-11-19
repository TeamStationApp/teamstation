import { expect } from 'chai'
import { describe, it } from 'mocha'

import { logEndpoint, logOrigin } from './dsn'

describe('a log DSN', function () {
  it('names the collector origin a page may post to', function () {
    expect(logOrigin('https://0123abcd@logs.example.test/102')).equals(
      'https://logs.example.test'
    )
    expect(logEndpoint('https://0123abcd@logs.example.test/102')).equals(
      'https://logs.example.test/ingest/102'
    )
  })

  it('names nothing for no DSN or one the logger refuses', function () {
    for (const dsn of [
      undefined,
      '',
      'nonsense',
      'http://0123abcd@logs.example.test/1',
      'https://0123abcd@logs.example.test/one'
    ])
      expect(logOrigin(dsn), String(dsn)).equals(undefined)
  })
})
