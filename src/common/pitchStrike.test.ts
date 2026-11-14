import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  isRecordedPitch,
  pitchCall,
  pitchStrike,
  strikeoutLooking
} from './pitchStrike'

describe('strikes thrown', function () {
  it('counts recorded called, swinging, foul and in-play strikes', function () {
    for (const code of [
      'C',
      'S',
      'K',
      'F',
      'R',
      'T',
      'L',
      'W',
      'M',
      'Q',
      'O',
      'X',
      'D',
      'E',
      'Y',
      'J',
      'Z'
    ])
      expect(pitchStrike({ call: { code } }), code).equals(1)
    expect(pitchStrike({ isInPlay: true })).equals(1)
    expect(pitchStrike({ code: 'F' })).equals(1)
    expect(pitchStrike({ call: { code: 'B' }, code: 'C' })).equals(0)
  })
  it('excludes balls and hit batters and preserves unavailable detail', function () {
    for (const code of ['B', '*B', 'I', 'P', 'V', 'H'])
      expect(pitchStrike({ code }), code).equals(0)
    for (const code of [undefined, 3, '?'])
      expect(pitchStrike({ code })).equals(null)
  })
})

describe('pitch classification fallbacks', function () {
  it('uses automatic calls and falls back to flags only for unknown codes', function () {
    for (const code of ['A', 'AC', 'AB'])
      expect(pitchStrike({ code })).equals(0)
    for (const code of ['VB', 'VC', 'VP', 'VS'])
      expect(pitchStrike({ code })).equals(0)
    expect(pitchStrike({ isStrike: true })).equals(1)
    expect(pitchStrike({ isBall: true })).equals(0)
    expect(pitchStrike({ code: '?', isStrike: true })).equals(1)
    expect(pitchStrike({ code: 'B', isStrike: true })).equals(0)
    expect(pitchStrike({ call: { code: 7 }, code: 'C' })).equals(1)
  })
  it('distinguishes looking, swinging and unknown strikeout detail', function () {
    expect(strikeoutLooking({ code: 'C' })).equals(1)
    for (const code of ['S', 'W', 'T', 'M', 'O', 'A', 'AC', 'AB'])
      expect(strikeoutLooking({ code }), code).equals(0)
    for (const code of ['K', 'B', 'H', '?', undefined])
      expect(strikeoutLooking({ code }), String(code)).equals(null)
    expect(strikeoutLooking({ isStrike: true })).equals(null)
    expect(
      strikeoutLooking({ code: 'S', description: 'Dropped Third Strike' })
    ).equals(null)
    expect(
      strikeoutLooking({
        call: { code: 'S', description: 'Dropped Third Strike' }
      })
    ).equals(null)
    expect(
      strikeoutLooking({ code: 'C', description: 'Dropped Third Strike' })
    ).equals(1)
  })
})

describe('recorded deliveries', function () {
  it('ignores known non-pitch calls but retains genuinely unknown deliveries', function () {
    for (const code of [
      'N',
      'PSO',
      '.',
      '1',
      '2',
      '3',
      '+1',
      '+2',
      '+3',
      'A',
      'AC',
      'AB',
      'VB',
      'VC',
      'VP',
      'VS'
    ]) {
      expect(isRecordedPitch({ code }), code).equals(false)
      expect(pitchCall({ code }), code).equals(null)
      expect(pitchStrike({ code }), code).equals(0)
    }
    for (const code of [undefined, '?']) {
      expect(isRecordedPitch({ code })).equals(true)
      expect(pitchStrike({ code })).equals(null)
    }
    expect(pitchCall({ isInPlay: true })).equals('inPlay')
    expect(pitchCall({ isBall: true })).equals('ball')
    expect(pitchCall({ isStrike: true })).equals('strike')
  })
})
