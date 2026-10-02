import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GumboPlay } from '../../common/gumboPlay'
import { withHalfOuts } from '../../common/scoring/linescore'
import { storedGumbo } from './eventWrite'

const play: GumboPlay = {
  about: { atBatIndex: 0 },
  result: { eventType: 'single', description: 'Robin singles to left' },
  playEvents: [{ type: 'pitch', description: 'Ball 1' }, 'odd', null],
  source: { system: 'acme', play: {} }
}

describe('what is stored of a posted play', function () {
  it('keeps no sentence an outside scorer wrote, in the result or a play event', function () {
    const stored = storedGumbo(play, 'external')
    expect(stored.result).deep.equals({ eventType: 'single' })
    expect(stored.playEvents).deep.equals([{ type: 'pitch' }, 'odd', null])
    expect(stored).not.to.have.property('source')
  })

  it('keeps the Gumbo descriptions of a play TeamStation wrote itself', function () {
    const stored = storedGumbo(play, 'teamstation')
    expect(stored.result).deep.equals(play.result)
    expect(stored.playEvents).deep.equals(play.playEvents)
    expect(stored).not.to.have.property('source')
  })
})

describe('the outs a half ended on', function () {
  const half = (playEvents: unknown[]): GumboPlay[] => [
    {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'single' },
      count: { outs: 1 },
      playEvents
    }
  ]

  it('reads an Inning Ended marker by its type', function () {
    const [last] = withHalfOuts(half([{ type: 'inning_ended', outs: 3 }]))
    expect(last.about.halfOuts).equals(3)
    const [counted] = withHalfOuts(
      half([{ type: 'Inning Ended', count: { outs: 2 } }])
    )
    expect(counted.about.halfOuts).equals(2)
  })

  it('never reads a sentence as a marker', function () {
    const [last] = withHalfOuts(
      half([{ description: 'Inning Ended', outs: 3 }])
    )
    // Falls back to the play's own count.
    expect(last.about.halfOuts).equals(1)
  })
})
