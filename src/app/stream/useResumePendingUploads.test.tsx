import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TeamStationClient } from '../../common/api'
import { fakePhoneStreamModule } from './fakePhoneStreamModule'
import { makePhoneStream, type PhoneStream } from './phoneStreamClient'
import {
  type AppStateLike,
  useResumePendingUploads
} from './useResumePendingUploads'

let root: Root | undefined

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 10))
  })
}

/** An `AppState` a test turns by hand. */
function fakeAppState(): AppStateLike & {
  turn: (state: string) => Promise<void>
  listeners: () => number
} {
  const listeners = new Set<(state: string) => void>()
  return {
    addEventListener: (_type, listener) => {
      listeners.add(listener)
      return {
        remove: () => {
          listeners.delete(listener)
        }
      }
    },
    turn: async state => {
      for (const listener of listeners) listener(state)
      await flush()
    },
    listeners: () => listeners.size
  }
}

const client = (token: string | undefined): TeamStationClient =>
  ({
    baseUrl: 'https://teamstation.example.test/api/v1',
    token
  }) as unknown as TeamStationClient

async function mount(options: {
  client: TeamStationClient
  signedInAs: unknown
  phone: PhoneStream
  appState: AppStateLike
}): Promise<void> {
  function Probe(): null {
    useResumePendingUploads(
      options.client,
      options.signedInAs,
      options.phone,
      options.appState
    )
    return null
  }
  root = createRoot(document.createElement('div'))
  await act(async () => {
    root!.render(<Probe />)
  })
  await flush()
}

const resumed = (native: ReturnType<typeof fakePhoneStreamModule>): unknown[] =>
  native.calls
    .filter(call => call.name === 'resumePendingUploads')
    .map(call => call.args)

describe('resuming recording uploads', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('resumes once signed in at launch, and each time the app comes back', async function () {
    const native = fakePhoneStreamModule({
      capabilities: { supported: true, deviceModel: 'iPhone 13 Pro' },
      resumePendingUploads: 1
    })
    const appState = fakeAppState()
    await mount({
      client: client('token-0000'),
      signedInAs: 7,
      phone: makePhoneStream(native),
      appState
    })
    const args = ['https://teamstation.example.test/api/v1', 'token-0000']
    expect(resumed(native)).deep.equals([args])
    await appState.turn('background')
    expect(resumed(native)).deep.equals([args])
    await appState.turn('active')
    expect(resumed(native)).deep.equals([args, args])
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(appState.listeners()).equals(0)
  })

  it('does nothing signed out, without a token, or on a phone that cannot record', async function () {
    const native = fakePhoneStreamModule({
      capabilities: { supported: true, deviceModel: 'iPhone 13 Pro' }
    })
    const appState = fakeAppState()
    await mount({
      client: client('token-0000'),
      signedInAs: undefined,
      phone: makePhoneStream(native),
      appState
    })
    expect(appState.listeners()).equals(0)
    await act(async () => {
      root?.unmount()
    })
    await mount({
      client: client(undefined),
      signedInAs: 7,
      phone: makePhoneStream(native),
      appState
    })
    await appState.turn('active')
    expect(resumed(native)).deep.equals([])
    await act(async () => {
      root?.unmount()
    })

    const unsupported = fakePhoneStreamModule({
      capabilities: { supported: false, deviceModel: '' }
    })
    await mount({
      client: client('token-0000'),
      signedInAs: 7,
      phone: makePhoneStream(unsupported),
      appState
    })
    expect(resumed(unsupported)).deep.equals([])
    // A browser has no engine at all, and says nothing about it.
    await act(async () => {
      root?.unmount()
    })
    await mount({
      client: client('token-0000'),
      signedInAs: 7,
      phone: makePhoneStream(null),
      appState
    })
  })

  it('stays quiet when the engine refuses', async function () {
    const native = fakePhoneStreamModule({
      capabilities: { supported: true, deviceModel: 'iPhone 13 Pro' }
    })
    native.failures.resumePendingUploads = { code: 'badRequest' }
    await mount({
      client: client('token-0000'),
      signedInAs: 7,
      phone: makePhoneStream(native),
      appState: fakeAppState()
    })
    expect(resumed(native)).length(1)
  })
})
