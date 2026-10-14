import { expect } from 'chai'
import { describe, it } from 'mocha'

import { orderedPins, pinPreview } from './chatPinsModel'
import { message } from './chatViews.test.helpers'

const pinnedAt = '2027-04-01T17:00:00.000Z'
describe('personal pin presentation', function () {
  it('sorts by newest personal pin time and stable ID without changing its input', function () {
    const pins = [
      { messageId: 'msg_b', pinnedAt },
      { messageId: 'msg_old', pinnedAt: '2027-03-01T17:00:00.000Z' },
      { messageId: 'msg_new', pinnedAt: '2027-05-01T17:00:00.000Z' },
      { messageId: 'msg_a', pinnedAt }
    ]
    expect(orderedPins(pins).map(pin => pin.messageId)).deep.equals([
      'msg_new',
      'msg_a',
      'msg_b',
      'msg_old'
    ])
    expect(pins[0].messageId).equals('msg_b')
    expect(
      orderedPins([
        { messageId: 'msg_a', pinnedAt: 'invalid' },
        { messageId: 'msg_a', pinnedAt: 'invalid' }
      ])
    ).length(2)
  })

  it('uses verified current sender/excerpt and never returns stale words for unavailable content', function () {
    const pin = { messageId: 'msg_1', pinnedAt }
    expect(
      pinPreview(pin, [
        message({ senderName: 'Trea Turner', body: 'Updated words' })
      ])
    ).deep.equals({ sender: 'Trea Turner', excerpt: 'Updated words' })
    expect(pinPreview(pin, [message({ mine: true })]).sender).equals('You')
    expect(pinPreview(pin, [message({ senderName: undefined })]).sender).equals(
      'Former member'
    )
    for (const status of ['locked', 'lost', 'invalid', 'removed'] as const) {
      const preview = pinPreview(pin, [
        message({ status, body: 'Never show this cached body' })
      ])
      expect(preview.sender).equals(undefined)
      expect(preview.excerpt).not.contains('Never show')
    }
    expect(pinPreview(pin, []).sender).equals(undefined)
    expect(pinPreview(pin, []).excerpt).contains('unavailable')
    expect(
      pinPreview(pin, [message({ body: 'a'.repeat(240) })]).excerpt
    ).length(201)
  })
})
