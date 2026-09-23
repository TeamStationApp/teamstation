import { expect } from 'chai'
import { describe, it } from 'mocha'

import { fieldKey } from './fieldKeyboard'
import { createPlayers } from './fieldModel'
import type { FieldCanvasProps } from './fieldTypes'
describe('field keyboard policy', function () {
  it('uses allowed players for selection and placement, cancels previews and ignores blocked keys', function () {
    const calls: string[] = []
    const props: FieldCanvasProps = {
      players: createPlayers(),
      selected: 'R1',
      onSelect: id => {
        calls.push(id)
        props.selected = id
      },
      onPlayerPlacement: id => {
        calls.push(id)
      },
      onFieldPlacement: event => {
        expect(event.generation).equals(7)
      },
      view: 'home',
      zoom: 1,
      interaction: {
        generation: 7,
        selectableIds: ['P', 'C'],
        gestures: ['place']
      }
    }
    expect(fieldKey(props, ']')).equals(true)
    expect(calls.at(-1)).equals('C')
    fieldKey(props, '[')
    expect(calls.at(-1)).equals('P')
    for (const key of [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Enter',
      'Escape'
    ])
      expect(fieldKey(props, key)).equals(true)
    expect(fieldKey(props, 'x')).equals(false)
    props.interaction!.selectableIds = []
    expect(fieldKey(props, 'Enter')).equals(false)
    props.interaction!.gestures = []
    expect(fieldKey(props, 'Enter')).equals(false)
    props.interaction = undefined
    props.selectableIds = []
    expect(fieldKey(props, 'Enter')).equals(false)
  })
  it('edits and accepts a trajectory through the same callbacks', function () {
    let accepted = 0
    const props: FieldCanvasProps = {
      players: [],
      selected: '',
      onSelect: () => undefined,
      view: 'home',
      zoom: 1,
      interaction: {
        generation: 4,
        selectableIds: [],
        gestures: ['trajectory']
      },
      arc: { target: { x: 0, z: -50 }, angle: 45 },
      onArcChange: arc => {
        props.arc = arc
      },
      onTrajectoryAccepted: (angle, generation) => {
        expect(angle).equals(45)
        expect(generation).equals(4)
        accepted++
      }
    }
    expect(fieldKey(props, 'ArrowUp')).equals(true)
    expect(props.arc!.angle).equals(46)
    fieldKey(props, 'ArrowDown')
    fieldKey(props, 'Enter')
    expect(accepted).equals(1)
    expect(fieldKey(props, 'ArrowLeft')).equals(false)
  })
})
