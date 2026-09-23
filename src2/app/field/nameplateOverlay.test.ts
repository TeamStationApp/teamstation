import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  anchorFrame,
  facesKey,
  nameplateColor,
  nameplateFaces,
  nameplateSpots,
  sameSpots
} from './nameplateOverlay'
import type { NameplatePlacement } from './playerPresentation'

const plate = (
  id: string,
  extra: Partial<NameplatePlacement> = {}
): NameplatePlacement => ({
  id,
  name: `Name ${id}`,
  number: '#7',
  team: 'defense',
  uniformSide: 'home',
  x: 10,
  y: 20,
  anchorX: 0.5,
  anchorY: 1,
  width: 60,
  height: 30,
  visible: true,
  ...extra
})

describe('the phone’s nameplates', function () {
  it('says what each plate says, in the browser’s colours', function () {
    expect(
      nameplateFaces([
        plate('SS'),
        plate('r1', { team: 'runner', number: '', uniformSide: 'away' })
      ])
    ).deep.equals([
      {
        id: 'SS',
        name: 'Name SS',
        number: '#7',
        color: nameplateColor({ team: 'defense', uniformSide: 'home' }),
        anchorX: 0.5,
        anchorY: 1
      },
      {
        id: 'r1',
        name: 'Name r1',
        number: '',
        color: 'rgba(16, 40, 72, 0.94)',
        anchorX: 0.5,
        anchorY: 1
      }
    ])
  })

  it('keys faces by what they draw, not by where they are', function () {
    const still = facesKey(nameplateFaces([plate('SS')]))
    expect(facesKey(nameplateFaces([plate('SS', { x: 99, y: 1 })]))).equals(
      still
    )
    expect(
      facesKey(nameplateFaces([plate('SS', { name: '⚾ Name SS' })]))
    ).not.equals(still)
  })

  it('moves each plate to its anchor, and hides one off the camera', function () {
    expect(
      nameplateSpots([plate('SS'), plate('LF', { x: 1, y: 2, visible: false })])
    ).deep.equals({
      SS: { x: 10, y: 20, visible: true },
      LF: { x: 1, y: 2, visible: false }
    })
  })

  it('tells a frame that moves no one from one that does', function () {
    const still = { SS: { x: 10, y: 20, visible: true } }
    expect(
      sameSpots(still, { SS: { x: 10.3, y: 19.8, visible: true } })
    ).equals(true)
    expect(sameSpots(still, { SS: { x: 10.6, y: 20, visible: true } })).equals(
      false
    )
    expect(sameSpots(still, { SS: { x: 10, y: 20, visible: false } })).equals(
      false
    )
    expect(sameSpots(still, { LF: { x: 10, y: 20, visible: true } })).equals(
      false
    )
    expect(sameSpots(still, {})).equals(false)
  })

  it('hangs a plate from its anchor as the browser’s translate does', function () {
    // Centred over the head.
    expect(anchorFrame(0.5, 1)).deep.include({
      left: -200,
      top: -200,
      alignItems: 'center',
      justifyContent: 'flex-end'
    })
    // Under a runner's feet.
    expect(anchorFrame(0.5, 0)).deep.include({
      top: 0,
      justifyContent: 'flex-start'
    })
    // First base grows right, third base left.
    expect(anchorFrame(0, 1)).deep.include({
      left: 0,
      alignItems: 'flex-start'
    })
    expect(anchorFrame(1, 1)).deep.include({
      left: -400,
      alignItems: 'flex-end'
    })
  })
})
