import { expect } from 'chai'
import { describe, it } from 'mocha'

import { BATTERY_KINDS, PITCH_CALLS, RESULT_TYPES } from './actions'
import {
  DICTATION_TERMS,
  DICTATION_VOCABULARY,
  VOCABULARY_ENTRIES
} from './vocabulary'

describe('dictation vocabulary', function () {
  it('keys the recogniser only on words it was measured to mishear', function () {
    for (const term of ['beaned', 'froze him', 'whiffed', 'dotted'])
      expect(DICTATION_TERMS).includes(term)
    for (const term of ['passed ball', 'backwards K', 'punched out'])
      expect(DICTATION_TERMS).not.includes(term)
    // Position numbers only in double-play chains; a lone number is a jersey.
    for (const term of [
      'six three',
      'four three',
      'five three',
      'three unassisted'
    ])
      expect(DICTATION_TERMS).not.includes(term)
    expect(DICTATION_TERMS).includes('six four three')
    expect(DICTATION_TERMS).to.have.length(43)
    for (const term of [
      'blooper',
      'dribbler',
      'warning track',
      'off the wall',
      'shallow',
      'fastball',
      'curveball',
      'slider',
      'changeup'
    ])
      expect(DICTATION_TERMS).includes(term)
    expect(new Set(DICTATION_TERMS.map(t => t.toLowerCase())).size).equals(
      DICTATION_TERMS.length
    )
    for (const term of DICTATION_TERMS) expect(term.length).within(1, 50)
  })

  it('promises the LLM only actions the library takes', function () {
    for (const entry of VOCABULARY_ENTRIES) {
      const action = entry.action
      if (action.type === 'pitch') expect(PITCH_CALLS).includes(action.call)
      else if (action.type === 'result')
        expect(RESULT_TYPES).includes(action.eventType)
      else expect(BATTERY_KINDS).includes(action.kind)
      expect(entry.phrases.length).greaterThan(0)
    }
  })

  it('has no walk result, and keeps result strikeout for the dropped third strike', function () {
    expect(DICTATION_VOCABULARY).not.match(/result walk\b/)
    const strikeouts = VOCABULARY_ENTRIES.filter(
      entry =>
        entry.action.type === 'result' && entry.action.eventType === 'strikeout'
    )
    expect(strikeouts).to.have.length(1)
    expect(strikeouts[0].phrases).includes('dropped third strike')
    const walk = VOCABULARY_ENTRIES.find(e => e.phrases.includes('ball four'))
    expect(walk?.action).deep.equals({ type: 'pitch', call: 'B' })
    const called = VOCABULARY_ENTRIES.find(e => e.phrases.includes('rung up'))
    expect(called?.action).deep.equals({ type: 'pitch', call: 'C' })
  })

  it('renders every entry and the four rules into the prompt block', function () {
    expect(DICTATION_VOCABULARY).match(/^BASEBALL VOCABULARY/)
    for (const entry of VOCABULARY_ENTRIES)
      expect(DICTATION_VOCABULARY).includes(entry.phrases[0])
    expect(DICTATION_VOCABULARY).includes('→ pitch B')
    expect(DICTATION_VOCABULARY).includes('→ result hit_by_pitch')
    expect(DICTATION_VOCABULARY).includes('→ batteryEvent wild_pitch')
    expect(DICTATION_VOCABULARY).includes('(the ball that makes four')
    expect(DICTATION_VOCABULARY).includes('ONE action')
    expect(DICTATION_VOCABULARY).includes('never result strikeout')
    expect(DICTATION_VOCABULARY).includes('askScorer')
    expect(DICTATION_VOCABULARY).includes('chin music')
  })
})
