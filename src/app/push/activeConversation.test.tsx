import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  activeConversation,
  type AppStates,
  clearOnRead,
  inForeground,
  useActiveConversation,
  watchForeground
} from './activeConversation'

/**
 * What a conversation on screen tells the platform (`activeConversation.ts`),
 * through a device and an `AppState` this test drives.
 */
let root: Root | undefined

/** A device recording what it was told and what it cleared. */
function device(): {
  told: Array<string | null>
  cleared: string[]
  setActiveConversation: (conversationId: string | null) => void
  clearConversation: (conversationId: string) => Promise<void>
} {
  const made = {
    told: [] as Array<string | null>,
    cleared: [] as string[],
    setActiveConversation: (conversationId: string | null) => {
      made.told.push(conversationId)
    },
    clearConversation: async (conversationId: string) => {
      made.cleared.push(conversationId)
    }
  }
  return made
}

/** An `AppState` starting in `state`, whose changes `become` sends. */
function states(state: string | null): AppStates & {
  become: (next: string) => Promise<void>
  listening: number
} {
  const listeners = new Set<(state: string) => void>()
  const made = {
    currentState: state,
    listening: 0,
    addEventListener: (_type: 'change', listener: (state: string) => void) => {
      listeners.add(listener)
      made.listening = listeners.size
      return {
        remove: () => {
          listeners.delete(listener)
          made.listening = listeners.size
        }
      }
    },
    become: async (next: string) => {
      made.currentState = next
      await act(async () => {
        for (const listener of [...listeners]) listener(next)
      })
    }
  }
  return made
}

function Pane(props: {
  conversationId: string
  active: boolean
  device: ReturnType<typeof device>
  states: AppStates
}): null {
  useActiveConversation(
    props.conversationId,
    props.active,
    props.device,
    props.states
  )
  return null
}

async function render(
  panes: Array<React.ComponentProps<typeof Pane>>
): Promise<void> {
  await act(async () => {
    root!.render(
      React.createElement(
        React.Fragment,
        null,
        ...panes.map(pane =>
          React.createElement(Pane, { ...pane, key: pane.conversationId })
        )
      )
    )
  })
}

describe('the conversation on screen', function () {
  beforeEach(function () {
    root = createRoot(document.createElement('div'))
  })

  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('is told while its pane is active and the app in the foreground, and cleared', async function () {
    const phone = device()
    const app = states('active')
    const pane = { conversationId: 'cnv_1', device: phone, states: app }
    await render([{ ...pane, active: true }])
    expect(phone.told).deep.equals(['cnv_1'])
    // Opened: what the device showed of it goes.
    expect(phone.cleared).deep.equals(['cnv_1'])
    expect(activeConversation()).equals('cnv_1')

    await app.become('background')
    expect(phone.told).deep.equals(['cnv_1', null])
    expect(activeConversation()).equals(null)
    await app.become('active')
    expect(phone.told).deep.equals(['cnv_1', null, 'cnv_1'])

    // A pane no longer active is no longer on screen, nor listened for.
    await render([{ ...pane, active: false }])
    expect(phone.told).deep.equals(['cnv_1', null, 'cnv_1', null])
    expect(app.listening).equals(0)
  })

  it('tells nothing for a pane in the background or not active', async function () {
    const phone = device()
    await render([
      {
        conversationId: 'cnv_1',
        active: true,
        device: phone,
        states: states('background')
      },
      {
        conversationId: 'cnv_2',
        active: false,
        device: phone,
        states: states('active')
      }
    ])
    // Neither is on screen, and neither had been.
    expect(phone.told).deep.equals([])
    expect(phone.cleared).deep.equals([])
    await render([])
    // A clear that fails on opening is let go; the platform is still told.
    const failing = {
      ...phone,
      clearConversation: async () => {
        throw new Error('No worker')
      }
    }
    await render([
      {
        conversationId: 'cnv_3',
        active: true,
        device: failing,
        states: states('active')
      }
    ])
    expect(phone.told).deep.equals(['cnv_3'])
  })

  it('keeps the pane made active last, whichever went first', async function () {
    const phone = device()
    const app = states('active')
    const first = {
      conversationId: 'cnv_1',
      active: true,
      device: phone,
      states: app
    }
    const second = { ...first, conversationId: 'cnv_2' }
    await render([first])
    await render([first, second])
    expect(activeConversation()).equals('cnv_2')
    // The first pane going leaves the second on screen.
    await render([second])
    expect(phone.told).deep.equals(['cnv_1', 'cnv_2'])
    expect(activeConversation()).equals('cnv_2')
    await render([])
    expect(phone.told).deep.equals(['cnv_1', 'cnv_2', null])
  })

  it('reads the app as in the foreground only while it is active', async function () {
    const app = states('active')
    const seen: boolean[] = []
    const stop = watchForeground(foreground => seen.push(foreground), app)
    expect(inForeground(app)).equals(true)
    // iOS's inactive (Notification Center, the app switcher, a call) covers
    // the screen: nothing arriving there is read.
    await app.become('inactive')
    expect(inForeground(app)).equals(false)
    await app.become('active')
    expect(inForeground(app)).equals(true)
    await app.become('background')
    expect(inForeground(app)).equals(false)
    expect(inForeground(states(null))).equals(false)
    stop()
    await app.become('active')
    expect(seen).deep.equals([false, true, false])
    expect(app.listening).equals(0)
    // React Native's own, as the app reads it.
    expect(inForeground()).equals(true)
    watchForeground(() => undefined)()
  })

  it('lets go of the conversation while iOS covers the app, as the reads do', async function () {
    const phone = device()
    const app = states('active')
    await render([
      { conversationId: 'cnv_1', active: true, device: phone, states: app }
    ])
    await app.become('inactive')
    expect(activeConversation()).equals(null)
    expect(inForeground(app)).equals(false)
    await app.become('active')
    expect(activeConversation()).equals('cnv_1')
    expect(inForeground(app)).equals(true)
    expect(phone.told).deep.equals(['cnv_1', null, 'cnv_1'])
  })

  it('clears a conversation after a read that moved the cursor, only', async function () {
    const phone = device()
    clearOnRead('cnv_1', phone)(true)
    clearOnRead('cnv_2', phone)(false)
    clearOnRead('cnv_3', phone)(undefined)
    await Promise.resolve()
    expect(phone.cleared).deep.equals(['cnv_1'])
    // A clear that fails is let go.
    clearOnRead('cnv_4', {
      ...phone,
      clearConversation: async () => {
        throw new Error('No worker')
      }
    })(true)
  })
})
