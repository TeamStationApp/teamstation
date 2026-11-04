import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asChatBoxCursor,
  chatHistorySegments,
  highestHistoryKey
} from './chatHistory'

describe('history segment and cursor contracts', () => {
  it('keeps full bigint precision and rejects noncanonical or out-of-range cursors', () => {
    for (const value of ['0', '1', '9007199254740993', '9223372036854775807'])
      expect(asChatBoxCursor(value)).equals(value)
    for (const value of [
      undefined,
      0,
      -1,
      '',
      '00',
      '01',
      '-1',
      '1.0',
      '1e3',
      ' 1',
      '9223372036854775808',
      '10000000000000000000'
    ])
      expect(() => asChatBoxCursor(value)).throws(TypeError)
  })
  const first = { epoch: 1, previousKeyBox: null, chainBreak: false }
  it('enumerates fixed closed ranges and retains the current segment', () => {
    expect(chatHistorySegments([])).deep.equals([])
    expect(chatHistorySegments([first])).deep.equals([
      { start: 1, end: 1, closed: false }
    ])
    expect(
      chatHistorySegments([
        first,
        { epoch: 2, previousKeyBox: 'box', chainBreak: false },
        { epoch: 3, previousKeyBox: null, chainBreak: true },
        { epoch: 4, previousKeyBox: null, chainBreak: true }
      ])
    ).deep.equals([
      { start: 1, end: 2, closed: true },
      { start: 3, end: 3, closed: true },
      { start: 4, end: 4, closed: false }
    ])
  })
  it('refuses gaps, invalid first epochs and inconsistent boundaries', () => {
    for (const rows of [
      [{ ...first, epoch: 2 }],
      [{ ...first, previousKeyBox: 'box' }],
      [{ ...first, chainBreak: true }],
      [first, { epoch: 3, previousKeyBox: 'box', chainBreak: false }],
      [first, { epoch: 2, previousKeyBox: null, chainBreak: false }],
      [first, { epoch: 2, previousKeyBox: 'box', chainBreak: true }]
    ])
      expect(() => chatHistorySegments(rows)).throws(TypeError)
  })
  it('shares the highest actual prefix, never an unavailable tip or another segment', () => {
    const segment = { start: 2, end: 4 }
    expect(highestHistoryKey(segment, [1, 5, NaN, 2.5])).equals(undefined)
    expect(highestHistoryKey(segment, [2])).equals(2)
    expect(highestHistoryKey(segment, [3, 2, 4, 5])).equals(4)
    expect(highestHistoryKey(segment, [2, 3], 3)).equals(undefined)
    expect(highestHistoryKey(segment, [2, 3, 4], 3)).equals(4)
  })
})
