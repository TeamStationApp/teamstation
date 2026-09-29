import { expect } from 'chai'
import { describe, it } from 'mocha'

import { fieldActivity } from './fieldActivity'
import type { FieldPlayer } from './fieldModel'

const player = (playerId: number | undefined, moving: boolean): FieldPlayer =>
  ({
    id: `p${String(playerId)}`,
    playerId,
    ...(moving
      ? {
          motion: {
            id: 'm',
            generation: 0,
            waypoints: [],
            index: 1,
            reported: false
          }
        }
      : {})
  }) as unknown as FieldPlayer

describe('what the field is showing', function () {
  it('names the picture, or none', function () {
    expect(fieldActivity(null, []).presentation).equals('none')
    expect(fieldActivity(undefined, []).presentation).equals('none')
    const flight = fieldActivity(
      { id: 'reel:1', kind: 'hit', stage: 'flight' },
      []
    )
    expect(flight.presentation).equals('hit:flight')
    expect(flight.id).equals('reel:1')
    expect(fieldActivity(null, []).id).equals('')
  })

  it('lists the players it is moving, in order, and no one held or still', function () {
    const players = [
      player(7, true),
      player(2, true),
      player(5, false),
      player(undefined, true)
    ]
    expect(fieldActivity(null, players).moving).equals('2,7')
    expect(fieldActivity(null, []).moving).equals('')
  })
})
