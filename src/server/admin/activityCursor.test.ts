import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import { decodeActivityCursor, encodeActivityCursor } from './activityCursor'

const refused = (text: string): string => {
  try {
    decodeActivityCursor(text)
  } catch (error) {
    expect(error).instanceOf(HttpError)
    return (error as Error).message
  }
  throw new Error(`${text} was taken`)
}
const encoded = (text: string): string =>
  Buffer.from(text).toString('base64url')

describe('activity cursors', function () {
  it('round-trips a time to the microsecond and an id', function () {
    const cursor = { at: '2026-11-01T12:00:00.123456Z', id: 'ses_abc-1' }
    expect(decodeActivityCursor(encodeActivityCursor(cursor))).deep.equals(
      cursor
    )
  })

  it('refuses anything a page did not answer', function () {
    const message = 'cursor is not one a page of this list answered'
    for (const text of [
      '',
      'not base64!',
      encoded('2026-11-01T12:00:00.123456Z'),
      encoded('2026-11-01T12:00:00.123Z|ses_1'),
      encoded('2026-13-45T99:00:00.123456Z|ses_1'),
      encoded('2026-02-30T12:00:00.000000Z|ses_1'),
      encoded('2026-11-01T24:00:00.000000Z|ses_1'),
      encoded('2026-11-01T12:00:00.123456Z|'),
      encoded('2026-11-01T12:00:00.123456Z|a b'),
      encoded(`2026-11-01T12:00:00.123456Z|${'x'.repeat(201)}`)
    ])
      expect(refused(text)).equals(message)
  })
})
