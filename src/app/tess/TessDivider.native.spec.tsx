import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import {
  type GestureResponderEvent,
  PanResponder,
  type PanResponderCallbacks,
  type PanResponderGestureState
} from 'react-native'

import {
  byTestId,
  render,
  rerender,
  settle,
  unmount
} from '../../test/tessTestKit'
import { TessDivider } from './TessDivider.native'

const create = PanResponder.create.bind(PanResponder)
afterEach(async () => {
  await unmount()
  PanResponder.create = create
})

/** What a PanResponder is told of a finger that has moved `dx`. */
const moved = (dx: number): PanResponderGestureState => {
  const gesture: Partial<PanResponderGestureState> = { dx, dy: 0 }
  return gesture as PanResponderGestureState
}
const touch: Partial<GestureResponderEvent> = {}

/** The props React holds for the divider's own view, past the web's DOM. */
function dividerProps(): Record<string, unknown> {
  const node = byTestId('Tess divider')! as unknown as Record<string, unknown>
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))!
  let fiber = node[key] as {
    memoizedProps?: Record<string, unknown>
    return?: unknown
  } | null
  while (fiber != null && fiber.memoizedProps?.onAccessibilityAction == null)
    fiber = fiber.return as typeof fiber
  return fiber!.memoizedProps!
}

describe("Tess's divider on a tablet", () => {
  it('drags with a finger once a frame, from the width it had, within its limits', async () => {
    let callbacks: PanResponderCallbacks | undefined
    PanResponder.create = config => {
      callbacks = config
      return create(config)
    }
    const resized: Array<[number, boolean]> = []
    const onResize = (width: number, done: boolean): void => {
      resized.push([width, done])
    }
    await render(<TessDivider width={400} max={720} onResize={onResize} />)
    const pan = callbacks!
    expect(
      pan.onStartShouldSetPanResponder!(
        touch as GestureResponderEvent,
        moved(0)
      )
    ).equals(true)
    expect(
      pan.onMoveShouldSetPanResponder!(touch as GestureResponderEvent, moved(0))
    ).equals(true)
    expect(
      pan.onPanResponderTerminationRequest!(
        touch as GestureResponderEvent,
        moved(0)
      )
    ).equals(false)
    pan.onPanResponderGrant!(touch as GestureResponderEvent, moved(0))
    pan.onPanResponderMove!(touch as GestureResponderEvent, moved(60))
    pan.onPanResponderMove!(touch as GestureResponderEvent, moved(120))
    await new Promise(resolve => setTimeout(resolve, 30))
    await settle()
    expect(resized).deep.equals([[520, false]])
    pan.onPanResponderRelease!(touch as GestureResponderEvent, moved(900))
    expect(resized.at(-1)).deep.equals([720, true])
    // The next drag starts from the width the column now has.
    await rerender(<TessDivider width={720} max={720} onResize={onResize} />)
    pan.onPanResponderGrant!(touch as GestureResponderEvent, moved(0))
    pan.onPanResponderMove!(touch as GestureResponderEvent, moved(-100))
    pan.onPanResponderTerminate!(touch as GestureResponderEvent, moved(-1000))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(resized.slice(2)).deep.equals([[320, true]])
  })

  it('is adjustable, called "Resize Tess", 16 points a swipe', async () => {
    const resized: Array<[number, boolean]> = []
    await render(
      <TessDivider
        width={400}
        max={720}
        onResize={(width, done) => resized.push([width, done])}
      />
    )
    const props = dividerProps()
    expect(props.accessibilityRole).equals('adjustable')
    expect(props.accessibilityLabel).equals('Resize Tess')
    expect(props.accessibilityValue).deep.equals({
      min: 320,
      max: 720,
      now: 400
    })
    const act = props.onAccessibilityAction as (event: {
      nativeEvent: { actionName: string }
    }) => void
    act({ nativeEvent: { actionName: 'increment' } })
    act({ nativeEvent: { actionName: 'decrement' } })
    expect(resized).deep.equals([
      [416, true],
      [384, true]
    ])
  })
})
