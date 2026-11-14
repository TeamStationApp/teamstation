import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  DICTATION_LINE_MAX,
  parseDictationLine,
  printLines,
  sha256Hex
} from './dictationText'

describe('dictation text lines', function () {
  it('parses a state line, a reply, and a finish line', function () {
    const state = parseDictationLine(
      'dictation-state utt-1 model=claude-haiku-5-5 screen=scoring'
    )
    expect(state?.tag).equals('dictation-state')
    expect(state?.utterance).equals('utt-1')
    expect(state?.model).equals('claude-haiku-5-5')
    expect(state?.L).equals('info')
    expect(state?.I).equals(
      sha256Hex('dictation-state utt-1 model=claude-haiku-5-5 screen=scoring')
    )

    const reply = JSON.stringify({
      tag: 'dictation-reply',
      id: 'utt-1',
      model: 'claude-haiku-5-5',
      turn: { kind: 'ball' }
    })
    const parsed = parseDictationLine(reply)
    expect(parsed?.tag).equals('dictation-reply')
    expect(parsed?.utterance).equals('utt-1')
    expect(parsed?.model).equals('claude-haiku-5-5')
    expect(parsed?.L).equals('info')

    const finish = parseDictationLine(
      'dictation utt-1 model claude-haiku-5-5 user usr_scorer saved after 12ms'
    )
    expect(finish?.tag).equals('dictation-outcome')
    expect(finish?.utterance).equals('utt-1')
    expect(finish?.model).equals('claude-haiku-5-5')
    expect(finish?.U).equals('usr_scorer')
    expect(finish?.L).equals('info')
    expect(
      parseDictationLine(
        'dictation utt-1 model claude-haiku-5-5 user 12345 error: no'
      )
    ).equals(null)
  })

  it('sets the level from the branch, not from words in the text', function () {
    expect(
      parseDictationLine(
        'dictation utt-1 model m user usr_scorer error: timed out after 3ms'
      )?.L
    ).equals('error')
    expect(
      parseDictationLine(
        'dictation utt-1 model m user usr_scorer recogniser failed: x after 3ms'
      )?.L
    ).equals('error')
    expect(
      parseDictationLine('dictation-state utt-1 Said: it failed to start: ok')
        ?.L
    ).equals('info')
    expect(
      parseDictationLine(
        JSON.stringify({ tag: 'dictation-prompt', content: ' error: x' })
      )?.L
    ).equals('info')
    const failed = parseDictationLine(
      JSON.stringify({ tag: 'dictation-reply', id: 'utt-2', error: 'boom' })
    )
    expect(failed?.L).equals('error')
    expect(failed?.model).equals(undefined)
  })

  it('parses each outcome line the route prints', function () {
    const asks = parseDictationLine('dictation utt-3 asks with 2 options')
    expect(asks?.tag).equals('dictation-outcome')
    expect(asks?.utterance).equals('utt-3')
    expect(asks?.L).equals('info')

    const denied = parseDictationLine(
      'dictation utt-4 could not authorise: Error: no scope'
    )
    expect(denied?.utterance).equals('utt-4')
    expect(denied?.L).equals('error')

    const failed = parseDictationLine(
      'dictation utt-5 failed to start: Error: no recogniser'
    )
    expect(failed?.utterance).equals('utt-5')
    expect(failed?.L).equals('error')

    const socket = parseDictationLine(
      'dictation socket for user usr_scorer: read ECONNRESET'
    )
    expect(socket?.tag).equals('dictation-outcome')
    expect(socket?.U).equals('usr_scorer')
    expect(socket?.utterance).equals(undefined)
    expect(socket?.L).equals('error')
    expect(
      parseDictationLine('dictation socket for user 12345: read ECONNRESET')
    ).equals(null)
  })

  it('rejects a line that is not a dictation document', function () {
    expect(parseDictationLine('')).equals(null)
    expect(parseDictationLine('dictation-state ')).equals(null)
    expect(parseDictationLine('dictation-state utt-1\nsecond')).equals(null)
    expect(parseDictationLine('{"tag":')).equals(null)
    expect(parseDictationLine('[1]')).equals(null)
    expect(parseDictationLine('{"tag":"request_completed"}')).equals(null)
    expect(parseDictationLine('request_completed GET /')).equals(null)
    expect(
      parseDictationLine(`dictation-state utt-1 ${'x'.repeat(16_000)}`)
    ).equals(null)
  })

  it('splits a printed line past 16,000 characters into part lines', function () {
    const content = 'x'.repeat(12_000)
    const calls = 'y'.repeat(8_000)
    const message = JSON.stringify({
      tag: 'dictation-prompt',
      id: 'utt-9',
      model: 'claude-haiku-5-5',
      content,
      toolCalls: [{ name: 'act', arguments: calls }]
    })
    expect(message.length).greaterThan(DICTATION_LINE_MAX)
    const printed = printLines(message)
    expect(printed.length).greaterThan(1)
    const ids = new Set<string>()
    let rebuilt = ''
    printed.forEach((line, index) => {
      expect(line.length).at.most(DICTATION_LINE_MAX)
      const doc = parseDictationLine(line)
      expect(doc?.tag).equals('dictation-prompt')
      expect(doc?.utterance).equals('utt-9')
      expect(doc?.model).equals('claude-haiku-5-5')
      expect(doc?.L).equals('info')
      expect(doc?.part).equals(index)
      expect(doc?.parts).equals(printed.length)
      expect(doc?.I).equals(sha256Hex(`${sha256Hex(message)}/${index}`))
      expect(doc?.M).equals(line)
      ids.add(doc?.I ?? '')
      rebuilt += line.split(' ').slice(8).join(' ')
    })
    expect(ids.size).equals(printed.length)
    expect(rebuilt).equals(message)

    const short = 'dictation-state utt-1 Said: Ball.'
    expect(printLines(short)).deep.equals([short])
    expect(printLines('x'.repeat(16_001))).deep.equals(['x'.repeat(16_001)])
  })

  it('splits a long outcome line with its tag, model, and user', function () {
    const message = `dictation utt-1 model claude-haiku-5-5 user usr_scorer error: ${'e'.repeat(16_000)} after 3ms`
    const printed = printLines(message)
    expect(printed.length).equals(2)
    for (const line of printed) {
      const doc = parseDictationLine(line)
      expect(doc?.tag).equals('dictation-outcome')
      expect(doc?.utterance).equals('utt-1')
      expect(doc?.model).equals('claude-haiku-5-5')
      expect(doc?.U).equals('usr_scorer')
      expect(doc?.L).equals('error')
    }
    const stranger = message.replace('usr_scorer', '12345')
    expect(printLines(stranger)).deep.equals([stranger])
  })

  it('keeps an awkward utterance id intact in a part header', function () {
    const id = 'utt one'
    const message = JSON.stringify({
      tag: 'dictation-reply',
      id,
      text: 'z'.repeat(16_100)
    })
    expect(parseDictationLine(printLines(message)[1])?.utterance).equals(id)

    const dash = JSON.stringify({
      tag: 'dictation-reply',
      id: '-',
      text: 'z'.repeat(16_100)
    })
    expect(parseDictationLine(printLines(dash)[0])?.utterance).equals('-')

    const huge = JSON.stringify({
      tag: 'dictation-reply',
      id: 'i'.repeat(16_000),
      text: 'z'
    })
    const parts = printLines(huge)
    expect(parts.length).greaterThan(1)
    for (const line of parts)
      expect(parseDictationLine(line)?.utterance).equals('i'.repeat(128))
  })

  it('never cuts a part inside a surrogate pair', function () {
    // Two offsets, so one of them puts a naive cut between a pair's halves.
    const printed = ['', ' '].flatMap(pad =>
      printLines(`dictation-state utt-1 Said:${pad} ${'🙂'.repeat(9_000)}`)
    )
    expect(printed.length).greaterThan(2)
    for (const line of printed) {
      expect(line.length).at.most(DICTATION_LINE_MAX)
      expect(line).matches(
        /^[^\uD800-\uDFFF]*(?:[\uD800-\uDBFF][\uDC00-\uDFFF][^\uD800-\uDFFF]*)*$/
      )
      expect(parseDictationLine(line)?.tag).equals('dictation-state')
    }
  })

  it('rejects a malformed part line', function () {
    const hash = sha256Hex('x')
    const part = (head: string): string =>
      `dictation-part ${head} ${hash} info dictation-state utt-1 - - text`
    expect(parseDictationLine(part('0/2'))?.part).equals(0)
    expect(parseDictationLine(part('2/2'))).equals(null)
    expect(parseDictationLine(part('0/1'))).equals(null)
    expect(parseDictationLine(part('01/2'))).equals(null)
    expect(
      parseDictationLine(
        `dictation-part 0/2 ${hash} info dictation-unknown utt-1 - - text`
      )
    ).equals(null)
    expect(
      parseDictationLine(
        `dictation-part 0/2 ${hash} info dictation-state %E0 - - text`
      )
    ).equals(null)
    expect(
      parseDictationLine(
        `dictation-part 0/2 ${hash} info dictation-outcome utt-1 m 12345 text`
      )
    ).equals(null)
    expect(parseDictationLine('dictation-part 0/2 short')).equals(null)
  })
})
