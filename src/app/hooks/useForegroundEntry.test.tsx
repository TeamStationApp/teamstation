import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AppState, type AppStateStatus } from 'react-native'

import { useForegroundEntry } from './useForegroundEntry'
import { useForegroundRefresh } from './useForegroundRefresh'

/**
 * What runs at start, after a sign-in and on coming to the foreground (the
 * question for notifications, the permission Account shows), against
 * `useForegroundRefresh`'s thirty-second tick: `AppState` and the interval
 * are stand-ins this test drives.
 */
let root: Root | undefined
let listeners: Array<(state: AppStateStatus) => void> = []
let intervals: Array<() => void> = []
let restore: () => void = () => undefined

function setState(value: AppStateStatus): void {
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value
  })
}

async function become(value: AppStateStatus): Promise<void> {
  setState(value)
  await act(async () => {
    for (const listener of [...listeners]) listener(value)
  })
}

/** Every thirty-second interval, fired once. */
async function tick(): Promise<void> {
  await act(async () => {
    for (const run of [...intervals]) run()
  })
}

function Probe({
  action,
  refresh
}: {
  action: () => Promise<void>
  refresh?: () => Promise<void>
}): null {
  useForegroundEntry(action)
  useForegroundRefresh(refresh ?? noop)
  return null
}
const noop = async (): Promise<void> => undefined

async function show(
  action: () => Promise<void>,
  refresh?: () => Promise<void>
): Promise<void> {
  await act(async () => {
    root!.render(React.createElement(Probe, { action, refresh }))
  })
}

describe('useForegroundEntry', function () {
  beforeEach(() => {
    // Saved for restoration; never called unbound.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const add = AppState.addEventListener
    const state = Object.getOwnPropertyDescriptor(AppState, 'currentState')
    const setInterval = globalThis.setInterval
    const clearInterval = globalThis.clearInterval
    listeners = []
    intervals = []
    AppState.addEventListener = ((
      _kind: string,
      listener: (state: AppStateStatus) => void
    ) => {
      listeners.push(listener)
      return {
        remove: () => {
          listeners = listeners.filter(item => item !== listener)
        }
      }
    }) as typeof AppState.addEventListener
    globalThis.setInterval = ((run: () => void, ms?: number) => {
      if (ms !== 30000) return setInterval(run, ms)
      intervals.push(run)
      return run
    }) as unknown as typeof globalThis.setInterval
    globalThis.clearInterval = (id: unknown) => {
      intervals = intervals.filter(item => item !== id)
    }
    setState('active')
    restore = () => {
      AppState.addEventListener = add
      globalThis.setInterval = setInterval
      globalThis.clearInterval = clearInterval
      if (state != null) Object.defineProperty(AppState, 'currentState', state)
      else Reflect.deleteProperty(AppState, 'currentState')
    }
    root = createRoot(document.createElement('div'))
  })

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    restore()
  })

  it('runs at start and on coming to the foreground, never on the thirty-second tick', async () => {
    let asked = 0
    let refreshed = 0
    const action = async (): Promise<void> => {
      asked++
    }
    const refresh = async (): Promise<void> => {
      refreshed++
    }
    await show(action, refresh)
    expect(asked).equals(1)
    expect(refreshed).equals(1)
    // The tick reads what refreshes, and asks nothing.
    await tick()
    await tick()
    expect(refreshed).equals(3)
    expect(asked).equals(1)
    // A change that is not a return to the foreground asks nothing either.
    await become('active')
    expect(asked).equals(1)
    await become('inactive')
    await become('background')
    expect(asked).equals(1)
    await become('active')
    expect(asked).equals(2)
    await tick()
    expect(asked).equals(2)
  })

  it('runs again for a new action, as after a sign-in, and stops listening once gone', async () => {
    let first = 0
    let second = 0
    await show(async () => {
      first++
    })
    await show(async () => {
      second++
    })
    expect([first, second]).deep.equals([1, 1])
    await become('background')
    await become('active')
    expect([first, second]).deep.equals([1, 2])
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    await become('background')
    await become('active')
    expect([first, second]).deep.equals([1, 2])
    expect(listeners).deep.equals([])
  })

  it('a failing action is let go, and runs again next time', async () => {
    let runs = 0
    await show(async () => {
      runs++
      throw new Error('offline')
    })
    await become('background')
    await become('active')
    expect(runs).equals(2)
  })
})
