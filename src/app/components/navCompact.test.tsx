import { expect } from 'chai'

import { nextCompact } from './navCompact'

describe('scrolling the bottom tab bar', () => {
  const sample = (y: number): Parameters<typeof nextCompact>[1] => ({
    y,
    contentHeight: 1000,
    viewportHeight: 300
  })
  it('tracks continuous travel and resets on reversal', () => {
    let step = nextCompact(null, sample(51))
    step = nextCompact(step.position, sample(96))
    expect(step.compact).equals(false)
    step = nextCompact(step.position, sample(99))
    expect(step.compact).equals(true)
    step = nextCompact(step.position, sample(98))
    expect(step.compact).equals(undefined)
    step = nextCompact(step.position, sample(130))
    expect(step.position?.travel).equals(32)
    step = nextCompact(step.position, sample(106))
    expect(step.compact).equals(false)
  })
  it('ignores rubber-band travel and expands for short content', () => {
    const position = { y: 160, travel: 12 }
    expect(nextCompact(position, sample(-12)).position).equals(position)
    expect(nextCompact(position, sample(701)).position).equals(position)
    expect(
      nextCompact(position, { y: 0, contentHeight: 244, viewportHeight: 300 })
    ).deep.equals({ position: null, compact: false })
  })
})
