import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { GameLiveStreams, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { fakePhoneStreamModule, RECORDING } from './fakePhoneStreamModule'
import type { NativePhoneRecording } from './NativePhoneStream'
import { makePhoneStream, type PhoneStream } from './phoneStreamClient'
import {
  type AppStateLike,
  UNLISTED_REPORTED_KEY,
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
  mine: Mine = {},
  discarded: string[] = []
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
        discarded,
        canAdd: 4,
        maxCameras: 4
      } as unknown as GameLiveStreams
    },
    // Like the server: a stream not this account's is not found.
    updateLiveStream: async (gameId: string, id: string) => {
      const ids = mine[gameId]
      if (ids === 'refused' || !(ids ?? []).includes(id))
        throw new HttpError('notFound', 'Not found')
      return {}
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

const SUPPORTED = {
  supported: true,
  deviceModel: 'iPhone 13 Pro',
  canRecordLocally: true
}

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
    // A pending take's game is read too: its camera may have been deleted.
    expect([...signedIn.listed].sort()).deep.equals([GAME, OTHER_GAME])
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
    expect([...listed].sort()).deep.equals([GAME, OTHER_GAME])
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
      capabilities: {
        supported: false,
        deviceModel: '',
        canRecordLocally: false
      },
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

  it('deletes a take whose camera was deleted, and resumes the others', async function () {
    const native = fakePhoneStreamModule({
      capabilities: SUPPORTED,
      recordings: [
        cutOff('liv_gone', { uploadId: 'dup_00000000000000000001' }),
        cutOff('liv_goneUnopened', { uploadId: undefined }),
        cutOff('liv_mine', { uploadId: 'dup_00000000000000000002' })
      ]
    })
    await mount({
      client: client('token-0000', { [GAME]: ['liv_mine'] }, [
        'liv_gone',
        'liv_goneUnopened'
      ]),
      signedInAs: 7,
      phone: makePhoneStream(native),
      appState: fakeAppState()
    })
    expect(
      native.calls
        .filter(call => call.name === 'deleteRecording')
        .map(call => call.args)
    ).deep.equals([['liv_gone'], ['liv_goneUnopened']])
    // Each upload is stopped before its take goes, as Delete does.
    for (const id of ['liv_gone', 'liv_goneUnopened']) {
      const order = native.calls
        .filter(
          call =>
            (call.name === 'cancelUpload' || call.name === 'deleteRecording') &&
            call.args[0] === id
        )
        .map(call => call.name)
      expect(order, id).deep.equals(['cancelUpload', 'deleteRecording'])
    }
    expect(resumed(native)).deep.equals([
      ['liv_mine', API, 'token-0000', 'liv_mine upload']
    ])
  })

  it('resumes an opened take when the camera list cannot be read', async function () {
    const native = fakePhoneStreamModule({
      capabilities: SUPPORTED,
      recordings: [cutOff('liv_mine', { uploadId: 'dup_00000000000000000001' })]
    })
    await mount({
      client: client('token-0000', { [GAME]: 'refused' }),
      signedInAs: 7,
      phone: makePhoneStream(native),
      appState: fakeAppState()
    })
    expect(resumed(native)).length(1)
  })

  describe('what the phone keeps and sweeps by itself', function () {
    const DAY = 24 * 60 * 60 * 1000
    const SWEPT = 'lst_00000000000000000009'
    /**
     * A client whose list says each stream's `localRecording`, and that notes
     * what it is told. Like the server, it takes a report only of a stream of
     * this account's: one listed, or one removed and so left off the list.
     */
    const reporting = (
      mine: Array<{ id: string; localRecording: string }>,
      discarded: string[] = [],
      removed: string[] = [],
      others: string[] = []
    ): TeamStationClient & {
      told: Array<[string, Record<string, unknown>]>
      asked: string[]
      refuse: boolean
      unreadable: boolean
    } => {
      const fake = {
        baseUrl: API,
        token: 't',
        told: [] as Array<[string, Record<string, unknown>]>,
        asked: [] as string[],
        refuse: false,
        unreadable: false,
        liveStreams: async (gameId: string): Promise<GameLiveStreams> => {
          if (fake.unreadable) throw new Error('Not found')
          return {
            gameId,
            mine,
            others: others.map(id => ({ id, localRecording: 'none' })),
            discarded,
            canAdd: 4,
            maxCameras: 4
          } as unknown as GameLiveStreams
        },
        updateLiveStream: async (
          _gameId: string,
          id: string,
          change: Record<string, unknown>
        ) => {
          fake.asked.push(id)
          if (fake.refuse) throw new Error('No signal')
          if (!mine.some(stream => stream.id === id) && !removed.includes(id))
            throw new HttpError('notFound', 'Not found')
          fake.told.push([id, change])
        }
      }
      return fake as unknown as TeamStationClient & {
        told: Array<[string, Record<string, unknown>]>
        asked: string[]
        refuse: boolean
        unreadable: boolean
      }
    }
    const called = (
      native: ReturnType<typeof fakePhoneStreamModule>,
      name: string
    ): unknown[] =>
      native.calls.filter(call => call.name === name).map(call => call.args)
    const swept = (): ReturnType<typeof fakePhoneStreamModule> =>
      fakePhoneStreamModule({
        capabilities: SUPPORTED,
        recordings: [],
        sweptStreams: [{ liveStreamId: SWEPT, gameId: GAME }]
      })

    it('reports a swept take on a game whose panel never opened, once, and forgets it', async function () {
      const native = swept()
      const fake = reporting([{ id: SWEPT, localRecording: 'recorded' }])
      const appState = fakeAppState()
      await mount({
        client: fake,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState
      })
      expect(fake.told).deep.equals([[SWEPT, { localRecording: 'removed' }]])
      expect(called(native, 'forgetSwept')).deep.equals([[SWEPT]])
    })

    it('reports a swept take of a camera its owner removed, which the list leaves out', async function () {
      const native = swept()
      const fake = reporting([], [], [SWEPT])
      await mount({
        client: fake,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState: fakeAppState()
      })
      expect(fake.told).deep.equals([[SWEPT, { localRecording: 'removed' }]])
      expect(called(native, 'forgetSwept')).deep.equals([[SWEPT]])
    })

    it('keeps it through a failed report and tries again at the next launch', async function () {
      const native = swept()
      const fake = reporting([{ id: SWEPT, localRecording: 'recorded' }])
      fake.refuse = true
      const appState = fakeAppState()
      await mount({
        client: fake,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState
      })
      expect(fake.told).deep.equals([])
      expect(called(native, 'forgetSwept')).deep.equals([])

      fake.refuse = false
      await appState.turn('active')
      expect(fake.told).deep.equals([[SWEPT, { localRecording: 'removed' }]])
      expect(called(native, 'forgetSwept')).deep.equals([[SWEPT]])
    })

    it('keeps it signed out, while the list cannot be read, and for a stream of somebody else', async function () {
      const native = swept()
      await mount({
        client: reporting([{ id: SWEPT, localRecording: 'recorded' }]),
        signedInAs: undefined,
        phone: makePhoneStream(native),
        appState: fakeAppState()
      })
      expect(called(native, 'sweptStreams')).deep.equals([])
      await act(async () => {
        root?.unmount()
      })

      const unreadable = reporting([{ id: SWEPT, localRecording: 'recorded' }])
      unreadable.unreadable = true
      await mount({
        client: unreadable,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState: fakeAppState()
      })
      expect(unreadable.told).deep.equals([])
      await act(async () => {
        root?.unmount()
      })

      const elsewhere = reporting([])
      await mount({
        client: elsewhere,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState: fakeAppState()
      })
      expect(elsewhere.told).deep.equals([])
      expect(called(native, 'forgetSwept')).deep.equals([])
    })

    it('forgets with no report what there is no need to report', async function () {
      for (const [mine, discarded] of [
        // The list holds nothing to settle.
        [[{ id: SWEPT, localRecording: 'none' }], []],
        [[{ id: SWEPT, localRecording: 'uploaded' }], []],
        // Deleted, which settled it.
        [[], [SWEPT]]
      ] as Array<[Array<{ id: string; localRecording: string }>, string[]]>) {
        const native = swept()
        const fake = reporting(mine, discarded)
        await mount({
          client: fake,
          signedInAs: 'me',
          phone: makePhoneStream(native),
          appState: fakeAppState()
        })
        expect(fake.told).deep.equals([])
        expect(called(native, 'forgetSwept')).deep.equals([[SWEPT]])
        await act(async () => {
          root?.unmount()
        })
      }
    })

    it('reports nothing gone for a stream filmed on again since', async function () {
      const native = fakePhoneStreamModule({
        capabilities: SUPPORTED,
        recordings: [
          cutOff(SWEPT, { uploadTitle: undefined, endedAt: undefined })
        ],
        sweptStreams: [{ liveStreamId: SWEPT, gameId: GAME }]
      })
      const fake = reporting([{ id: SWEPT, localRecording: 'recorded' }])
      await mount({
        client: fake,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState: fakeAppState()
      })
      expect(fake.told).deep.equals([])
      expect(called(native, 'forgetSwept')).deep.equals([[SWEPT]])
    })

    it('still works through its other takes when the engine cannot say what it swept', async function () {
      const native = fakePhoneStreamModule({
        capabilities: SUPPORTED,
        recordings: [cutOff('liv_1', { uploadId: 'upl_1' })]
      })
      native.failures.sweptStreams = { code: 'notReady' }
      await mount({
        client: client('t', { [GAME]: ['liv_1'] }),
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState: fakeAppState()
      })
      expect(resumed(native)).length(1)
    })

    it('reports the take of a camera removed after its report at the end of a part failed, until it lands', async function () {
      // Filmed with no signal, so the camera never published and the report
      // at the end of its part failed; its owner then removed it on the web.
      const REMOVED = 'lst_00000000000000000007'
      const native = fakePhoneStreamModule({
        capabilities: SUPPORTED,
        recordings: [cutOff(REMOVED, { uploadTitle: undefined })]
      })
      const fake = reporting([], [], [REMOVED])
      fake.unreadable = true
      const appState = fakeAppState()
      await mount({
        client: fake,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState
      })
      // Only from a list that was read.
      expect(fake.asked).deep.equals([])

      fake.unreadable = false
      fake.refuse = true
      await appState.turn('active')
      expect(fake.asked).deep.equals([REMOVED])
      expect(fake.told).deep.equals([])

      fake.refuse = false
      await appState.turn('active')
      const landed = [[REMOVED, { localRecording: 'recorded' }]]
      expect(fake.told).deep.equals(landed)
      // Landed: said no more, at a return to the front nor at a launch.
      await appState.turn('active')
      await act(async () => {
        root?.unmount()
      })
      await mount({
        client: fake,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState
      })
      expect(fake.asked).length(2)
      expect(fake.told).deep.equals(landed)
      expect(called(native, 'deleteRecording')).deep.equals([])

      // Once the take has gone from the phone, nothing of it is kept.
      native.answers.recordings = []
      await appState.turn('active')
      expect(localStorage.getItem(`${UNLISTED_REPORTED_KEY}me`)).equals('[]')
    })

    it('asks no more about another account’s take once the server refuses it, and leaves it for its maker', async function () {
      const THEIRS = 'lst_00000000000000000008'
      const native = fakePhoneStreamModule({
        capabilities: SUPPORTED,
        recordings: [
          cutOff(THEIRS, { uploadTitle: undefined }),
          // Listed as somebody else's camera: not asked about at all.
          cutOff('liv_listed', { uploadTitle: undefined }),
          // Deleted: there is nothing to remind anyone of.
          cutOff('liv_deleted', { uploadTitle: undefined })
        ]
      })
      const fake = reporting([], ['liv_deleted'], [], ['liv_listed'])
      const appState = fakeAppState()
      await mount({
        client: fake,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState
      })
      expect(fake.asked).deep.equals([THEIRS])
      await appState.turn('active')
      await act(async () => {
        root?.unmount()
      })
      await mount({
        client: fake,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState
      })
      expect(fake.asked).deep.equals([THEIRS])
      expect(fake.told).deep.equals([])
      await act(async () => {
        root?.unmount()
      })

      // Its maker, who removed it, is still asked for it.
      const maker = reporting([], [], [THEIRS])
      await mount({
        client: maker,
        signedInAs: 'maker',
        phone: makePhoneStream(native),
        appState: fakeAppState()
      })
      expect(maker.told).deep.equals([[THEIRS, { localRecording: 'recorded' }]])
      expect(called(native, 'deleteRecording')).deep.equals([])
    })

    it('reports again when what it kept cannot be read', async function () {
      const REMOVED = 'lst_00000000000000000007'
      for (const kept of ['not json', '{}']) {
        localStorage.setItem(`${UNLISTED_REPORTED_KEY}me`, kept)
        const native = fakePhoneStreamModule({
          capabilities: SUPPORTED,
          recordings: [cutOff(REMOVED, { uploadTitle: undefined })]
        })
        const fake = reporting([], [], [REMOVED])
        await mount({
          client: fake,
          signedInAs: 'me',
          phone: makePhoneStream(native),
          appState: fakeAppState()
        })
        expect(fake.told, kept).deep.equals([
          [REMOVED, { localRecording: 'recorded' }]
        ])
        await act(async () => {
          root?.unmount()
        })
      }
    })

    it('tells the server when a take from before the limit began its 30 days, and the phone once it landed', async function () {
      const from = Date.now() - 2 * DAY
      const native = fakePhoneStreamModule({
        capabilities: SUPPORTED,
        recordings: [
          cutOff('liv_old', {
            uploadTitle: undefined,
            retentionFrom: from
          }),
          // Already told, and one of somebody else.
          cutOff('liv_told', {
            uploadTitle: undefined,
            retentionFrom: from,
            retentionReported: true
          }),
          cutOff('liv_theirs', {
            uploadTitle: undefined,
            retentionFrom: from
          })
        ]
      })
      const fake = reporting([
        { id: 'liv_old', localRecording: 'recorded' },
        { id: 'liv_told', localRecording: 'recorded' }
      ])
      await mount({
        client: fake,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState: fakeAppState()
      })
      expect(fake.told).deep.equals([
        ['liv_old', { localCopyFrom: new Date(from).toISOString() }]
      ])
      expect(called(native, 'retentionReported')).deep.equals([
        ['liv_old', from]
      ])
    })

    it('says in one request that the phone holds a take the list does not know of', async function () {
      const from = Date.now() - 2 * DAY
      const native = fakePhoneStreamModule({
        capabilities: SUPPORTED,
        recordings: [
          cutOff('liv_old', { uploadTitle: undefined, retentionFrom: from })
        ]
      })
      const fake = reporting([{ id: 'liv_old', localRecording: 'none' }])
      await mount({
        client: fake,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState: fakeAppState()
      })
      expect(fake.told).deep.equals([
        [
          'liv_old',
          {
            localRecording: 'recorded',
            localCopyFrom: new Date(from).toISOString()
          }
        ]
      ])
    })

    it('leaves the phone counting until the server has heard', async function () {
      const native = fakePhoneStreamModule({
        capabilities: SUPPORTED,
        recordings: [
          cutOff('liv_old', {
            uploadTitle: undefined,
            retentionFrom: Date.now() - DAY
          })
        ]
      })
      const fake = reporting([{ id: 'liv_old', localRecording: 'recorded' }])
      fake.refuse = true
      await mount({
        client: fake,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState: fakeAppState()
      })
      expect(called(native, 'retentionReported')).deep.equals([])
    })

    it('starts the days again for a report too late for the warning, on both sides', async function () {
      const native = fakePhoneStreamModule({
        capabilities: SUPPORTED,
        recordings: [
          cutOff('liv_old', {
            uploadTitle: undefined,
            retentionFrom: Date.now() - 29 * DAY
          })
        ]
      })
      const fake = reporting([{ id: 'liv_old', localRecording: 'recorded' }])
      const before = Date.now()
      await mount({
        client: fake,
        signedInAs: 'me',
        phone: makePhoneStream(native),
        appState: fakeAppState()
      })
      const [[id, from]] = called(native, 'retentionReported') as Array<
        [string, number]
      >
      expect(id).equals('liv_old')
      expect(from).within(before - 26 * DAY, Date.now() - 26 * DAY)
      expect(fake.told).deep.equals([
        ['liv_old', { localCopyFrom: new Date(from).toISOString() }]
      ])
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
    const undeletable = fakePhoneStreamModule({
      capabilities: SUPPORTED,
      recordings: [cutOff('liv_gone')]
    })
    undeletable.failures.deleteRecording = { code: 'uploadInProgress' }
    await act(async () => {
      root?.unmount()
    })
    await mount({
      client: client('token-0000', { [GAME]: [] }, ['liv_gone']),
      signedInAs: 7,
      phone: makePhoneStream(undeletable),
      appState: fakeAppState()
    })
    expect(resumed(undeletable)).deep.equals([])
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
