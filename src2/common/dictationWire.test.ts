import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asDictationAnswer,
  asDictationKeyterms,
  asDictationRelease,
  asDictationReply,
  asDictationStart,
  asDictationUp,
  asWireAction,
  MAX_ASK_OPTIONS
} from './api'

const start = {
  kind: 'start',
  id: 'u1',
  scope: 'scoring',
  target: { gameId: 'gam_1' },
  context: 'Top of the 1st, 0 outs, count 0-0.',
  model: 'grok-4.7'
}
const ball = { type: 'pitch', call: 'B' }

describe('dictation wire', function () {
  it('cleans a start, and refuses one with no context or an unknown model', function () {
    expect(asDictationStart(start)).deep.equals(start)
    expect(() => asDictationStart({ ...start, context: undefined })).throws()
    expect(() => asDictationStart({ ...start, context: '  ' })).throws()
    expect(() => asDictationStart({ ...start, model: 'gpt-5' })).throws()
    expect(() => asDictationStart({ ...start, target: 'gam_1' })).throws()
    expect(() => asDictationStart({ ...start, target: null })).throws()
    expect(() => asDictationStart({ ...start, kind: 'keyterms' })).throws()
    expect(asDictationStart({ ...start, model: 'grok-4.3' }).model).equals(
      'grok-4.3'
    )
  })

  it('cleans key terms, a release, an answer and a dismissal', function () {
    expect(
      asDictationKeyterms({ kind: 'keyterms', keyterms: ['Noah D.'] })
    ).deep.equals({ kind: 'keyterms', keyterms: ['Noah D.'] })
    expect(() =>
      asDictationKeyterms({ kind: 'keyterms', keyterms: 'x' })
    ).throws()
    expect(() => asDictationKeyterms({ kind: 'start' })).throws()
    expect(asDictationRelease({ kind: 'release', id: 'u1' })).deep.equals({
      kind: 'release',
      id: 'u1'
    })
    expect(() => asDictationRelease({ kind: 'release' })).throws()
    expect(() => asDictationRelease({ kind: 'start', id: 'u1' })).throws()
    expect(
      asDictationAnswer({ kind: 'answer', id: 'u1', option: 2 })
    ).deep.equals({ kind: 'answer', id: 'u1', option: 2 })
    expect(asDictationAnswer({ kind: 'dismiss', id: 'u1' })).deep.equals({
      kind: 'dismiss',
      id: 'u1'
    })
    expect(() =>
      asDictationAnswer({ kind: 'answer', id: 'u1', option: -1 })
    ).throws()
    expect(() =>
      asDictationAnswer({ kind: 'answer', id: 'u1', option: 1.5 })
    ).throws()
    expect(() => asDictationAnswer({ kind: 'other', id: 'u1' })).throws()
  })

  it('reads any control frame by its kind', function () {
    expect(asDictationUp(start).kind).equals('start')
    expect(asDictationUp({ kind: 'keyterms', keyterms: [] }).kind).equals(
      'keyterms'
    )
    expect(asDictationUp({ kind: 'release', id: 'u1' }).kind).equals('release')
    expect(asDictationUp({ kind: 'answer', id: 'u1', option: 0 }).kind).equals(
      'answer'
    )
    expect(asDictationUp({ kind: 'dismiss', id: 'u1' }).kind).equals('dismiss')
    expect(() => asDictationUp({ kind: 'nope' })).throws()
    expect(() => asDictationUp(null)).throws()
  })

  it('round-trips one reply of each kind', function () {
    const replies = [
      { kind: 'partial', id: 'u1', text: 'Noah sin' },
      { kind: 'transcript', id: 'u1', text: 'Noah singled.' },
      {
        kind: 'actions',
        id: 'u1',
        transcript: 'ball',
        actions: [ball],
        dropped: [{ code: 'malformed', message: 'pitch: bad' }]
      },
      {
        kind: 'ask',
        id: 'u1',
        question: 'Which Chase?',
        options: [{ label: 'Chase L.', actions: [ball] }, { label: 'Chase M.' }]
      },
      { kind: 'error', id: null, message: 'down' }
    ]
    for (const reply of replies)
      expect(asDictationReply(reply)).deep.equals(reply)
    expect(
      asDictationReply({
        kind: 'actions',
        id: 'u1',
        transcript: 'b',
        actions: []
      })
    ).deep.equals({
      kind: 'actions',
      id: 'u1',
      transcript: 'b',
      actions: [],
      dropped: []
    })
    expect(() => asDictationReply({ kind: 'result', id: 'u1' })).throws()
    expect(() => asDictationReply(undefined)).throws()
  })

  it('caps a question at five options and refuses one with none', function () {
    const options = Array.from({ length: 7 }, (_, i) => ({
      label: `option ${i}`
    }))
    const reply = asDictationReply({
      kind: 'ask',
      id: 'u1',
      question: 'Q?',
      options
    })
    expect(reply.kind === 'ask' && reply.options).to.have.length(
      MAX_ASK_OPTIONS
    )
    expect(() =>
      asDictationReply({ kind: 'ask', id: 'u1', question: 'Q?', options: [] })
    ).throws()
  })

  it('checks every action with the scoring library', function () {
    expect(asWireAction(ball)).deep.equals(ball)
    expect(() => asWireAction({ type: 'pitch', call: 'Z' })).throws(/pitch/)
    expect(() => asWireAction({ call: 'B' })).throws(/Unknown action/)
    expect(() =>
      asDictationReply({
        kind: 'actions',
        id: 'u1',
        transcript: 'x',
        actions: [{ type: 'walk' }]
      })
    ).throws()
  })
})
