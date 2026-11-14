import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type AnnouncerLines, nextLines, NO_LINES } from './announcerLines'

/**
 * The area after the card says each line in turn, each for a step of its
 * own, with no rewind.
 */
function said(
  lines: string[],
  from: AnnouncerLines = NO_LINES
): AnnouncerLines {
  return lines.reduce(
    (area, line) =>
      nextLines(area, {
        line,
        step: `step ${area.next}`,
        notice: false,
        rewinds: area.rewinds
      }),
    from
  )
}
/** The card's line for `step`, with no rewind. */
const card = (
  line: string,
  step: string | null,
  rewinds = 0
): { line: string; step: string | null; notice: boolean; rewinds: number } => ({
  line,
  step,
  notice: false,
  rewinds
})

const texts = (area: AnnouncerLines): string[] =>
  area.entries.map(entry => entry.text)

describe('announcer lines', function () {
  it('appends each new sentence under a fresh key', function () {
    const area = said(['Play ball!', 'Ball one.', 'Strike one.'])
    expect(texts(area)).deep.equals(['Play ball!', 'Ball one.', 'Strike one.'])
    expect(area.entries.map(entry => entry.key)).deep.equals([0, 1, 2])
    expect(area.next).equals(3)
  })

  it('does not add a sentence drawn again for its step, and changes nothing', function () {
    const area = nextLines(NO_LINES, card('Ball one.', 'a'))
    expect(nextLines(area, card('Ball one.', 'a'))).equals(area)
  })

  it('adds the same sentence again for a new step: two fouls with two strikes', function () {
    const foul = 'Fouled off, still 0–2.'
    const first = nextLines(NO_LINES, card(foul, 'a'))
    const second = nextLines(first, card(foul, 'b'))
    expect(texts(second)).deep.equals([foul, foul])
    expect(second.entries.map(entry => entry.key)).deep.equals([0, 1])
    // The second drawn again adds nothing.
    expect(nextLines(second, card(foul, 'b'))).equals(second)
  })

  it('adds nothing for the step before said again while a step’s sentence is not in', function () {
    const area = nextLines(NO_LINES, card('Strike two.', 'a'))
    // The next step is shown before its own sentence: the card says the
    // one before again, for no step.
    const waiting = nextLines(area, card('Strike two.', null))
    expect(waiting).equals(area)
    // Its own sentence comes, the same words: a new line for a new step.
    const own = nextLines(waiting, card('Strike two.', 'b'))
    expect(texts(own)).deep.equals(['Strike two.', 'Strike two.'])
    // For no step, a new line is still added once.
    const ball = nextLines(own, card('Play ball!', null))
    expect(texts(ball).at(-1)).equals('Play ball!')
    expect(ball.step).equals('b')
    expect(nextLines(ball, card('Play ball!', null))).equals(ball)
  })

  it('ignores an empty line', function () {
    const area = said(['Ball one.'])
    expect(nextLines(area, card('', 'next'))).equals(area)
    expect(texts(said(['']))).deep.equals([])
  })

  it('replaces the newest sentence with the scorer’s correction of it', function () {
    const area = nextLines(
      said(['Ball one.', 'A double to left.']),
      card('Play changed by the scorer. A double to left.', 'step 1')
    )
    expect(texts(area)).deep.equals([
      'Ball one.',
      'Play changed by the scorer. A double to left.'
    ])
    expect(area.entries[1].key).equals(1)
    expect(area.next).equals(2)
  })

  it('adds a new step’s line that ends with the newest as a line of its own', function () {
    const area = said([
      'Ball one.',
      'A double to left.',
      'And again. A double to left.'
    ])
    expect(texts(area)).deep.equals([
      'Ball one.',
      'A double to left.',
      'And again. A double to left.'
    ])
    expect(area.entries.map(entry => entry.key)).deep.equals([0, 1, 2])
    expect(area.step).equals('step 2')
  })

  it('keeps the last six', function () {
    const area = said(['1', '2', '3', '4', '5', '6', '7', '8'])
    expect(texts(area)).deep.equals(['3', '4', '5', '6', '7', '8'])
    expect(area.entries.map(entry => entry.key)).deep.equals([2, 3, 4, 5, 6, 7])
  })

  it('starts afresh on a rewind', function () {
    const area = nextLines(
      said(['Ball one.', 'Strike one.']),
      card('Ball one.', 'step 0', 1)
    )
    expect(texts(area)).deep.equals(['Ball one.'])
    expect(area.rewinds).equals(1)
  })

  it('shows a rewind’s words alone, and drops them when they go', function () {
    const before = said(['Ball one.', 'Strike one.'])
    const notice = nextLines(before, {
      line: 'Rewind to top of 1st',
      step: null,
      notice: true,
      rewinds: 1
    })
    expect(texts(notice)).deep.equals(['Rewind to top of 1st'])
    expect(notice.notice).equals(true)
    // Held: the same words change nothing.
    expect(
      nextLines(notice, {
        line: 'Rewind to top of 1st',
        step: null,
        notice: true,
        rewinds: 1
      })
    ).equals(notice)
    // A second rewind's words replace the first's.
    const again = nextLines(notice, {
      line: 'Rewind to bottom of 1st',
      step: null,
      notice: true,
      rewinds: 2
    })
    expect(texts(again)).deep.equals(['Rewind to bottom of 1st'])
    const after = nextLines(again, card('Mookie B steps in.', 'step 0', 2))
    expect(texts(after)).deep.equals(['Mookie B steps in.'])
    expect(after.notice).equals(false)
    // Gone, with nothing yet to say: the area is empty.
    expect(texts(nextLines(again, card('', null, 2)))).deep.equals([])
  })
})
