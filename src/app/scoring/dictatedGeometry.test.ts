import { expect } from 'chai'
import { describe, it } from 'mocha'

import { createDevelopmentSession } from './developmentSession'
import {
  directionPoint,
  foulFielder,
  foulPoint,
  foulSide
} from './dictatedGeometry'
import { gameFixture } from './isUnscoredGame.test'

// The development game's hosts field 11 C, 12 1B, 14 SS, 15 3B, 16 LF, 17 CF, 18 RF.
function game(
  bats: 'L' | 'R' = 'R'
): ReturnType<typeof createDevelopmentSession> {
  const session = createDevelopmentSession(gameFixture, [], [])
  session.liveData.plays.currentPlay!.matchup.batSide.code = bats
  return session
}
/** Between the foul lines, which run at 45° either side of straight away. */
const isFair = (point: { x: number; z: number }): boolean =>
  point.z <= 0 && Math.abs(point.x) <= -point.z
const angle = (point: { x: number; z: number }): number =>
  Math.round((Math.atan2(point.x, -point.z) * 180) / Math.PI)

describe('where a dictated ball went', function () {
  it('puts each direction at its spray angle, as deep as the play', function () {
    const single = { type: 'result', eventType: 'single' } as const
    expect(
      (['left', 'left_center', 'center', 'right_center', 'right'] as const).map(
        direction => angle(directionPoint(direction, single, false))
      )
    ).deep.equals([-30, -15, 0, 15, 30])
    const depth = (point: { x: number; z: number }): number =>
      Math.round(Math.hypot(point.x, point.z))
    expect(depth(directionPoint('center', single, false))).equals(62)
    expect(
      depth(
        directionPoint('center', { type: 'result', eventType: 'double' }, false)
      )
    ).equals(95)
    expect(
      depth(
        directionPoint(
          'left',
          { type: 'result', eventType: 'field_out', outBy: 'catch' },
          false
        )
      )
    ).equals(72)
    expect(
      depth(
        directionPoint(
          'left',
          { type: 'result', eventType: 'field_out', outBy: 'throw' },
          true
        )
      )
    ).equals(35)
    expect(depth(directionPoint('right', undefined, false))).equals(60)
  })

  it('catches a foul in foul territory, away from the batter unless a fielder says otherwise', function () {
    expect(foulSide(game('R'))).equals(1)
    expect(foulSide(game('L'))).equals(-1)
    expect(foulSide(game('R'), 15)).equals(-1)
    expect(foulSide(game('L'), 18)).equals(1)
    // Straight away, like the center fielder, goes by the batter.
    expect(foulSide(game('L'), 17)).equals(-1)
    expect(foulFielder(game('R'))).equals(12)
    expect(foulFielder(game('L'))).equals(15)
    const first = foulPoint(game('R'))
    expect(isFair(first)).equals(false)
    expect(angle(first)).equals(55)
    expect(angle(foulPoint(game('R'), 16))).equals(-55)
    expect(
      Math.round(Math.hypot(...Object.values(foulPoint(game(), 16))))
    ).equals(70)
    // The catcher's is behind the plate.
    expect(foulPoint(game('R'), 11)).deep.equals({ x: 3, z: 5 })
  })
})
