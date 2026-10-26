import { expect } from 'chai'
import { describe, it } from 'mocha'

import { serverSentEvent, serverSentEvents } from './serverSentEvents'

describe('server-sent events', function () {
  it('reads an event: its name, its data lines joined, and its comments', function () {
    expect(
      serverSentEvent('event: step\ndata: {"a":\ndata:  1}\nid: 7\nretry: 10')
    ).deep.equals({ event: 'step', data: '{"a":\n 1}', comment: null })
    expect(serverSentEvent(': keep-alive')).deep.equals({
      event: 'message',
      data: null,
      comment: 'keep-alive'
    })
    expect(serverSentEvent('data:x\r\n: one\r\n:two')).deep.equals({
      event: 'message',
      data: 'x',
      comment: 'one\ntwo'
    })
  })

  it('reads the same events however the text is cut, and the last one left unended', function () {
    const text =
      ': keep-alive\n\nevent: text\ndata: {"delta":"Hi"}\n\r\n' +
      'event: done\r\ndata: {"messages":[]}\r\n\r\nevent: tail\ndata: 1'
    const whole = serverSentEvents()
    const expected = [...whole.push(text), ...whole.end()]
    expect(expected.map(event => event.event)).deep.equals([
      'message',
      'text',
      'done',
      'tail'
    ])
    for (let size = 1; size <= text.length; size += 1) {
      const reader = serverSentEvents()
      const events = []
      for (let at = 0; at < text.length; at += size)
        events.push(...reader.push(text.slice(at, at + size)))
      events.push(...reader.end())
      expect(events, `cut every ${size}`).deep.equals(expected)
    }
    // Nothing left but blank space: no event.
    const blank = serverSentEvents()
    expect(blank.push('data: 1\n\n  ')).has.length(1)
    expect(blank.end()).deep.equals([])
    expect(blank.end()).deep.equals([])
  })
})
