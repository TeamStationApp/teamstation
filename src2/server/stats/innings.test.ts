import { expect } from 'chai'
import { describe, it } from 'mocha'

import { chargeInnings, type InningPlay } from './innings'

const P1 = 'aaaaaaaa-1111-1111-1111-111111111111'
const P2 = 'aaaaaaaa-2222-2222-2222-222222222222'
const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = '33333333-3333-3333-3333-333333333333'

let order = 0
function play(
  name: string,
  finalText: string[],
  extra: Partial<InningPlay> = {}
): InningPlay {
  const first = /\$\{([0-9a-fA-F-]{8,})\}/.exec(finalText[0] ?? '')
  return {
    order: order++,
    inning: 1,
    half: 'top',
    name,
    finalText,
    duringText: [],
    scoredBy: [],
    batterId: first == null ? null : first[1],
    outsAfter: null,
    didOutsChange: false,
    moves: [],
    halfMoves: [],
    atThird: new Set<string>(),
    ...extra
  }
}

describe('charging an inning to a pitcher', function () {
  beforeEach(function () {
    order = 0
  })

  it('counts outs from the scoreboard, not from the sentence', function () {
    // Two fielder's choices worded the same way, one an out and one not. The
    // counter is what tells them apart, and reading the sentence instead
    // closed a real inning three outs early.
    const totals = chargeInnings(
      [
        play('Single', [`\${${A}} singles`], { outsAfter: 0 }),
        play("Fielder's Choice", [`\${${B}} grounds into fielder's choice`], {
          outsAfter: 0
        }),
        play("Fielder's Choice", [`\${${C}} grounds into fielder's choice`], {
          outsAfter: 1,
          didOutsChange: true
        })
      ],
      new Map([
        [0, P1],
        [1, P1],
        [2, P1]
      ])
    )
    expect(totals.get(P1)?.outs).equals(1)
  })

  it('does not charge an inning that simply ended', function () {
    // `Inning Ended` steps the counter straight to three. Nobody was retired.
    const totals = chargeInnings(
      [
        play('Strikeout', [`\${${A}} strikes out`], {
          outsAfter: 1,
          didOutsChange: true
        }),
        play('Inning Ended', ['Inning Ended'], {
          outsAfter: 3,
          didOutsChange: true
        })
      ],
      new Map([
        [0, P1],
        [1, P1]
      ])
    )
    expect(totals.get(P1)?.outs).equals(1)
  })

  it('charges a run to whoever put the runner on', function () {
    // The relief pitcher inherits a runner and does not inherit the run.
    const totals = chargeInnings(
      [
        play('Single', [`\${${A}} singles`], { outsAfter: 0 }),
        play('Single', [`\${${B}} singles`, `\${${A}} scores`], {
          outsAfter: 0,
          scoredBy: [A]
        })
      ],
      new Map([
        [0, P1],
        [1, P2]
      ])
    )
    expect(totals.get(P1)?.runs).equals(1)
    expect(totals.get(P2)?.runs ?? 0).equals(0)
  })

  it('does not earn a run that came home on an error', function () {
    const totals = chargeInnings(
      [
        play('Single', [`\${${A}} singles`], { outsAfter: 0 }),
        play(
          'Single',
          [`\${${B}} singles`, `\${${A}} scores on error by left fielder`],
          { outsAfter: 0, scoredBy: [A] }
        )
      ],
      new Map([
        [0, P1],
        [1, P1]
      ])
    )
    expect(totals.get(P1)?.runs).equals(1)
    expect(totals.get(P1)?.earned).equals(0)
  })

  // The heart of the rule: the out that was never made still ends the inning
  // for everything after it, however the later runs actually scored.
  it('stops earning once the inning would have been over', function () {
    const totals = chargeInnings(
      [
        play('Strikeout', [`\${${A}} strikes out`], {
          outsAfter: 1,
          didOutsChange: true
        }),
        play('Strikeout', [`\${${B}} strikes out`], {
          outsAfter: 2,
          didOutsChange: true
        }),
        play('Error', [`\${${C}} reaches on an error by shortstop`], {
          outsAfter: 2
        }),
        play('Home Run', [`\${${A}} homers`], {
          outsAfter: 2,
          scoredBy: [A, C]
        })
      ],
      new Map([
        [0, P1],
        [1, P1],
        [2, P1],
        [3, P1]
      ])
    )
    expect(totals.get(P1)?.runs).equals(2)
    expect(totals.get(P1)?.earned).equals(0)
  })

  it('earns a run that scored before the inning would have ended', function () {
    const totals = chargeInnings(
      [
        play('Single', [`\${${A}} singles`], { outsAfter: 0 }),
        play('Home Run', [`\${${B}} homers`, `\${${A}} scores`], {
          outsAfter: 0,
          scoredBy: [B, A]
        })
      ],
      new Map([
        [0, P1],
        [1, P1]
      ])
    )
    expect(totals.get(P1)?.earned).equals(2)
  })
})
