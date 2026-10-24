import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'
import { BackHandler } from 'react-native'

import { render, rerender, unmount } from '../../test/tessTestKit'
import { useTessBack } from './useTessBack.native'

const original = Object.getOwnPropertyDescriptor(
  BackHandler,
  'addEventListener'
)!
afterEach(async () => {
  await unmount()
  Object.defineProperty(BackHandler, 'addEventListener', original)
})

function Chat(props: { open: boolean; close: () => void }): null {
  useTessBack(props.open, props.close)
  return null
}

describe("Android's Back while Tess's chat is open", () => {
  it('closes the chat and is taken, and is let go once the chat closes', async () => {
    const listeners: Array<() => boolean | null | undefined> = []
    BackHandler.addEventListener = ((
      _event: 'hardwareBackPress',
      handler: () => boolean | null | undefined
    ) => {
      listeners.push(handler)
      return {
        remove: () => {
          listeners.splice(listeners.indexOf(handler), 1)
        }
      }
    }) as typeof BackHandler.addEventListener
    let closed = 0
    const close = (): void => {
      closed++
    }
    await render(<Chat open={false} close={close} />)
    expect(listeners).length(0)
    await rerender(<Chat open close={close} />)
    expect(listeners).length(1)
    expect(listeners[0]()).equals(true)
    expect(closed).equals(1)
    await rerender(<Chat open={false} close={close} />)
    expect(listeners).length(0)
  })
})
