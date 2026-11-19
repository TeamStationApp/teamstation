import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type Cause,
  causeLine,
  equalLine,
  requiredLine,
  totalsLine
} from './capacity'

// The C++ engine computes every cause (native/scheduler/Capacity.cpp, its
// doctest cases, and engine.test.ts through the addon); these are the words.

describe('causeLine', () => {
  const cause = (changes: Partial<Cause>): Cause => ({
    seasonId: 'sea_demo',
    kind: 'regular',
    rule: 'fieldTime',
    requested: 8,
    size: '50/70',
    ...changes
  })
  const context = { teamNames: { tem_hawks: 'Demo Hawks' } }

  it('words each rule of a structured cause with today’s sentences', () => {
    expect(causeLine(cause({}), context)).equals(
      'not enough 50/70 field time to give every team 8 games'
    )
    expect(
      causeLine(
        cause({ rule: 'capacity', requested: 1, size: 'T-ball' }),
        context
      )
    ).equals('not enough T-ball field time to give every team 1 game')
    expect(
      causeLine(cause({ kind: 'exhibition', requested: 2 }), context)
    ).equals(
      'not enough 50/70 field time to give every team 2 exhibition games'
    )
    expect(
      causeLine(
        cause({ kind: 'required', rule: 'requiredUnplaced', requested: 1 }),
        context
      )
    ).equals('not enough 50/70 field time to place 1 game again')
    expect(causeLine(cause({ rule: 'weekParts' }), context)).equals(
      'this season’s weekday/weekend game maximums leave too few available games'
    )
    expect(causeLine(cause({ rule: 'doubleheaders' }), context)).equals(
      'teams may not play twice in a day'
    )
    expect(
      causeLine(
        cause({ rule: 'manager', teamId: 'tem_hawks', managerId: 'coach' }),
        context
      )
    ).equals(
      'Demo Hawks’s Manager/Head Coach is booked during otherwise available game times'
    )
    expect(
      causeLine(cause({ rule: 'teamOpenDates', teamId: 'tem_owls' }), context)
    ).equals('tem_owls’s existing games leave too few open dates')
    expect(causeLine(cause({ rule: 'teamOpenDates' }), context)).equals(
      '’s existing games leave too few open dates'
    )
  })
})

describe('unmet lines', () => {
  it('words equal and uneven totals, and the games left to place again', () => {
    expect(equalLine('regular', 11, 12)).equals(
      'every team gets 11 of the 12 requested regular-season games'
    )
    expect(
      totalsLine('exhibition', [{ name: 'Demo Hawks', total: 1 }], 1)
    ).equals('every team gets 1 of the 1 requested exhibition game')
    expect(totalsLine('regular', [], 4)).equals(
      'every team gets 0 of the 4 requested regular-season games'
    )
    expect(
      totalsLine(
        'regular',
        [
          { name: 'Demo Owls', total: 10 },
          { name: 'Demo Hawks', total: 9 },
          { name: 'Demo Bears', total: 10 },
          { name: 'Demo Foxes', total: 9 },
          { name: 'Demo Wolves', total: 10 }
        ],
        12
      )
    ).equals(
      'Demo Foxes gets 9 of 12 regular-season games; Demo Hawks gets 9 of 12; the others get 10 of 12'
    )
    // Every group alone: each is named, the fewest games first.
    expect(
      totalsLine(
        'regular',
        [
          { name: 'Demo Owls', total: 10 },
          { name: 'Demo Hawks', total: 9 }
        ],
        12
      )
    ).equals(
      'Demo Hawks gets 9 of 12 regular-season games; Demo Owls gets 10 of 12'
    )
    expect(requiredLine(1, 3)).equals(
      '1 of the 3 games to place again couldn’t be placed'
    )
    expect(requiredLine(1, 1)).equals(
      '1 of the 1 game to place again couldn’t be placed'
    )
  })
})
