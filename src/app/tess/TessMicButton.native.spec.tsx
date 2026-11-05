import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { Platform } from 'react-native'

import { byTestId, render, unmount } from '../../test/tessTestKit'
import { TessMicButton } from './TessMicButton'
import type { TessMicrophone } from './useTessMicrophone'

const web = Platform.OS
beforeEach(() => {
  Platform.OS = 'ios'
})
afterEach(async () => {
  await unmount()
  Platform.OS = web
})

interface Fiber {
  memoizedProps?: Record<string, any>
  return?: Fiber | null
}

/** The props React holds for the button's `View`, past the DOM it draws. */
function buttonProps(): Record<string, any> {
  const node = byTestId('Tess mic')!
  const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'))!
  let fiber: Fiber | null | undefined = (
    node as unknown as Record<string, Fiber>
  )[key]
  while (fiber != null && fiber.memoizedProps?.onResponderGrant == null)
    fiber = fiber.return
  return fiber?.memoizedProps ?? {}
}

describe("Tess's microphone button on a phone", () => {
  it('hears one press and one release for a tap the phone reports both ways, late', async () => {
    const { calls } = await button()
    const props = buttonProps()
    const event = { nativeEvent: { pointerId: 1 }, currentTarget: {} }
    await act(async () => {
      // The pointer events come first and the responder's after the finger
      // is up: only the responder's count.
      props.onPointerDown?.(event)
      props.onPointerUp?.(event)
      expect(props.onStartShouldSetResponder()).equals(true)
      props.onResponderGrant(event)
      props.onResponderRelease(event)
    })
    expect(calls).deep.equals([
      ['press', undefined],
      ['lift', undefined]
    ])
  })

  it('hands on when each touch happened, by the touch, so a release handled late is still a tap', async () => {
    const { calls } = await button()
    const props = buttonProps()
    const at = (timestamp: unknown): object => ({
      nativeEvent: { timestamp },
      // When it was handled, which is not when it happened.
      timeStamp: 999999
    })
    await act(async () => {
      props.onResponderGrant(at(1000))
      props.onResponderRelease(at(1120))
      props.onResponderGrant(at(2000))
      props.onResponderTerminate(at(2050))
      // A time that is not a number is no time.
      props.onResponderGrant(at('soon'))
      props.onResponderRelease(at(Number.NaN))
    })
    expect(calls).deep.equals([
      ['press', 1000],
      ['lift', 1120],
      ['press', 2000],
      ['cancel', 2050],
      ['press', undefined],
      ['lift', undefined]
    ])
  })
})

/** The button over a microphone that records what it is told, and when. */
async function button(): Promise<{ calls: Array<[string, unknown]> }> {
  const calls: Array<[string, unknown]> = []
  const mic: TessMicrophone = {
    available: true,
    state: 'idle',
    message: null,
    press: at => calls.push(['press', at]),
    lift: at => calls.push(['lift', at]),
    cancel: at => calls.push(['cancel', at]),
    toggle: () => calls.push(['toggle', undefined]),
    levels: { subscribe: () => () => undefined }
  }
  await render(<TessMicButton mic={mic} />)
  return { calls }
}
