import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { GameLiveStreams, TeamStationClient } from '../../common/api'
import { fakePhoneStreamModule, RECORDING } from './fakePhoneStreamModule'
import type { NativePhoneRecording } from './NativePhoneStream'
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

/** Whose cameras each game lists as the signed-in account's own. */
type Mine = Record<string, string[] | 'refused'>

const client = (
  token: string | undefined,
  mine: Mine = {}
): TeamStationClient & { listed: string[] } => {
  const listed: string[] = []
  return {
    baseUrl: 'https://teamstation.example.test/api/v1',
    token,
    listed,
    liveStreams: async (gameId: string): Promise<GameLiveStreams> => {
      listed.push(gameId)
      const ids = mine[gameId]
      if (ids == null || ids === 'refused') throw new Error('Not found')
      return {
        gameId,
        mine: ids.map(id => ({ id })),
        others: [],
        canAdd: 4,
        maxCameras: 4
      } as unknown as GameLiveStreams
    }
  } as unknown as TeamStationClient & { listed: string[] }
}

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
    .filter(call => call.name === 'uploadRecording')
    .map(call => call.args)

const API = 'https://teamstation.example.test/api/v1'
const GAME = 'gam_00000000000000000001'
const OTHER_GAME = 'gam_00000000000000000002'

/** A take on this phone whose upload was cut off. */
function cutOff(
  liveStreamId: string,
  patch: Partial<NativePhoneRecording> = {}
): NativePhoneRecording {
  return {
    ...RECORDING,
    liveStreamId,
    gameId: GAME,
    endedAt: RECORDING.startedAt + 60_000,
    uploadTitle: `${liveStreamId} upload`,
    ...patch
  }
}

const SUPPORTED = { supported: true, deviceModel: 'iPhone 13 Pro' }

describe('resuming recording uploads', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('resumes this account’s cut-off takes once signed in at launch, and each time the app comes back', async function () {
    const native = fakePhoneStreamModule({
      capabilities: SUPPORTED,
      recordings: [
        cutOff('liv_mine', { uploadId: 'dup_00000000000000000001' }),
        // Cut off while exporting: wanted by its title, with no id yet.
        cutOff('liv_exporting', { uploadTitle: 'Bullpen' }),
        cutOff('liv_running', { uploadRunning: true }),
        cutOff('liv_landed', { uploadedAt: 1_790_000_100_000 }),
        cutOff('liv_neverAsked', { uploadTitle: undefined })
      ]
    })
    const appState = fakeAppState()
    await mount({
      client: client('token-0000', {
        [GAME]: ['liv_mine', 'liv_exporting', 'liv_running', 'liv_landed']
      }),
      signedInAs: 7,
      phone: makePhoneStream(native),
      appState
    })
    const once = [
      ['liv_mine', API, 'token-0000', 'liv_mine upload'],
      ['liv_exporting', API, 'token-0000', 'Bullpen']
    ]
    expect(resumed(native)).deep.equals(once)
    await appState.turn('background')
    expect(resumed(native)).deep.equals(once)
    await appState.turn('active')
    expect(resumed(native)).deep.equals([...once, ...once])
    // Nothing goes through the engine's resume-everything call.
    expect(
      native.calls.filter(call => call.name === 'resumePendingUploads')
    ).deep.equals([])
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(appState.listeners()).equals(0)
  })

  it('leaves a take made under another account, or one whose account it cannot tell, for its maker', async function () {
    const native = fakePhoneStreamModule({
      capabilities: SUPPORTED,
      recordings: [
        cutOff('liv_mine'),
        // Somebody else signed in on this phone filmed it.
        cutOff('liv_theirs'),
        // A game this account may not film, or whose cameras cannot be read.
        cutOff('liv_elsewhere', { gameId: OTHER_GAME })
      ]
    })
    const signedIn = client('token-0000', {
      [GAME]: ['liv_mine'],
      [OTHER_GAME]: 'refused'
    })
    await mount({
      client: signedIn,
      signedInAs: 7,
      phone: makePhoneStream(native),
      appState: fakeAppState()
    })
    expect(resumed(native)).deep.equals([
      ['liv_mine', API, 'token-0000', 'liv_mine upload']
    ])
    expect([...signedIn.listed].sort()).deep.equals([GAME, OTHER_GAME])
  })

  it('resumes a take the server already opened even once its stream is revoked as uploaded', async function () {
    const native = fakePhoneStreamModule({
      capabilities: SUPPORTED,
      recordings: [
        // Cut off during processing; the server then finished it, so its
        // stream is revoked and the camera list leaves it out.
        cutOff('liv_uploaded', { uploadId: 'dup_00000000000000000001' }),
        // Never opened, and not this account's stream: still waits.
        cutOff('liv_theirs'),
        // Opened on a game whose cameras cannot be read.
        cutOff('liv_elsewhere', {
          gameId: OTHER_GAME,
          uploadId: 'dup_00000000000000000002'
        })
      ]
    })
    const signedIn = client('token-0000', {
      [GAME]: [],
      [OTHER_GAME]: 'refused'
    })
    await mount({
      client: signedIn,
      signedInAs: 7,
      phone: makePhoneStream(native),
      appState: fakeAppState()
    })
    expect(resumed(native)).deep.equals([
      ['liv_uploaded', API, 'token-0000', 'liv_uploaded upload'],
      ['liv_elsewhere', API, 'token-0000', 'liv_elsewhere upload']
    ])
    // Every take on the other game was opened, so its cameras are not asked.
    expect(signedIn.listed).deep.equals([GAME])
  })

  it('tells the server about a take whose report failed after its last part', async function () {
    // A slide to stop on a weak signal, then Close: the screen's report
    // failed, and no further part ends to say it again.
    const native = fakePhoneStreamModule({
      capabilities: SUPPORTED,
      recordings: [
        cutOff('liv_unreported', { uploadTitle: undefined }),
        cutOff('liv_reported', { uploadTitle: undefined }),
        cutOff('liv_theirs', { uploadTitle: undefined }),
        cutOff('liv_landed', {
          uploadTitle: undefined,
          uploadedAt: 1_790_000_100_000
        }),
        cutOff('liv_opened', {
          gameId: OTHER_GAME,
          uploadId: 'dup_00000000000000000001'
        })
      ]
    })
    const listed: string[] = []
    const reported: unknown[] = []
    const signedIn = {
      baseUrl: API,
      token: 'token-0000',
      liveStreams: async (gameId: string): Promise<GameLiveStreams> => {
        listed.push(gameId)
        return {
          gameId,
          mine: [
            { id: 'liv_unreported', localRecording: 'none' },
            { id: 'liv_reported', localRecording: 'recorded' },
            { id: 'liv_landed', localRecording: 'none' }
          ],
          others: [{ id: 'liv_theirs', localRecording: 'none' }],
          canAdd: 4,
          maxCameras: 4
        } as unknown as GameLiveStreams
      },
      updateLiveStream: async (
        gameId: string,
        streamId: string,
        change: unknown
      ): Promise<unknown> => {
        reported.push([gameId, streamId, change])
        return {}
      }
    } as unknown as TeamStationClient
    const appState = fakeAppState()
    await mount({
      client: signedIn,
      signedInAs: 7,
      phone: makePhoneStream(native),
      appState
    })
    const once = [[GAME, 'liv_unreported', { localRecording: 'recorded' }]]
    expect(reported).deep.equals(once)
    // A take whose upload the server opened is not asked about.
    expect(listed).deep.equals([GAME])
    await appState.turn('active')
    expect(reported).deep.equals([...once, ...once])
  })

  it('says nothing of the take still being filmed when the app comes back mid-take', async function () {
    // Control Center pulled down while recording: the take has not ended, so
    // its upload reminder would come before the phone has stopped filming.
    let filming = true
    const take = (): NativePhoneRecording =>
      cutOff('liv_filming', {
        uploadTitle: undefined,
        endedAt: filming ? undefined : RECORDING.startedAt + 60_000
      })
    const native = fakePhoneStreamModule({
      capabilities: SUPPORTED,
      recordings: [take()]
    })
    const listed: string[] = []
    const reported: unknown[] = []
    const signedIn = {
      baseUrl: API,
      token: 'token-0000',
      liveStreams: async (gameId: string): Promise<GameLiveStreams> => {
        listed.push(gameId)
        return {
          gameId,
          mine: [{ id: 'liv_filming', localRecording: 'none' }],
          others: [],
          canAdd: 4,
          maxCameras: 4
        } as unknown as GameLiveStreams
      },
      updateLiveStream: async (
        gameId: string,
        streamId: string,
        change: unknown
      ): Promise<unknown> => {
        reported.push([gameId, streamId, change])
        return {}
      }
    } as unknown as TeamStationClient
    const appState = fakeAppState()
    await mount({
      client: signedIn,
      signedInAs: 7,
      phone: makePhoneStream(native),
      appState
    })
    await appState.turn('active')
    expect(reported).deep.equals([])
    expect(listed).deep.equals([])
    // Once the take has ended, a failed report is said again.
    filming = false
    native.answers.recordings = [take()]
    await appState.turn('active')
    expect(reported).deep.equals([
      [GAME, 'liv_filming', { localRecording: 'recorded' }]
    ])
  })

  it('does nothing signed out, without a token, or on a phone that cannot record', async function () {
    const native = fakePhoneStreamModule({
      capabilities: SUPPORTED,
      recordings: [cutOff('liv_mine')]
    })
    const appState = fakeAppState()
    await mount({
      client: client('token-0000', { [GAME]: ['liv_mine'] }),
      signedInAs: undefined,
      phone: makePhoneStream(native),
      appState
    })
    expect(appState.listeners()).equals(0)
    await act(async () => {
      root?.unmount()
    })
    await mount({
      client: client(undefined, { [GAME]: ['liv_mine'] }),
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
      capabilities: { supported: false, deviceModel: '' },
      recordings: [cutOff('liv_mine')]
    })
    await mount({
      client: client('token-0000', { [GAME]: ['liv_mine'] }),
      signedInAs: 7,
      phone: makePhoneStream(unsupported),
      appState
    })
    expect(unsupported.calls.map(call => call.name)).deep.equals([
      'capabilities'
    ])
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
      capabilities: SUPPORTED,
      recordings: [cutOff('liv_mine')]
    })
    native.failures.uploadRecording = { code: 'badRequest' }
    await mount({
      client: client('token-0000', { [GAME]: ['liv_mine'] }),
      signedInAs: 7,
      phone: makePhoneStream(native),
      appState: fakeAppState()
    })
    expect(resumed(native)).length(1)
    const listing = fakePhoneStreamModule({ capabilities: SUPPORTED })
    listing.failures.recordings = { code: 'badRequest' }
    await act(async () => {
      root?.unmount()
    })
    await mount({
      client: client('token-0000'),
      signedInAs: 7,
      phone: makePhoneStream(listing),
      appState: fakeAppState()
    })
    expect(resumed(listing)).deep.equals([])
  })
})
