import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { localFileId, sha256Hex, utf8 } from './localFileId'
import { normaliseSongText } from './songMatch'

interface Fixture {
  title: string
  artist: string
  durationMs: number
  normalisedTitle: string
  normalisedArtist: string
  id: string
}

/**
 * The TypeScript half of U24. `LocalFileIdTest.kt` reads the same file, so
 * the Android module and this module hash every case alike.
 */
const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(__dirname, 'localFileId.fixtures.json'), 'utf8')
)

describe('localFileId', function () {
  it('gives every shared fixture its id', function () {
    expect(fixtures.length).greaterThan(10)
    for (const fixture of fixtures) {
      expect(normaliseSongText(fixture.title), fixture.title).equals(
        fixture.normalisedTitle
      )
      expect(normaliseSongText(fixture.artist), fixture.artist).equals(
        fixture.normalisedArtist
      )
      expect(
        localFileId(fixture.title, fixture.artist, fixture.durationMs),
        fixture.title
      ).equals(fixture.id)
    }
  })

  it('is lf: and 16 hex digits of a real sha256', function () {
    const id = localFileId('TS Walkup Fixture', 'TeamStation Test', 90000)
    expect(id).match(/^lf:[0-9a-f]{16}$/)
    const expected = createHash('sha256')
      .update('ts walkup fixture\u0000teamstation test\u000090')
      .digest('hex')
      .slice(0, 16)
    expect(id).equals(`lf:${expected}`)
  })

  it('rounds half a second up, and a negative length to 0', function () {
    expect(localFileId('a', 'b', 1499)).equals(localFileId('a', 'b', 1000))
    expect(localFileId('a', 'b', 1500)).equals(localFileId('a', 'b', 2000))
    expect(localFileId('a', 'b', -5)).equals(localFileId('a', 'b', 0))
  })

  it('hashes as node does, across block boundaries and every UTF-8 width', function () {
    for (const text of [
      '',
      'abc',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
      'é紅🎸'.repeat(30)
    ]) {
      expect(sha256Hex(utf8(text))).equals(
        createHash('sha256').update(text).digest('hex')
      )
    }
  })
})
