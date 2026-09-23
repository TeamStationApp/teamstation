import { expect } from 'chai'
import { describe, it } from 'mocha'

import { fieldKey as rawFieldKey } from './fieldKeyboard'
import { createPlayers } from './fieldModel'
import type { FieldCanvasProps } from './fieldTypes'
const projection = {
  project: () => ({ x: 420, y: 380 }),
  width: 1200,
  height: 900
}
const fieldKey = (props: FieldCanvasProps, key: string): boolean =>
  rawFieldKey(props, key, projection)
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
    expect(calls.at(-1)).equals('P')
    fieldKey(props, ']')
    expect(calls.at(-1)).equals('C')
    fieldKey(props, '[')
    expect(calls.at(-1)).equals('P')
    expect(fieldKey(props, 'Enter')).equals(false)
    expect(fieldKey(props, 'ArrowUp')).equals(false)
    fieldKey(props, ' ')
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
  it('requires an explicit runner grab and decision, cancels without a choice, and advances only one base', function () {
    const players = createPlayers()
    const runner = players[9]
    runner.runnerBase = 1
    const calls: unknown[] = []
    const props: FieldCanvasProps = {
      players,
      selected: '',
      onSelect: id => {
        props.selected = id
      },
      view: 'home',
      zoom: 1,
      interaction: {
        generation: 5,
        selectableIds: [runner.id],
        runnerIds: [runner.id],
        gestures: ['place']
      },
      onRunnerDrag: view => {
        if (view != null) {
          expect(view.safe.x).equals(336)
          expect(view.safe.y).equals(322)
          expect(view.keyboard).equals(true)
        }
      },
      onRunnerDrop: (...args) => {
        calls.push(args)
      }
    }
    expect(fieldKey(props, 'Enter')).equals(false)
    fieldKey(props, ' ')
    fieldKey(props, 'Enter')
    expect(calls).has.length(0)
    fieldKey(props, ' ')
    fieldKey(props, 's')
    fieldKey(props, 'Enter')
    expect(calls[0]).deep.equals([runner.id, 1, 'safe', 5])
    fieldKey(props, ' ')
    for (let i = 0; i < 15; i++) fieldKey(props, 'ArrowUp')
    fieldKey(props, 'ArrowDown')
    fieldKey(props, 'ArrowLeft')
    fieldKey(props, 'ArrowRight')
    fieldKey(props, 'o')
    fieldKey(props, 'Enter')
    expect(calls[1]).deep.equals([runner.id, 2, 'out', 5])
    fieldKey(props, ' ')
    fieldKey(props, 'ArrowUp')
    fieldKey(props, 'Escape')
    expect(calls).has.length(2)
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
