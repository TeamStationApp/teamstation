import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import type {
  CameraSourceOptions,
  DeviceStreamOptions,
  GameLiveStreams,
  LiveStream,
  StreamAccess,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import { TextField } from '../components/TextField'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  angleNameProblem,
  angleNameToSend,
  angleSuggestions
} from './AngleNamePrompt'
import { CameraAnglesPanel } from './CameraAnglesPanel.native'
import type { CameraLinks } from './cameraDeepLinks'
import {
  type FakePhoneStreamModule,
  fakePhoneStreamModule,
  RECORDING
} from './fakePhoneStreamModule'
import { makePhoneStream } from './phoneStreamClient'
import { StreamFooter } from './StreamFooter'
import { StreamFooter as NativeStreamFooter } from './StreamFooter.native'
import type { StreamingScreenProps } from './StreamingScreen.native'
import type { AppStateLike } from './useResumePendingUploads'

const DEVICE_ID = '00000000-0000-4000-8000-000000000001'

let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function stream(patch: Partial<LiveStream> = {}): LiveStream {
  return {
    id: 'liv_00000000000000000001',
    gameId: 'gam_1',
    userId: userIdOfGumbo(7),
    ownerName: 'Mookie Betts',
    slot: 1,
    label: 'Home Plate',
    keyPrefix: 'ts_0000',
    state: 'idle',
    opensAt: '2026-05-20T16:00:00.000Z',
    closesAt: null,
    videoId: null,
    lastError: null,
    status: null,
    deviceModel: 'iPhone 13 Pro',
    deviceId: DEVICE_ID,
    localRecording: 'none',
    url: 'rtmp://ingest.example.test:1936/live/ts_00000000000000000000',
    ...patch
  }
}

/** The calls the panel makes, answered as a test says. */
interface FakeClient {
  client: TeamStationClient
  added: Array<{
    gameId: string
    label?: string
    device?: DeviceStreamOptions | CameraSourceOptions
  }>
  revealed: string[]
  /** Every action on a camera, as `<call> <stream id>`. */
  acted: string[]
  /** How many times the game's cameras were read. */
  listed: number
  /** Whether this person films the game: the list answers `404` otherwise. */
  allowed: boolean
  /** What `streamAccess` answers, when not simply `allowed`. */
  access?: () => Promise<StreamAccess>
  /** Requests to film that were sent. */
  requests: unknown[]
  invite: () => Promise<unknown>
  mine: LiveStream[]
  others: LiveStream[]
  canAdd: number
  gameCanAdd: number
  maxGameCameras: number
  /** The ids the list says this person deleted. */
  discarded: string[]
  discard: () => Promise<void>
  /** What the last `updateLiveStream`s sent, as `<id> <localRecording>`. */
  patched: string[]
  patch: () => Promise<void>
  next: () => Promise<LiveStream>
  reveal: () => Promise<LiveStream>
  end: () => Promise<LiveStream>
}

function fakeClient(): FakeClient {
  const fake: FakeClient = {
    added: [],
    revealed: [],
    acted: [],
    listed: 0,
    allowed: true,
    requests: [],
    invite: async () => ({ id: 'req_1', status: 'pending' }),
    mine: [],
    others: [],
    canAdd: 4,
    gameCanAdd: 4,
    maxGameCameras: 4,
    discarded: [],
    discard: async () => {},
    patched: [],
    patch: async () => {},
    next: async () => stream(),
    reveal: async () => stream(),
    end: async () => stream(),
    client: undefined as unknown as TeamStationClient
  }
  const acting =
    (name: string) =>
    async (_gameId: string, id: string): Promise<LiveStream> => {
      fake.acted.push(`${name} ${id}`)
      if (name === 'end') await fake.end()
      return stream({ id })
    }
  fake.client = {
    baseUrl: 'https://teamstation.example.test/api/v1',
    token: 'token-0000',
    streamAccess: async (): Promise<StreamAccess> =>
      fake.access == null
        ? {
            canFilm: fake.allowed,
            canRequest: false,
            requested: false,
            teamId: 'tem_1'
          }
        : await fake.access(),
    inviteRelationship: async (request: unknown) => {
      fake.requests.push(request)
      return await fake.invite()
    },
    liveStreams: async (gameId: string): Promise<GameLiveStreams> => {
      fake.listed += 1
      if (!fake.allowed) throw new HttpError('notFound', 'Not found')
      return {
        gameId,
        mine: fake.mine,
        others: fake.others,
        canAdd: fake.canAdd,
        maxCameras: 4,
        gameCanAdd: fake.gameCanAdd,
        maxGameCameras: fake.maxGameCameras,
        discarded: fake.discarded
      }
    },
    discardLiveStream: async (gameId: string, id: string) => {
      fake.acted.push(`discard ${id}`)
      await fake.discard()
      fake.mine = fake.mine.filter(one => one.id !== id)
      fake.discarded = [...fake.discarded, id]
      return await fake.client.liveStreams(gameId)
    },
    updateLiveStream: async (
      _gameId: string,
      id: string,
      change: { localRecording?: string }
    ) => {
      fake.patched.push(`${id} ${String(change.localRecording)}`)
      await fake.patch()
      return stream({ id })
    },
    rotateLiveStream: acting('rotate'),
    endLiveStream: acting('end'),
    removeLiveStream: acting('remove'),
    revokeLiveStream: async (gameId: string, id: string) => {
      fake.acted.push(`revoke ${id}`)
      await fake.end()
      return { removed: true, streams: await fake.client.liveStreams(gameId) }
    },
    deleteVideo: async (videoId: string) => {
      fake.acted.push(`deleteVideo ${videoId}`)
      return { id: videoId, removedFromSpace: 0 }
    },
    addLiveStream: async (
      gameId: string,
      label?: string,
      device?: DeviceStreamOptions | CameraSourceOptions
    ) => {
      fake.added.push({ gameId, label, device })
      return await fake.next()
    },
    revealLiveStream: async (_gameId: string, streamId: string) => {
      fake.revealed.push(streamId)
      return await fake.reveal()
    }
  } as unknown as TeamStationClient
  return fake
}

/** What the panel opened, in place of the real camera. */
const opened: StreamingScreenProps[] = []
/** What the panel asked the player above it to play. */
const played: string[] = []
function FakeScreen(props: StreamingScreenProps): React.ReactElement {
  opened.push(props)
  return (
    <button type="button" data-testid="fake-screen" onClick={props.onClose}>
      {props.session.angleName}
    </button>
  )
}

/** Stands in for the system's links: no camera app is here, unless a test says. */
interface FakeLinks extends CameraLinks {
  installed: string[]
  /** Answers a link, or throws, as a test says. */
  answer: (url: string) => Promise<void>
  fired: string[]
}

function fakeLinks(installed: string[] = []): FakeLinks {
  const links: FakeLinks = {
    installed,
    fired: [],
    answer: async () => {},
    canOpenURL: async url => links.installed.includes(url),
    openURL: async url => {
      links.fired.push(url)
      await links.answer(url)
    },
    appInstalled: async () => false,
    openInApp: async url => {
      links.fired.push(url)
      await links.answer(url)
      return true
    }
  }
  return links
}

async function mount(
  fake: FakeClient,
  capabilities: unknown = {
    supported: true,
    deviceModel: 'iPhone 13 Pro',
    canRecordLocally: true
  },
  native: FakePhoneStreamModule = fakePhoneStreamModule({ capabilities }),
  copied: string[] = [],
  hasVideo = true,
  links: FakeLinks = fakeLinks(),
  appState?: AppStateLike,
  launchLimitMs?: number
): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <CameraAnglesPanel
          signedIn
          client={fake.client}
          gameId="gam_1"
          phone={makePhoneStream(native)}
          deviceId={async () => DEVICE_ID}
          Screen={FakeScreen as never}
          copy={text => copied.push(text)}
          links={links}
          hasVideo={hasVideo}
          onPlay={id => played.push(id)}
          appState={appState}
          launchLimitMs={launchLimitMs}
        />
      </ThemeProvider>
    )
    await delay(20)
  })
}

const text = (): string => document.body.textContent ?? ''

/**
 * A modal fades out before it goes, and jsdom runs no CSS animation: its end
 * is announced by hand.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (const node of document.body.querySelectorAll('div'))
      for (const name of ['animationend', 'webkitAnimationEnd'])
        node.dispatchEvent(new window.Event(name, { bubbles: true }))
    await delay(20)
  })
}

function button(words: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(node =>
    // A row's chevron is its ligature's name in a browser.
    (node.textContent ?? '').replace(/chevron_right$/, '').endsWith(words)
  )
  expect(found, words).not.equals(undefined)
  return found!
}

async function press(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click()
    await delay(20)
  })
}

async function type(value: string): Promise<void> {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Camera angle"]'
    )!
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await delay(10)
  })
}

/**
 * The props a React Native field was given, read off the rendered input's
 * fiber: the web renderer drops Android-only props such as
 * `disableFullscreenUI` from the DOM.
 */
function fieldProps(input: Element | null): Record<string, unknown> {
  const key = Object.keys(input ?? {}).find(name =>
    name.startsWith('__reactFiber$')
  )
  interface Fiber {
    memoizedProps?: Record<string, unknown>
    return?: Fiber
  }
  let fiber = (key == null ? undefined : (input as never)[key]) as
    Fiber | undefined
  while (fiber != null && fiber.memoizedProps?.onChangeText == null)
    fiber = fiber.return
  return fiber?.memoizedProps ?? {}
}

describe('Record Video on a phone', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    opened.length = 0
  })

  it('checks a camera angle’s name by the server’s rules', function () {
    expect(angleNameToSend('  Home Plate ')).equals('Home Plate')
    expect(angleNameToSend('   ')).equals(undefined)
    expect(angleNameProblem('')).equals(null)
    expect(angleNameProblem('x'.repeat(81))).equals(
      'A camera name can be at most 80 characters.'
    )
    expect(angleNameToSend('x'.repeat(81))).equals(undefined)
    expect(angleNameProblem('Home — Plate')).equals(
      'A camera name cannot contain " — ".'
    )
    expect(angleNameToSend('dugout')).equals('dugout')
  })

  it('fills the angle from a one-word suggestion and leaves other fields uncapitalized', async function () {
    const fake = fakeClient()
    await mount(fake)
    await press(button('Record Video'))
    await press(button('Home'))
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Camera angle"]'
      )?.value
    ).equals('Home')
    await press(button('Record with this phone'))
    expect(fake.added[0]?.label).equals('Home')

    await act(async () => {
      root?.unmount()
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <TextField label="Email" value="" onChangeText={() => undefined} />
        </ThemeProvider>
      )
      await delay(20)
    })
    expect(
      fieldProps(document.querySelector('input[aria-label="Email"]'))
        .autoCapitalize
    ).equals('none')
  })

  it('offers a phone that cannot record only the external camera, and is hidden from anybody who may not film', async function () {
    await mount(fakeClient(), {
      supported: false,
      deviceModel: '',
      canRecordLocally: false
    })
    await press(button('Record Video'))
    expect(text()).contains('Use external camera')
    expect(text()).not.contains('Record with this phone')
    await act(async () => {
      root?.unmount()
    })
    document.body.innerHTML = ''
    const refused = fakeClient()
    refused.allowed = false
    await mount(refused)
    expect(text()).equals('')
    expect(refused.listed).equals(0)
  })

  it('asks for a stream that keeps no recording on a phone under the start floor', async function () {
    const fake = fakeClient()
    await mount(fake, {
      supported: true,
      deviceModel: 'iPhone 13 Pro',
      canRecordLocally: false
    })
    await press(button('Record Video'))
    await type('Home Plate')
    await press(button('Record with this phone'))
    expect(fake.added[0].device).deep.equals({
      deviceId: DEVICE_ID,
      deviceModel: 'iPhone 13 Pro',
      recordsLocally: false
    })
  })

  it('asks for the angle’s name, shows a 409 inline, then opens the camera on its stream', async function () {
    const fake = fakeClient()
    await mount(fake)
    expect(text()).contains('CAMERAS')
    await press(button('Record Video'))
    expect(text()).contains('Name this camera angle')
    expect(
      document
        .querySelector('input[aria-label="Camera angle"]')
        ?.getAttribute('placeholder')
    ).equals('i.e., Home, 1st, 3rd, Backstop')
    expect(angleSuggestions()).deep.equals(['Home', '1st', '3rd', 'Backstop'])
    for (const label of angleSuggestions()) {
      expect(label.includes(' '), label).equals(false)
      expect(text()).contains(label)
    }
    expect(
      fieldProps(document.querySelector('input[aria-label="Camera angle"]'))
        .autoCapitalize
    ).equals('words')
    // Held sideways, an Android phone edits the name in place.
    expect(
      fieldProps(document.querySelector('input[aria-label="Camera angle"]'))
        .disableFullscreenUI
    ).equals(true)
    // Nothing to send yet: the rows wait.
    await press(button('Record with this phone'))
    expect(fake.added).deep.equals([])
    await type('Home — Plate')
    expect(text()).contains('A camera name cannot contain " — ".')
    await press(button('Record with this phone'))
    expect(fake.added).deep.equals([])

    fake.next = async () => {
      throw new HttpError(
        'conflict',
        'You already have a camera called Home Plate on this game'
      )
    }
    await type('Home Plate')
    await press(button('Record with this phone'))
    expect(text()).contains(
      'You already have a camera called Home Plate on this game'
    )
    expect(fake.added).deep.equals([
      {
        gameId: 'gam_1',
        label: 'Home Plate',
        device: {
          deviceId: DEVICE_ID,
          deviceModel: 'iPhone 13 Pro',
          recordsLocally: true
        }
      }
    ])
    // Typing again clears the refusal.
    await type('Home Plate ')
    expect(text()).not.contains('You already have a camera')

    fake.next = async () => stream({ label: 'Home Plate' })
    await press(button('Record with this phone'))
    await settle()
    expect(text()).not.contains('Name this camera angle')
    expect(opened.at(-1)).to.include({
      deviceId: DEVICE_ID,
      deviceModel: 'iPhone 13 Pro'
    })
    expect(opened.at(-1)?.session).deep.equals({
      gameId: 'gam_1',
      streamId: 'liv_00000000000000000001',
      url: 'rtmp://ingest.example.test:1936/live/ts_00000000000000000000',
      angleName: 'Home Plate',
      localRecording: 'none'
    })
    await press(
      document.querySelector<HTMLElement>('[data-testid="fake-screen"]')!
    )
    expect(document.querySelector('[data-testid="fake-screen"]')).equals(null)
  })

  it('asks for the URL again when the answer leaves it out, and says so when it cannot', async function () {
    const fake = fakeClient()
    fake.next = async () => stream({ url: undefined })
    fake.reveal = async () => stream({ url: undefined })
    await mount(fake)
    await press(button('Record Video'))
    await type('First Base')
    await press(button('Record with this phone'))
    expect(fake.revealed).deep.equals(['liv_00000000000000000001'])
    expect(text()).contains('Try again')
    fake.reveal = async () =>
      stream({ url: 'rtmp://ingest.example.test:1936/live/ts_revealed' })
    await press(button('Record with this phone'))
    expect(opened.at(-1)?.session.url).equals(
      'rtmp://ingest.example.test:1936/live/ts_revealed'
    )
  })

  it('opens empty again, and Cancel leaves without asking the server', async function () {
    const fake = fakeClient()
    await mount(fake)
    await press(button('Record Video'))
    await type('Left Field')
    await press(button('Cancel'))
    await settle()
    expect(text()).not.contains('Name this camera angle')
    await press(button('Record Video'))
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Camera angle"]'
      )?.value
    ).equals('')
    expect(fake.added).deep.equals([])
  })

  it('offers the camera panel in a browser and on a phone', async function () {
    const fake = fakeClient()
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <StreamFooter signedIn client={fake.client} gameId="gam_1" hasVideo />
        </ThemeProvider>
      )
      await delay(20)
    })
    expect(host.textContent).contains('Record Video')
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <NativeStreamFooter
            signedIn
            client={fake.client}
            gameId="gam_1"
            hasVideo={false}
          />
        </ThemeProvider>
      )
      await delay(20)
    })
    // With no video, the phone says so here.
    expect(host.textContent).contains('No videos')
  })
})

const OTHER_DEVICE = '00000000-0000-4000-8000-00000000000b'

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

/** The labels the open "…" sheet offers, in order. */
const sheetActions = (): string[] =>
  [
    ...document.querySelectorAll<HTMLElement>('[data-testid^="stream-action-"]')
  ].map(node =>
    node.getAttribute('data-testid')!.slice('stream-action-'.length)
  )

/** A take on this phone, as the engine lists it. */
function take(patch: Partial<typeof RECORDING> = {}): typeof RECORDING {
  return { ...RECORDING, gameId: 'gam_1', liveStreamId: 'liv_1', ...patch }
}

/** The panel's five-second poll, held so a test can run it when it likes. */
function heldPoll(): { poll: () => Promise<void>; restore: () => void } {
  const real = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const held = new Map<unknown, () => void>()
  globalThis.setInterval = ((callback: () => void, ms?: number) => {
    if (ms !== 5000) return real(callback, ms)
    const id = { poll: held.size + 1 }
    held.set(id, callback)
    return id
  }) as unknown as typeof setInterval
  globalThis.clearInterval = (id: unknown) => {
    if (held.delete(id)) return
    realClear(id as Parameters<typeof clearInterval>[0])
  }
  return {
    poll: async () => {
      await act(async () => {
        for (const callback of [...held.values()]) callback()
        await delay(20)
      })
    },
    restore: () => {
      globalThis.setInterval = real
      globalThis.clearInterval = realClear
    }
  }
}

describe('the cameras on a game, on a phone', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    opened.length = 0
  })

  it('says on an own idle row why the ingest refused its camera', async function () {
    const fake = fakeClient()
    const refused = 'TeamStation takes HEVC. This stream is H.264.'
    fake.mine = [
      stream({
        id: 'liv_1',
        label: 'Backstop',
        deviceId: null,
        source: 'rtmp',
        lastError: refused
      })
    ]
    await mount(fake)
    expect(byTestId('angle-row-liv_1')?.textContent).contains(refused)
  })

  it('lists every angle with its subtitle, state and duration, and reads them again every five seconds', async function () {
    const poll = heldPoll()
    try {
      const fake = fakeClient()
      fake.mine = [
        stream({
          id: 'liv_1',
          label: 'Home Plate',
          state: 'publishing',
          publishedAt: new Date(Date.now() - 3_900_000).toISOString()
        }),
        stream({
          id: 'liv_2',
          label: 'First Base',
          deviceModel: 'Pixel 10',
          deviceId: OTHER_DEVICE,
          localRecording: 'recorded',
          closesAt: '2026-05-20T17:00:00.000Z',
          durationSec: 125
        }),
        stream({
          id: 'liv_3',
          label: 'Bullpen',
          deviceModel: null,
          deviceId: null,
          source: 'mevo',
          state: 'ended'
        })
      ]
      fake.others = [
        stream({
          id: 'liv_4',
          label: 'Center Field',
          ownerName: 'Shohei O',
          deviceModel: 'iPad Pro',
          deviceId: undefined
        })
      ]
      await mount(fake)
      const subtitle = (id: string): string | null | undefined =>
        byTestId(`angle-subtitle-${id}`)?.textContent
      expect(subtitle('liv_1')).equals('Streaming with iPhone 13 Pro')
      expect(byTestId('angle-state-liv_1')?.textContent).equals('Live')
      expect(byTestId('angle-duration-liv_1')?.textContent).equals('1:05')
      expect(subtitle('liv_2')).equals('Streaming with Pixel 10')
      expect(byTestId('angle-row-liv_2')?.textContent).contains(
        'Recording on Pixel 10 not uploaded'
      )
      expect(byTestId('angle-state-liv_2')?.textContent).equals('Ended')
      expect(byTestId('angle-duration-liv_2')?.textContent).equals('0:02')
      expect(subtitle('liv_3')).equals('Using Mevo')
      expect(byTestId('angle-duration-liv_3')).equals(null)
      expect(subtitle('liv_4')).equals('Waiting for stream from Shohei O')
      expect(byTestId('angle-state-liv_4')?.textContent).equals('Idle')
      expect(text()).contains('Record Video')

      const before = fake.listed
      fake.mine = []
      fake.others = []
      await poll.poll()
      expect(fake.listed).equals(before + 1)
      expect(byTestId('angle-row-liv_1')).equals(null)
    } finally {
      poll.restore()
    }
  })

  it('opens the camera again from this phone’s own rows only', async function () {
    const fake = fakeClient()
    fake.mine = [
      stream({ id: 'liv_1', label: 'Home Plate' }),
      stream({ id: 'liv_2', label: 'First Base', deviceId: OTHER_DEVICE })
    ]
    fake.next = async () => stream({ id: 'liv_1', label: 'Home Plate' })
    await mount(fake)
    expect(byTestId('angle-row-liv_2')?.getAttribute('role')).not.equals(
      'button'
    )
    await press(byTestId('angle-row-liv_2')!)
    expect(fake.added).deep.equals([])

    await press(byTestId('angle-row-liv_1')!)
    expect(fake.added).deep.equals([
      {
        gameId: 'gam_1',
        label: 'Home Plate',
        device: {
          deviceId: DEVICE_ID,
          deviceModel: 'iPhone 13 Pro',
          recordsLocally: true,
          heldStreamId: 'liv_1'
        }
      }
    ])
    expect(opened.at(-1)?.session.streamId).equals('liv_1')
    const listed = fake.listed
    await press(byTestId('fake-screen')!)
    expect(byTestId('fake-screen')).equals(null)
    expect(fake.listed).equals(listed + 1)

    // A refusal is said under the list.
    fake.next = async () => {
      throw new HttpError('gone', 'This camera was ended')
    }
    await press(byTestId('angle-row-liv_1')!)
    expect(text()).contains('This camera was ended')
  })

  it('opens the row tapped by its stream, whatever name the list shows', async function () {
    // A camera whose stored name was cleared is listed by its slot's name,
    // which the server does not find it by: asked by that name alone, it made
    // a second stream, video and slot, and the phone filmed a different angle
    // from the row tapped.
    const fake = fakeClient()
    fake.mine = [stream({ id: 'liv_2', slot: 2, label: 'Camera 2' })]
    fake.next = async () => stream({ id: 'liv_2', slot: 2, label: 'Camera 2' })
    await mount(fake)
    await press(byTestId('angle-row-liv_2')!)
    expect(
      (fake.added.at(-1)?.device as DeviceStreamOptions).heldStreamId
    ).equals('liv_2')
    expect(opened.at(-1)?.session.streamId).equals('liv_2')
  })

  it('offers Rotate key and End on an own camera, End on somebody else’s, and nothing once ended', async function () {
    const fake = fakeClient()
    fake.mine = [
      stream({ id: 'liv_1', label: 'Home Plate' }),
      stream({ id: 'liv_2', label: 'Live One', state: 'publishing' }),
      stream({
        id: 'liv_3',
        label: 'Done One',
        state: 'ended',
        videoId: 'vid_3'
      })
    ]
    fake.others = [
      stream({ id: 'liv_4', label: 'Theirs', ownerName: 'Aaron Judge' }),
      stream({
        id: 'liv_5',
        label: 'Theirs Ended',
        ownerName: 'Aaron Judge',
        state: 'ended'
      })
    ]
    await mount(fake)
    const offered = async (id: string): Promise<string[]> => {
      await press(byTestId(`angle-more-${id}`)!)
      const found = sheetActions()
      await press(button('Cancel'))
      await settle()
      return found
    }
    expect(await offered('liv_1')).deep.equals(['rotate', 'end'])
    expect(await offered('liv_2')).deep.equals(['rotate', 'end'])
    expect(await offered('liv_4')).deep.equals(['end'])
    expect(byTestId('angle-more-liv_3')).equals(null)
    expect(byTestId('angle-more-liv_5')).equals(null)
  })

  it('acts at once off the air but asks twice on it, and for a camera filming elsewhere', async function () {
    const fake = fakeClient()
    fake.mine = [
      stream({ id: 'liv_1', label: 'Home Plate' }),
      stream({ id: 'liv_2', label: 'Live One', state: 'publishing' }),
      stream({ id: 'liv_3', label: 'Elsewhere', deviceId: OTHER_DEVICE })
    ]
    await mount(fake)

    await press(byTestId('angle-more-liv_1')!)
    await press(byTestId('stream-action-rotate')!)
    await settle()
    expect(fake.acted).deep.equals(['rotate liv_1'])

    await press(byTestId('angle-more-liv_2')!)
    await press(byTestId('stream-action-end')!)
    expect(fake.acted).deep.equals(['rotate liv_1'])
    expect(byTestId('stream-action-end')?.textContent).equals('Tap again: End')
    await press(byTestId('stream-action-end')!)
    await settle()
    expect(fake.acted).deep.equals(['rotate liv_1', 'end liv_2'])

    await press(byTestId('angle-more-liv_3')!)
    await press(byTestId('stream-action-end')!)
    expect(fake.acted).deep.equals(['rotate liv_1', 'end liv_2'])
    await press(byTestId('stream-action-end')!)
    await settle()
    expect(fake.acted.at(-1)).equals('end liv_3')

    // A failure stays in the sheet.
    fake.end = async () => {
      throw new HttpError('gone', 'This camera was ended')
    }
    await press(byTestId('angle-more-liv_1')!)
    await press(byTestId('stream-action-end')!)
    expect(text()).contains('This camera was ended')
  })

  it('offers Upload Recording, shows its progress, cancels, retries, and goes when it lands', async function () {
    const native = fakePhoneStreamModule({
      capabilities: {
        supported: true,
        deviceModel: 'iPhone 13 Pro',
        canRecordLocally: true
      },
      recordings: [take()],
      uploadRecording: new Promise(() => {}),
      cancelUpload: undefined
    })
    const fake = fakeClient()
    fake.mine = [stream({ id: 'liv_1', label: 'Home Plate' })]
    await mount(fake, undefined, native)
    expect(byTestId('upload-row-liv_1')?.textContent).equals(
      'Home PlateUpload RecordingProvide a higher-quality copy for future viewing.'
    )

    await press(byTestId('upload-recording-liv_1')!)
    expect(
      native.calls.filter(call => call.name === 'uploadRecording')
    ).deep.equals([
      {
        name: 'uploadRecording',
        args: [
          'liv_1',
          'https://teamstation.example.test/api/v1',
          'token-0000',
          'Home Plate'
        ]
      }
    ])
    expect(byTestId('upload-progress-liv_1')?.textContent).equals(
      'Preparing 0%'
    )
    const emit = async (
      state: string,
      fraction: number,
      message?: string
    ): Promise<void> => {
      await act(async () => {
        native.emitUpload({
          liveStreamId: 'liv_1',
          state,
          fraction,
          bytesSent: 0,
          bytesTotal: 0,
          message
        })
        await delay(20)
      })
    }
    await emit('uploading', 0.42)
    expect(byTestId('upload-progress-liv_1')?.textContent).equals(
      'Uploading 42%'
    )

    await press(byTestId('upload-cancel-liv_1')!)
    expect(native.calls.at(-2)?.name).equals('cancelUpload')
    // The cancelled upload's last word changes nothing.
    await emit('failed', 0.42, 'cancelled')
    expect(byTestId('upload-recording-liv_1')).not.equals(null)

    await press(byTestId('upload-recording-liv_1')!)
    await emit('failed', 0.5, 'The network went away')
    expect(text()).contains('The upload stopped: The network went away')
    await press(byTestId('upload-retry-liv_1')!)
    expect(native.calls.filter(call => call.name === 'uploadRecording')).length(
      3
    )
    await emit('processing', 1)
    expect(byTestId('upload-progress-liv_1')?.textContent).equals(
      'Processing 100%'
    )

    native.answers.recordings = [take({ uploadedAt: 1_790_000_100_000 })]
    await emit('uploaded', 1)
    expect(byTestId('upload-row-liv_1')).equals(null)
  })

  it('says why an upload could not start', async function () {
    const native = fakePhoneStreamModule({
      capabilities: {
        supported: true,
        deviceModel: 'iPhone 13 Pro',
        canRecordLocally: true
      },
      recordings: [take()]
    })
    native.failures.uploadRecording = {
      code: 'noRecording',
      message: 'There is no recording of this camera'
    }
    await mount(fakeClient(), undefined, native)
    await press(byTestId('upload-recording-liv_1')!)
    expect(text()).contains(
      'The upload stopped: There is no recording of this camera'
    )
  })

  it('reads a finished upload, and lists takes after the camera closes', async function () {
    const native = fakePhoneStreamModule({
      capabilities: {
        supported: true,
        deviceModel: 'iPhone 13 Pro',
        canRecordLocally: true
      },
      recordings: [take()],
      uploadRecording: 'vid_1'
    })
    await mount(fakeClient(), undefined, native)
    native.answers.recordings = [take({ uploadedAt: 1_790_000_100_000 })]
    await press(byTestId('upload-recording-liv_1')!)
    expect(byTestId('upload-row-liv_1')).equals(null)
  })

  it('names a take by its angle as the server calls it now, after a rename', async function () {
    const native = fakePhoneStreamModule({
      capabilities: {
        supported: true,
        deviceModel: 'iPhone 13 Pro',
        canRecordLocally: true
      },
      recordings: [
        take({ angleName: 'Second Base' }),
        take({ liveStreamId: 'liv_gone', angleName: 'Left Field' })
      ]
    })
    const fake = fakeClient()
    fake.mine = [stream({ id: 'liv_1', label: 'Third Base' })]
    await mount(fake, undefined, native)
    expect(byTestId('upload-row-liv_1')?.textContent).contains('Third Base')
    expect(byTestId('upload-row-liv_1')?.textContent).not.contains(
      'Second Base'
    )
    // A stream the server no longer lists keeps the take's own name.
    expect(byTestId('upload-row-liv_gone')?.textContent).contains('Left Field')
  })

  it('keeps an uploading angle closed, and Record Video under its name says so', async function () {
    const native = fakePhoneStreamModule({
      capabilities: {
        supported: true,
        deviceModel: 'iPhone 13 Pro',
        canRecordLocally: true
      },
      recordings: [
        take({ uploadId: 'upl_1', uploadRunning: true }),
        take({
          liveStreamId: 'liv_9',
          angleName: 'Left Field',
          gameId: 'gam_other',
          uploadId: 'upl_9'
        })
      ]
    })
    const fake = fakeClient()
    fake.mine = [stream({ id: 'liv_1', label: 'Home Plate' })]
    await mount(fake, undefined, native)
    expect(byTestId('upload-progress-liv_1')?.textContent).equals(
      'Uploading 0%'
    )
    // Another game's take has no row here.
    expect(byTestId('upload-row-liv_9')).equals(null)

    await press(byTestId('angle-row-liv_1')!)
    expect(text()).contains('Home Plate is still uploading')
    expect(fake.added).deep.equals([])

    await press(button('Record Video'))
    await type('home plate')
    await press(button('Record with this phone'))
    expect(text()).contains('home plate is still uploading')
    expect(fake.added).deep.equals([])
  })

  it('films a new camera under the name of an ended one that is uploading', async function () {
    const native = fakePhoneStreamModule({
      capabilities: {
        supported: true,
        deviceModel: 'iPhone 13 Pro',
        canRecordLocally: true
      },
      recordings: [take({ uploadId: 'upl_1', uploadRunning: true })]
    })
    const fake = fakeClient()
    fake.mine = [
      stream({
        id: 'liv_1',
        label: 'Home Plate',
        state: 'ended',
        closesAt: '2026-05-20T17:00:00.000Z'
      })
    ]
    await mount(fake, undefined, native)
    expect(byTestId('upload-progress-liv_1')?.textContent).equals(
      'Uploading 0%'
    )

    await press(button('Record Video'))
    await type('home plate')
    await press(button('Record with this phone'))
    expect(text()).not.contains('still uploading')
    expect(fake.added.map(added => added.label)).deep.equals(['home plate'])
  })

  it('starts a running upload’s row where the engine says it stands, then follows its reports', async function () {
    // Resumed at launch, the upload reported before this panel listened: its
    // row read 0% until the next report, which came only as a part landed.
    const native = fakePhoneStreamModule({
      capabilities: {
        supported: true,
        deviceModel: 'iPhone 13 Pro',
        canRecordLocally: true
      },
      recordings: [
        take({
          uploadId: 'upl_1',
          uploadRunning: true,
          uploadProgress: {
            liveStreamId: 'liv_1',
            state: 'uploading',
            fraction: 0.52,
            bytesSent: 52,
            bytesTotal: 100
          }
        })
      ]
    })
    await mount(fakeClient(), undefined, native)
    expect(byTestId('upload-progress-liv_1')?.textContent).equals(
      'Uploading 52%'
    )
    await act(async () => {
      native.emitUpload({
        liveStreamId: 'liv_1',
        state: 'uploading',
        fraction: 0.61,
        bytesSent: 61,
        bytesTotal: 100
      })
      await delay(20)
    })
    expect(byTestId('upload-progress-liv_1')?.textContent).equals(
      'Uploading 61%'
    )
  })

  it('says an upload cut off in another run was interrupted, and Retry carries it on', async function () {
    const native = fakePhoneStreamModule({
      capabilities: {
        supported: true,
        deviceModel: 'iPhone 13 Pro',
        canRecordLocally: true
      },
      recordings: [take({ uploadId: 'upl_1' })],
      uploadRecording: new Promise(() => {})
    })
    await mount(fakeClient(), undefined, native)
    expect(text()).contains('The upload was interrupted.')
    await press(byTestId('upload-retry-liv_1')!)
    expect(byTestId('upload-progress-liv_1')?.textContent).equals(
      'Preparing 0%'
    )
  })

  it('shows the cameras with Record Video on a phone that cannot record', async function () {
    const fake = fakeClient()
    fake.others = [stream({ id: 'liv_4', label: 'Center Field' })]
    await mount(fake, {
      supported: false,
      deviceModel: '',
      canRecordLocally: false
    })
    expect(byTestId('angle-row-liv_4')).not.equals(null)
    expect(text()).contains('Record Video')
  })
})

const CAN_RECORD = {
  supported: true,
  deviceModel: 'iPhone 13 Pro',
  canRecordLocally: true
}

/** The panel on a game with nothing to play, as `GameScreen` mounts it there. */
async function mountEmpty(
  fake: FakeClient,
  capabilities: unknown = CAN_RECORD
): Promise<void> {
  await mount(
    fake,
    capabilities,
    fakePhoneStreamModule({ capabilities }),
    [],
    false
  )
}

function access(patch: Partial<StreamAccess>): () => Promise<StreamAccess> {
  return async () => ({
    canFilm: false,
    canRequest: false,
    requested: false,
    teamId: 'tem_1',
    ...patch
  })
}

/** How many things the empty state offers to press. */
const actions = (): number =>
  document.querySelectorAll(
    '[data-testid="stream-empty-state"] [role="button"]'
  ).length

const pressId = async (id: string): Promise<void> => {
  const node = byTestId(id)
  expect(node, id).not.equals(null)
  await press(node!)
}

/** Record Video → a name → Use external camera, up to the camera's make. */
async function toSources(name = 'Backstop'): Promise<void> {
  await pressId('record-video')
  await pressId(`angle-suggestion-${name}`)
  await press(button('Use external camera'))
}

/** All the way to the URL, with a camera the server made. */
async function toRtmp(fake: FakeClient): Promise<void> {
  fake.next = async () => {
    const made = stream({
      deviceId: undefined,
      deviceModel: undefined,
      label: 'Backstop',
      url: RTMP_URL
    })
    fake.mine = [made]
    return made
  }
  await toSources()
  await pressId('camera-source-rtmp')
}

const RTMP_URL = 'rtmp://ingest.example.test:1936/live/ts_0000'

describe('the empty state of a game’s Videos tab', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.innerHTML = ''
  })

  it('offers somebody who can film Record Video, once, with its sentence', async function () {
    const fake = fakeClient()
    await mountEmpty(fake)
    expect(text()).contains('No videos')
    expect(text()).contains(
      'Help bring this game to other fans by live streaming with this phone or external camera.'
    )
    expect(text()).not.contains('CAMERAS')
    expect(
      document.querySelectorAll('[data-testid="record-video"]').length
    ).equals(1)
    await pressId('record-video')
    expect(text()).contains('Name this camera angle')
  })

  it('offers a member who cannot film Request access, and says when it went', async function () {
    const fake = fakeClient()
    fake.allowed = false
    fake.access = access({ canRequest: true })
    await mountEmpty(fake)
    expect(text()).contains('Want to record video for this game?')
    expect(text()).not.contains('Record Video')
    expect(fake.listed).equals(0)
    await press(button('Request access'))
    expect(fake.requests).to.have.length(1)
    expect(fake.requests[0]).to.include({
      kind: 'videographer',
      teamId: 'tem_1'
    })
    expect(text()).contains('Request sent')
    await press(button('Request sent'))
    expect(fake.requests).to.have.length(1)
  })

  it('shows a refused request, and a retry is the same request', async function () {
    const fake = fakeClient()
    fake.allowed = false
    fake.access = access({ canRequest: true })
    fake.invite = async () => {
      throw new Error('You are not on this team')
    }
    await mountEmpty(fake)
    await press(button('Request access'))
    expect(text()).contains('You are not on this team')
    fake.invite = async () => ({ id: 'req_1', status: 'pending' })
    await press(button('Request access'))
    expect(text()).contains('Request sent')
    expect(fake.requests).to.have.length(2)
    expect(fake.requests[0]).deep.equals(fake.requests[1])
  })

  it('reads Request sent for a request already waiting', async function () {
    const fake = fakeClient()
    fake.allowed = false
    fake.access = access({ canRequest: true, requested: true })
    await mountEmpty(fake)
    expect(text()).contains('Request sent')
    expect(text()).not.contains('Request access')
  })

  it('offers no action on a past game, or when streamAccess fails', async function () {
    const fake = fakeClient()
    fake.allowed = false
    fake.access = access({ requested: true })
    await mountEmpty(fake)
    expect(text()).contains('No videos')
    expect(actions()).equals(0)
    await act(async () => {
      root?.unmount()
    })
    document.body.innerHTML = ''

    const failed = fakeClient()
    failed.access = async () => {
      throw new HttpError('notFound', 'Not found')
    }
    await mountEmpty(failed)
    expect(text()).contains('No videos')
    expect(actions()).equals(0)
    expect(failed.listed).equals(0)
  })

  it('gives way to the cameras, and to a take waiting on this phone', async function () {
    const fake = fakeClient()
    fake.mine = [stream()]
    await mountEmpty(fake)
    expect(text()).not.contains('No videos')
    expect(text()).contains('CAMERAS')
    await act(async () => {
      root?.unmount()
    })
    document.body.innerHTML = ''

    await mount(
      fakeClient(),
      CAN_RECORD,
      fakePhoneStreamModule({
        capabilities: CAN_RECORD,
        recordings: [take()]
      }),
      [],
      false
    )
    expect(text()).not.contains('No videos')
    expect(text()).contains('Upload Recording')
  })
})

describe('what somebody may do changing while the panel is up', function () {
  let poll: ReturnType<typeof heldPoll>
  beforeEach(function () {
    poll = heldPoll()
  })
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.innerHTML = ''
    poll.restore()
  })

  /** Answers `streamAccess` as a test says, counting what it is asked. */
  function access(
    fake: FakeClient,
    first: Partial<StreamAccess>
  ): { asked: () => number; now: (next: Partial<StreamAccess>) => void } {
    let asked = 0
    let answer = first
    fake.access = async () => {
      asked += 1
      return {
        canFilm: false,
        canRequest: true,
        requested: false,
        teamId: 'tem_1',
        ...answer
      }
    }
    return {
      asked: () => asked,
      now: next => {
        answer = next
      }
    }
  }

  function fakeAppState(): AppStateLike & {
    turn: (state: string) => Promise<void>
    listening: () => number
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
        await act(async () => {
          for (const listener of listeners) listener(state)
          await delay(20)
        })
      },
      listening: () => listeners.size
    }
  }

  const recordVideo = (): Element | null =>
    document.querySelector('[data-testid="record-video"]')
  const phoneReads = (native: FakePhoneStreamModule): number =>
    native.calls.filter(call => call.name === 'recordings').length

  async function mountEmptyWith(
    fake: FakeClient,
    native: FakePhoneStreamModule = fakePhoneStreamModule({
      capabilities: CAN_RECORD
    }),
    appState?: AppStateLike
  ): Promise<void> {
    await mount(fake, CAN_RECORD, native, [], false, fakeLinks(), appState)
  }

  it('reads a failed first answer again until one comes, and brings the camera area back', async function () {
    const fake = fakeClient()
    let failing = true
    let asked = 0
    fake.access = async () => {
      asked += 1
      if (failing) throw new Error('No signal')
      return {
        canFilm: true,
        canRequest: false,
        requested: false,
        teamId: 'tem_1'
      }
    }
    await mountEmptyWith(fake)
    expect(asked).equals(1)
    expect(recordVideo()).equals(null)

    await poll.poll()
    expect(asked).equals(2)
    expect(recordVideo()).equals(null)

    failing = false
    await poll.poll()
    expect(asked).equals(3)
    expect(recordVideo()).not.equals(null)
  })

  it('stops asking about a game out of reach, or for somebody signed out', async function () {
    const unseen = fakeClient()
    let asked = 0
    unseen.access = async () => {
      asked += 1
      throw new HttpError('notFound', 'Not found')
    }
    await mountEmptyWith(unseen)
    await poll.poll()
    expect(asked).equals(1)
    await act(async () => {
      root?.unmount()
    })
    document.body.innerHTML = ''

    const signedOut = fakeClient()
    ;(signedOut.client as { token?: string }).token = undefined
    asked = 0
    signedOut.access = async () => {
      asked += 1
      throw new Error('No signal')
    }
    await mountEmptyWith(signedOut)
    await poll.poll()
    expect(asked).equals(1)
  })

  it('brings Record Video up when a request is approved, asking for nothing else meanwhile', async function () {
    const fake = fakeClient()
    fake.allowed = false
    const answers = access(fake, { requested: true })
    const native = fakePhoneStreamModule({ capabilities: CAN_RECORD })
    await mountEmptyWith(fake, native)
    expect(text()).contains('Request sent')
    expect(recordVideo()).equals(null)
    const reads = phoneReads(native)

    await poll.poll()
    await poll.poll()
    expect(answers.asked()).equals(3)
    expect(fake.listed, 'the list answers 404 until then').equals(0)
    expect(phoneReads(native), 'the phone is left alone').equals(reads)
    expect(recordVideo()).equals(null)

    fake.allowed = true
    answers.now({ canFilm: true, requested: false })
    await poll.poll()
    expect(recordVideo()).not.equals(null)
    expect(text()).not.contains('Request sent')
    expect(fake.listed).equals(1)
  })

  it('starts asking once somebody has asked, whatever a read on its way says', async function () {
    const fake = fakeClient()
    fake.allowed = false
    const answers = access(fake, {})
    const appState = fakeAppState()
    await mountEmptyWith(fake, undefined, appState)
    await poll.poll()
    expect(answers.asked(), 'no reason to ask yet').equals(1)

    // A read begun before the request answers after it.
    const asking = fake.access
    let late: (found: StreamAccess) => void = () => undefined
    fake.access = async () =>
      await new Promise<StreamAccess>(resolve => {
        late = resolve
      })
    await appState.turn('active')
    fake.access = asking

    await press(button('Request access'))
    expect(text()).contains('Request sent')
    await act(async () => {
      late({
        canFilm: false,
        canRequest: true,
        requested: false,
        teamId: 'tem_1'
      })
      await delay(10)
    })
    expect(text()).contains('Request sent')

    answers.now({ requested: true })
    await poll.poll()
    expect(answers.asked()).equals(2)
  })

  /** The idempotency key of each request to film, in the order sent. */
  const keys = (fake: FakeClient): unknown[] =>
    fake.requests.map(
      sent => (sent as { idempotencyKey?: unknown }).idempotencyKey
    )

  // The main path: the key ends with the request that went.
  it('asks again with a new request after a decline, on the same screen', async function () {
    const fake = fakeClient()
    fake.allowed = false
    const answers = access(fake, {})
    await mountEmptyWith(fake)
    await press(button('Request access'))
    answers.now({ requested: true })
    await poll.poll()
    expect(text()).contains('Request sent')

    // A coach declines: the next read brings Request access back.
    answers.now({ requested: false })
    await poll.poll()
    expect(text()).not.contains('Request sent')
    await press(button('Request access'))
    expect(fake.requests).to.have.length(2)
    const [first, second] = keys(fake)
    expect(first).to.be.a('string')
    expect(second).to.be.a('string').and.not.equal(first)
    expect(text()).contains('Request sent')

    answers.now({ requested: true })
    await poll.poll()
    await poll.poll()
    expect(text()).contains('Request sent')
  })

  it('keeps one request through failed sends, and asks anew after a decline', async function () {
    const fake = fakeClient()
    fake.allowed = false
    const answers = access(fake, {})
    let failures = 2
    fake.invite = async () => {
      if (failures > 0) {
        failures -= 1
        throw new Error('No signal')
      }
      return { id: 'req_1', status: 'pending' }
    }
    await mountEmptyWith(fake)
    await press(button('Request access'))
    expect(text()).contains('No signal')
    await press(button('Request access'))
    await press(button('Request access'))
    expect(text()).contains('Request sent')
    const sent = keys(fake)
    expect(sent).to.have.length(3)
    expect(new Set(sent).size, 'one key for one ask').equals(1)

    answers.now({ requested: true })
    await poll.poll()
    answers.now({ requested: false })
    await poll.poll()
    await press(button('Request access'))
    expect(keys(fake)).to.have.length(4)
    expect(keys(fake)[3]).to.be.a('string').and.not.equal(sent[0])
  })

  it('asks anew after a decline of a request whose answer was lost', async function () {
    const fake = fakeClient()
    fake.allowed = false
    const answers = access(fake, {})
    const appState = fakeAppState()
    fake.invite = async () => {
      throw new Error('No signal')
    }
    await mountEmptyWith(fake, undefined, appState)
    await press(button('Request access'))
    expect(text()).contains('No signal')

    // It reached the server all the same, and a later read says so.
    answers.now({ requested: true })
    await appState.turn('active')
    expect(text()).contains('Request sent')
    expect(text(), 'nothing failed after all').not.contains('No signal')
    answers.now({ requested: false })
    await poll.poll()
    expect(text()).not.contains('Request sent')

    fake.invite = async () => ({ id: 'req_2', status: 'pending' })
    await press(button('Request access'))
    const [lost, next] = keys(fake)
    expect(next).to.be.a('string').and.not.equal(lost)
    expect(text()).contains('Request sent')
  })

  it('asks anew when a lost answer’s request was declined before any read', async function () {
    const fake = fakeClient()
    fake.allowed = false
    access(fake, {})
    fake.invite = async () => {
      throw new Error('No signal')
    }
    await mountEmptyWith(fake)
    await press(button('Request access'))
    const [lost] = keys(fake)

    // The server has it and a coach declines it; nothing reads in between,
    // and the same key gets that request back, declined.
    fake.invite = async () =>
      keys(fake).at(-1) === lost
        ? { id: 'req_1', status: 'declined' }
        : { id: 'req_2', status: 'pending' }
    await press(button('Request access'))
    const sent = keys(fake)
    expect(sent).to.have.length(3)
    expect(sent[1]).equals(lost)
    expect(sent[2]).to.be.a('string').and.not.equal(lost)
    expect(text()).contains('Request sent')
    expect(text()).not.contains('No signal')
  })

  it('shows no error from a send that fails once a read has its request waiting', async function () {
    const fake = fakeClient()
    fake.allowed = false
    const answers = access(fake, {})
    const appState = fakeAppState()
    let fail: (error: Error) => void = () => undefined
    fake.invite = async () =>
      await new Promise((_resolve, reject) => {
        fail = reject
      })
    await mountEmptyWith(fake, undefined, appState)
    await press(button('Request access'))

    // Back from another app, a read begun after the tap finds it waiting,
    // and only then does the send's answer fail.
    answers.now({ requested: true })
    await appState.turn('active')
    await act(async () => {
      fail(new Error('No signal'))
      await delay(20)
    })
    expect(text()).contains('Request sent')
    expect(text()).not.contains('No signal')

    answers.now({ requested: false })
    await poll.poll()
    expect(text(), 'declined, with no stale error').not.contains('No signal')
  })

  // Locks a request from before this mount, which holds no key here.
  it('asks again once a request from an earlier visit expires', async function () {
    const fake = fakeClient()
    fake.allowed = false
    const answers = access(fake, { requested: true })
    await mountEmptyWith(fake)
    expect(text()).contains('Request sent')
    answers.now({ requested: false })
    await poll.poll()
    await press(button('Request access'))
    expect(keys(fake)).to.have.length(1)
    expect(keys(fake)[0]).to.be.a('string')
    expect(text()).contains('Request sent')
  })

  it('takes Record Video away with the role, and stops reading the cameras', async function () {
    const fake = fakeClient()
    const answers = access(fake, { canFilm: true })
    const native = fakePhoneStreamModule({ capabilities: CAN_RECORD })
    await mountEmptyWith(fake, native)
    expect(recordVideo()).not.equals(null)
    await poll.poll()
    expect(fake.listed).equals(2)

    answers.now({ canFilm: false })
    await poll.poll()
    expect(recordVideo()).equals(null)
    expect(text()).contains('Request access')
    expect(fake.listed).equals(2)

    const reads = phoneReads(native)
    const asked = answers.asked()
    await poll.poll()
    expect(answers.asked(), 'no reason to go on asking').equals(asked)
    expect(fake.listed).equals(2)
    expect(phoneReads(native)).equals(reads)
  })

  it('takes the rows away with the role where the game has a video', async function () {
    const fake = fakeClient()
    fake.mine = [stream({ id: 'liv_1', label: 'Home Plate' })]
    const answers = access(fake, { canFilm: true })
    await mount(fake)
    expect(text()).contains('Home Plate')
    answers.now({ canFilm: false })
    await poll.poll()
    expect(text()).not.contains('Home Plate')
  })

  it('leaves a running camera up when the role goes, until it closes', async function () {
    const fake = fakeClient()
    fake.mine = [stream({ id: 'liv_1', label: 'Home Plate' })]
    const answers = access(fake, { canFilm: true })
    await mount(fake)
    await press(byTestId('angle-row-liv_1')!)
    expect(byTestId('fake-screen')).not.equals(null)

    answers.now({ canFilm: false })
    await poll.poll()
    await poll.poll()
    expect(byTestId('fake-screen'), 'still filming').not.equals(null)

    await pressId('fake-screen')
    expect(byTestId('fake-screen')).equals(null)
    expect(text()).not.contains('Home Plate')
  })

  it('leaves a sheet in use up when the role goes', async function () {
    const fake = fakeClient()
    const answers = access(fake, { canFilm: true })
    await mountEmptyWith(fake)
    await pressId('record-video')
    expect(text()).contains('Name this camera angle')
    answers.now({ canFilm: false })
    await poll.poll()
    expect(text()).contains('Name this camera angle')
  })

  it('keeps what somebody may do through a failed read, unless the game has gone from them', async function () {
    const fake = fakeClient()
    access(fake, { canFilm: true })
    await mountEmptyWith(fake)
    fake.access = async () => {
      throw new HttpError('offline', 'Cannot reach TeamStation.')
    }
    await poll.poll()
    expect(recordVideo()).not.equals(null)

    fake.access = async () => {
      throw new HttpError('notFound', 'Not found')
    }
    await poll.poll()
    expect(recordVideo()).equals(null)
    expect(text()).contains('No videos')
  })

  it('reads it again when the app comes back to the front, for anybody signed in', async function () {
    const fake = fakeClient()
    fake.allowed = false
    const answers = access(fake, {})
    const appState = fakeAppState()
    await mountEmptyWith(fake, undefined, appState)
    expect(answers.asked()).equals(1)
    await appState.turn('background')
    expect(answers.asked()).equals(1)

    fake.allowed = true
    answers.now({ canFilm: true })
    await appState.turn('active')
    expect(answers.asked()).equals(2)
    expect(recordVideo()).not.equals(null)

    answers.now({ canFilm: false })
    await appState.turn('active')
    expect(recordVideo()).equals(null)
  })

  it('tries again from the front after a first read that failed', async function () {
    const fake = fakeClient()
    fake.allowed = false
    fake.access = async () => {
      throw new HttpError('offline', 'Cannot reach TeamStation.')
    }
    const appState = fakeAppState()
    await mountEmptyWith(fake, undefined, appState)
    expect(text()).not.contains('Request access')
    access(fake, {})
    await appState.turn('active')
    expect(text()).contains('Request access')
  })

  it('asks nothing for nobody signed in, and lets go of the app’s state on the way out', async function () {
    const fake = fakeClient()
    fake.allowed = false
    fake.client.token = undefined
    const answers = access(fake, {})
    const appState = fakeAppState()
    await mountEmptyWith(fake, undefined, appState)
    expect(answers.asked()).equals(1)
    await appState.turn('active')
    expect(answers.asked()).equals(1)
    expect(appState.listening()).equals(1)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(appState.listening()).equals(0)
  })

  it('passes over an answer that comes after the panel has gone', async function () {
    const fake = fakeClient()
    let answer: (found: StreamAccess) => void = () => undefined
    let refuse: (error: Error) => void = () => undefined
    fake.access = async () =>
      await new Promise<StreamAccess>((resolve, reject) => {
        answer = resolve
        refuse = reject
      })
    await mountEmptyWith(fake)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    answer({ canFilm: true, canRequest: false, requested: false, teamId: 't' })
    refuse(new Error('gone'))
    await delay(10)
    expect(fake.listed).equals(0)
  })
})

describe('setting up a camera on a phone', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    opened.length = 0
    document.body.innerHTML = ''
    ;(Platform as { OS: string }).OS = 'web'
  })

  it('fills the field from a pill, and the rows wait for a name that can be sent', async function () {
    const fake = fakeClient()
    await mount(fake)
    await pressId('record-video')
    await press(button('Use external camera'))
    expect(text()).not.contains('Stream with your camera')
    await press(button('Record with this phone'))
    expect(fake.added).deep.equals([])
    await type('Home — Plate')
    await press(button('Use external camera'))
    expect(text()).not.contains('Stream with your camera')
    await pressId('angle-suggestion-Backstop')
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Camera angle"]'
      )?.value
    ).equals('Backstop')
    await press(button('Use external camera'))
    expect(text()).contains('Stream with your camera')
  })

  it('opens the camera, not recording, from Record with this phone', async function () {
    const fake = fakeClient()
    await mount(fake)
    await pressId('record-video')
    await pressId('angle-suggestion-Home')
    await press(button('Record with this phone'))
    await settle()
    expect(opened.at(-1)?.session.streamId).equals(stream().id)
    expect(opened.at(-1)?.session.angleName).equals('Home Plate')
  })

  for (const [row, source] of [
    ['GoPro, with its app missing', 'gopro'],
    ['Other camera', 'rtmp']
  ] as const) {
    it(`makes the camera with its source as ${row} opens the RTMP sheet, and not before`, async function () {
      const fake = fakeClient()
      fake.next = async () => stream({ url: RTMP_URL })
      await mount(fake)
      await toSources()
      expect(text()).contains('RTMP compatible camera')
      expect(fake.added, 'nothing made yet').deep.equals([])
      await pressId(`camera-source-${source}`)
      expect(fake.added).deep.equals([
        { gameId: 'gam_1', label: 'Backstop', device: { source } }
      ])
      expect(text()).contains('Stream using RTMP')
      expect(byTestId('rtmp-url')?.textContent).equals(RTMP_URL)
      expect(text()).contains(
        'Use the URL below and enter it into your camera.'
      )
      expect(text()).contains(
        'If your app requests a stream key, leave it blank.'
      )
      expect(text()).contains('Your camera must stream in HEVC (H.265).')
      expect(text()).contains(
        'You may now return to the app and stream to the RTMP URL at any time.'
      )
    })
  }

  describe('a camera with its own app', function () {
    afterEach(function () {
      ;(Platform as { OS: string }).OS = 'web'
    })

    const listed = (fake: FakeClient): void => {
      fake.next = async () => {
        const made = stream({
          deviceId: undefined,
          deviceModel: undefined,
          label: 'Backstop',
          source: 'mevo',
          url: RTMP_URL
        })
        fake.mine = [made]
        return made
      }
    }

    async function mountWith(
      fake: FakeClient,
      links: FakeLinks
    ): Promise<void> {
      await mount(
        fake,
        CAN_RECORD,
        fakePhoneStreamModule({ capabilities: CAN_RECORD }),
        [],
        true,
        links
      )
    }

    it('makes the camera, fires its link and leaves it on the tab', async function () {
      ;(Platform as { OS: string }).OS = 'android'
      const fake = fakeClient()
      listed(fake)
      const links = fakeLinks(['mevostream://configure'])
      await mountWith(fake, links)
      await toSources()
      expect(fake.added, 'nothing made yet').deep.equals([])
      await pressId('camera-source-mevo')
      await settle()
      expect(fake.added).deep.equals([
        { gameId: 'gam_1', label: 'Backstop', device: { source: 'mevo' } }
      ])
      expect(links.fired).to.have.length(1)
      expect(links.fired[0]).contains('mevostream://configure/?publishHost=')
      expect(links.fired[0]).contains('encoder=hevc')
      expect(byTestId('camera-source-sheet')).equals(null)
      expect(byTestId('rtmp-url-sheet')).equals(null)
      expect(text()).contains('Using Mevo')
    })

    it('opens the RTMP sheet from the row a link made', async function () {
      const fake = fakeClient()
      listed(fake)
      await mountWith(fake, fakeLinks(['mevostream://configure']))
      await toSources()
      await pressId('camera-source-mevo')
      await settle()
      await pressId(`angle-row-${stream().id}`)
      await settle()
      expect(byTestId('rtmp-url')?.textContent).equals(RTMP_URL)
      expect(fake.added).to.have.length(1)
    })

    it('hands Mevo Studio’s link to its app where no package can be asked about', async function () {
      const fake = fakeClient()
      listed(fake)
      const links = fakeLinks()
      await mountWith(fake, links)
      await toSources()
      await pressId('camera-source-mevoStudio')
      expect(links.fired[0]).contains('https://multicam.mevo.com?link=')
      expect(fake.added[0].device).deep.equals({ source: 'mevoStudio' })
    })

    it('stays on the sheet with Android’s store page up, and makes no camera', async function () {
      ;(Platform as { OS: string }).OS = 'android'
      const fake = fakeClient()
      listed(fake)
      const links = fakeLinks()
      await mountWith(fake, links)
      await toSources()
      await pressId('camera-source-gopro')
      await settle()
      expect(links.fired).deep.equals([
        'https://play.google.com/store/apps/details?id=com.gopro.smarty'
      ])
      expect(fake.added).deep.equals([])
      expect(byTestId('camera-source-sheet')).not.equals(null)
      links.installed.push('goprocontrol://com.gopro.smarty/home')
      await pressId('camera-source-gopro')
      expect(fake.added, 'tapped again once installed').to.have.length(1)
    })

    it('says under the rows why a camera was refused, and fires nothing', async function () {
      const fake = fakeClient()
      fake.next = async () => {
        throw new HttpError('conflict', 'This game already has 4 cameras.')
      }
      const links = fakeLinks(['mevostream://configure'])
      await mountWith(fake, links)
      await toSources()
      await pressId('camera-source-mevo')
      expect(byTestId('camera-source-error')?.textContent).equals(
        'This game already has 4 cameras.'
      )
      expect(byTestId('camera-source-sheet')).not.equals(null)
      expect(links.fired).deep.equals([])
      await pressId('camera-source-rtmp')
      await settle()
      await pressId('rtmp-done')
      await settle()
      await toSources()
      expect(
        byTestId('camera-source-error'),
        'a new attempt starts clean'
      ).equals(null)
    })

    it('says something for a refusal that is no error', async function () {
      const fake = fakeClient()
      fake.next = async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- What a stranger's code may throw.
        throw 'refused'
      }
      await mountWith(fake, fakeLinks(['mevostream://configure']))
      await toSources()
      await pressId('camera-source-mevo')
      expect(byTestId('camera-source-error')).not.equals(null)
    })

    it('makes one camera from two quick taps', async function () {
      const fake = fakeClient()
      let finish = (): void => {}
      fake.next = async () => {
        await new Promise<void>(resolve => {
          finish = resolve
        })
        return stream({ url: RTMP_URL })
      }
      await mountWith(fake, fakeLinks(['mevostream://configure']))
      await toSources()
      await pressId('camera-source-mevo')
      await pressId('camera-source-mevo')
      expect(fake.added).to.have.length(1)
      await act(async () => {
        finish()
        await delay(20)
      })
    })

    describe('while its camera is being made', function () {
      /** A camera the server holds until `finish` lets it go. */
      const heldCamera = (fake: FakeClient): (() => void) => {
        let finish = (): void => {}
        fake.next = async () => {
          await new Promise<void>(resolve => {
            finish = resolve
          })
          const made = stream({
            deviceId: undefined,
            deviceModel: undefined,
            label: 'Backstop',
            source: 'mevo',
            url: RTMP_URL
          })
          fake.mine = [made]
          return made
        }
        return () => {
          finish()
        }
      }
      const sourceSheet = (): boolean =>
        byTestId('camera-source-sheet') != null &&
        text().includes('Stream with your camera')
      const release = async (finish: () => void): Promise<void> => {
        await act(async () => {
          finish()
          await delay(20)
        })
        await settle()
      }

      for (const os of ['android', 'ios']) {
        it(`holds the sheet against Cancel, the backdrop and Android’s back, until the app opens, on ${os}`, async function () {
          ;(Platform as { OS: string }).OS = os
          const fake = fakeClient()
          const finish = heldCamera(fake)
          const links = fakeLinks(['mevostream://configure'])
          links.openInApp = async url => {
            links.fired.push(url)
            return true
          }
          await mountWith(fake, links)
          await toSources()
          await settle()
          await pressId('camera-source-mevo')
          expect(fake.added).to.have.length(1)

          await pressId('sheet-cancel')
          await press(
            document.querySelector<HTMLElement>(
              '[role="button"][aria-label="Cancel"]'
            )!
          )
          await settle()
          expect(sourceSheet(), 'still up').equals(true)
          expect(links.fired, 'nothing yet').deep.equals([])
          // Another row does nothing either, Other camera included.
          await pressId('camera-source-rtmp')
          await pressId('camera-source-gopro')
          expect(fake.added).to.have.length(1)
          expect(byTestId('rtmp-url')).equals(null)

          await release(finish)
          expect(links.fired).to.have.length(1)
          expect(fake.added).to.have.length(1)
          expect(sourceSheet(), 'gone with the app').equals(false)
        })

        it(`shows the URL of a camera whose link would not open, on ${os}`, async function () {
          ;(Platform as { OS: string }).OS = os
          const fake = fakeClient()
          const finish = heldCamera(fake)
          const links = fakeLinks(['mevostream://configure'])
          const refuse = async (): Promise<boolean> => {
            throw new Error('No activity')
          }
          links.openURL = async () => {
            await refuse()
          }
          links.openInApp = refuse
          await mountWith(fake, links)
          await toSources()
          await settle()
          await pressId('camera-source-mevo')
          await release(finish)
          expect(byTestId('rtmp-url')?.textContent).equals(RTMP_URL)
        })
      }

      it('lets go when nothing answers in time, opening nothing however late the answer', async function () {
        ;(Platform as { OS: string }).OS = 'android'
        const fake = fakeClient()
        const finish = heldCamera(fake)
        const links = fakeLinks(['mevostream://configure'])
        await mount(
          fake,
          CAN_RECORD,
          fakePhoneStreamModule({ capabilities: CAN_RECORD }),
          [],
          true,
          links,
          undefined,
          40
        )
        await toSources()
        await pressId('camera-source-mevo')
        await act(async () => {
          await delay(60)
        })
        expect(byTestId('camera-source-error')?.textContent).contains(
          'took too long'
        )
        expect(sourceSheet()).equals(true)

        await release(finish)
        expect(
          links.fired,
          'no app over a sheet that said it failed'
        ).deep.equals([])
        expect(byTestId('rtmp-url')).equals(null)

        await pressId('sheet-cancel')
        await settle()
        expect(sourceSheet(), 'Cancel answers again').equals(false)
      })

      it('lets go of a system that never answers about the app', async function () {
        ;(Platform as { OS: string }).OS = 'android'
        const fake = fakeClient()
        const links = fakeLinks()
        let answer = (_found: boolean): void => {}
        links.canOpenURL = async () =>
          await new Promise<boolean>(resolve => {
            answer = resolve
          })
        await mount(
          fake,
          CAN_RECORD,
          fakePhoneStreamModule({ capabilities: CAN_RECORD }),
          [],
          true,
          links,
          undefined,
          40
        )
        await toSources()
        await pressId('camera-source-mevo')
        await act(async () => {
          await delay(60)
        })
        expect(byTestId('camera-source-error')).not.equals(null)

        await act(async () => {
          answer(true)
          await delay(20)
        })
        expect(fake.added, 'nothing made after that').deep.equals([])
        expect(links.fired).deep.equals([])
      })

      it('opens nothing when the panel goes first', async function () {
        ;(Platform as { OS: string }).OS = 'android'
        const fake = fakeClient()
        const finish = heldCamera(fake)
        const links = fakeLinks(['mevostream://configure'])
        await mountWith(fake, links)
        await toSources()
        await pressId('camera-source-mevo')
        await act(async () => {
          root?.unmount()
        })
        root = undefined
        await act(async () => {
          finish()
          await delay(20)
        })
        expect(links.fired).deep.equals([])
      })

      it('says nothing when the panel goes and a refusal arrives after', async function () {
        ;(Platform as { OS: string }).OS = 'android'
        const fake = fakeClient()
        let refuse = (_error: Error): void => {}
        fake.next = async () =>
          await new Promise<LiveStream>((_resolve, reject) => {
            refuse = reject
          })
        const links = fakeLinks(['mevostream://configure'])
        await mountWith(fake, links)
        await toSources()
        await pressId('camera-source-mevo')
        await act(async () => {
          root?.unmount()
        })
        root = undefined
        await act(async () => {
          refuse(new Error('No'))
          await delay(10)
        })
        expect(links.fired).deep.equals([])
      })
    })

    it('shows the URL of a camera whose link would not open', async function () {
      const fake = fakeClient()
      listed(fake)
      const links = fakeLinks(['mevostream://configure'])
      links.answer = async () => {
        throw new Error('No activity')
      }
      await mountWith(fake, links)
      await toSources()
      await pressId('camera-source-mevo')
      await settle()
      expect(byTestId('rtmp-url')?.textContent).equals(RTMP_URL)
      expect(fake.added, 'the camera is not made again').to.have.length(1)
    })

    it('leaves a missing app to the RTMP sheet on iOS', async function () {
      ;(Platform as { OS: string }).OS = 'ios'
      const fake = fakeClient()
      listed(fake)
      await mountWith(fake, fakeLinks())
      await toSources()
      await settle()
      await pressId('camera-source-gopro')
      await settle()
      expect(byTestId('rtmp-url')?.textContent).equals(RTMP_URL)
      expect(fake.added[0].device).deep.equals({ source: 'gopro' })
    })
  })

  it('asks once, and leaves the camera listed after Done', async function () {
    const fake = fakeClient()
    const copied: string[] = []
    await mount(
      fake,
      CAN_RECORD,
      fakePhoneStreamModule({ capabilities: CAN_RECORD }),
      copied,
      false
    )
    await toRtmp(fake)
    expect(fake.added).to.have.length(1)
    await pressId('rtmp-copy')
    expect(copied).deep.equals([RTMP_URL])
    expect(byTestId('rtmp-copied')?.textContent).equals('Copied')
    await pressId('rtmp-done')
    await settle()
    expect(text()).not.contains('Stream using RTMP')
    expect(text()).contains('Backstop')
    expect(text()).not.contains('No videos')
  })

  it('reveals the URL when the answer leaves it out', async function () {
    const fake = fakeClient()
    fake.next = async () => stream({ url: undefined })
    fake.reveal = async () => stream({ url: RTMP_URL })
    await mount(fake)
    await toSources()
    await pressId('camera-source-gopro')
    expect(fake.revealed).deep.equals([stream().id])
    expect(byTestId('rtmp-url')?.textContent).equals(RTMP_URL)
  })

  for (const os of ['android', 'ios']) {
    it(`makes one camera however often Other camera is tapped as its sheet leaves, on ${os}`, async function () {
      const real = Platform.OS
      Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
      try {
        const fake = fakeClient()
        let made = 0
        fake.next = async () => {
          made += 1
          return stream({
            deviceId: undefined,
            deviceModel: undefined,
            label: 'Backstop',
            url: RTMP_URL
          })
        }
        await mountEmpty(fake)
        await pressId('record-video')
        await settle()
        await pressId('angle-suggestion-Backstop')
        await press(button('Use external camera'))
        await settle()
        const row = byTestId('camera-source-rtmp')!
        await press(row)
        await press(row)
        await press(row)
        await settle()
        expect(made).equals(1)
        expect(text()).contains('Stream using RTMP')
      } finally {
        Object.defineProperty(Platform, 'OS', {
          value: real,
          configurable: true
        })
      }
    })
  }

  it('says why a camera was refused, with no Revoke', async function () {
    const fake = fakeClient()
    fake.next = async () => {
      throw new HttpError('conflict', 'This game already has 4 cameras.')
    }
    await mount(fake)
    await toSources()
    await pressId('camera-source-rtmp')
    expect(text()).contains('This game already has 4 cameras.')
    expect(byTestId('rtmp-revoke')).equals(null)
    await pressId('rtmp-done')
    await settle()
    expect(text()).not.contains('Stream using RTMP')
  })

  it('confirms Revoke with the angle in bold, then leaves the camera to the server', async function () {
    const fake = fakeClient()
    await mountEmpty(fake)
    await toRtmp(fake)
    await pressId('rtmp-revoke')
    expect(text()).contains('Revoke this camera?')
    expect(text()).contains(
      'This will revoke the RTMP URL and cancel the stream of Backstop.'
    )
    expect(byTestId('revoke-angle')?.textContent).equals('Backstop')
    expect(fake.acted).deep.equals([])
    fake.mine = []
    await pressId('revoke-confirm')
    await settle()
    const id = stream().id
    expect(fake.acted).deep.equals([`revoke ${id}`])
    expect(text()).contains('No videos')
    expect(text()).not.contains('Revoke')
  })

  it('asks the server the same whatever the list last said of the camera', async function () {
    const fake = fakeClient()
    await mount(fake)
    await toRtmp(fake)
    fake.mine = [
      stream({ label: 'Backstop', publishedAt: '2026-05-20T16:01:00.000Z' })
    ]
    await pressId('rtmp-done')
    await settle()
    await pressId('record-video')
    await settle()
    await press(button('Cancel'))
    await settle()
    fake.next = async () => stream({ label: 'Backstop', url: RTMP_URL })
    await toSources()
    await pressId('camera-source-rtmp')
    await pressId('rtmp-revoke')
    await pressId('revoke-confirm')
    await settle()
    expect(fake.acted).deep.equals([`revoke ${stream().id}`])
  })

  it('goes back to the URL from Cancel without asking the server again, and a failed Revoke can be retried', async function () {
    const fake = fakeClient()
    await mount(fake)
    await toRtmp(fake)
    await settle()
    await pressId('rtmp-revoke')
    await settle()
    const cancel = byTestId('revoke-sheet')?.querySelector<HTMLElement>(
      '[role="button"]:last-of-type'
    )
    await press(cancel!)
    await settle()
    expect(byTestId('revoke-sheet')).equals(null)
    expect(byTestId('rtmp-url')?.textContent).equals(RTMP_URL)
    expect(fake.added).to.have.length(1)
    expect(fake.revealed).deep.equals([])
    await pressId('rtmp-revoke')
    fake.end = async () => {
      throw new Error('The server is away')
    }
    await pressId('revoke-confirm')
    expect(text()).contains('The server is away')
    expect(text()).contains('Revoke this camera?')
    fake.end = async () => stream()
    await pressId('revoke-confirm')
    await settle()
    expect(text()).not.contains('Revoke this camera?')
  })

  it('waits on iOS for each sheet to leave before the next one comes up', async function () {
    ;(Platform as { OS: string }).OS = 'ios'
    const fake = fakeClient()
    await mount(fake)
    await pressId('record-video')
    await pressId('angle-suggestion-Backstop')
    await press(button('Use external camera'))
    expect(byTestId('camera-source-sheet'), 'still leaving').equals(null)
    await settle()
    expect(byTestId('camera-source-sheet')).not.equals(null)
    fake.next = async () => stream({ label: 'Backstop', url: RTMP_URL })
    await pressId('camera-source-rtmp')
    expect(fake.added, 'made once its sheet is up').deep.equals([])
    await settle()
    expect(fake.added).to.have.length(1)
    await pressId('rtmp-revoke')
    expect(byTestId('revoke-sheet')).equals(null)
    await settle()
    expect(byTestId('revoke-sheet')).not.equals(null)
  })

  it('opens the camera on iOS only once the name sheet has left', async function () {
    ;(Platform as { OS: string }).OS = 'ios'
    const fake = fakeClient()
    await mount(fake)
    await pressId('record-video')
    await pressId('angle-suggestion-Home')
    await press(button('Record with this phone'))
    expect(opened, 'still leaving').deep.equals([])
    await settle()
    expect(opened.at(-1)?.session.streamId).equals(stream().id)
  })

  it('disables Record Video at either limit, and says why', async function () {
    const fake = fakeClient()
    fake.mine = [stream()]
    fake.canAdd = 0
    await mount(fake)
    expect(byTestId('record-video-limit')?.textContent).equals(
      'You already have 4 cameras on this game. End one to add another.'
    )
    await pressId('record-video')
    expect(text()).not.contains('Name this camera angle')
    await act(async () => {
      root?.unmount()
    })
    document.body.innerHTML = ''

    const full = fakeClient()
    full.others = [stream()]
    full.gameCanAdd = 0
    full.maxGameCameras = 8
    await mount(full)
    expect(byTestId('record-video-limit')?.textContent).equals(
      'This game already has 8 cameras. End one to add another.'
    )
    await pressId('record-video')
    expect(text()).not.contains('Name this camera angle')
  })

  it('counts the cameras of a game left above its limit', async function () {
    const fake = fakeClient()
    fake.mine = [1, 2].map(slot =>
      stream({
        id: `liv_0000000000000000000${slot}`,
        slot,
        label: `Cam ${slot}`
      })
    )
    fake.others = [3, 4, 5, 6].map(slot =>
      stream({
        id: `liv_0000000000000000000${slot}`,
        userId: userIdOfGumbo(8),
        slot: slot - 2,
        label: `Other ${slot}`
      })
    )
    fake.canAdd = 0
    fake.gameCanAdd = 0
    fake.maxGameCameras = 4
    await mount(fake)
    expect(byTestId('record-video-limit')?.textContent).equals(
      'This game already has 6 cameras. End one to add another.'
    )
  })

  it('gives the game’s sentence when one person holds all of a game’s cameras', async function () {
    const fake = fakeClient()
    fake.mine = [1, 2, 3, 4].map(slot =>
      stream({
        id: `liv_0000000000000000000${slot}`,
        slot,
        label: `Cam ${slot}`
      })
    )
    fake.canAdd = 0
    fake.gameCanAdd = 0
    fake.maxGameCameras = 4
    await mount(fake)
    expect(byTestId('record-video-limit')?.textContent).equals(
      'This game already has 4 cameras. End one to add another.'
    )
    await pressId('record-video')
    expect(text()).not.contains('Name this camera angle')
  })
})

describe('camera rows on a phone', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    opened.length = 0
    played.length = 0
  })

  /** A native module holding `takes`, and the engine calls made on it. */
  const holding = (...takes: Array<typeof RECORDING>): FakePhoneStreamModule =>
    fakePhoneStreamModule({ capabilities: CAN_RECORD, recordings: takes })
  const called = (native: FakePhoneStreamModule): string[] =>
    native.calls
      .filter(call => ['cancelUpload', 'deleteRecording'].includes(call.name))
      .map(call => `${call.name} ${String(call.args[0])}`)
  /** Cancel on the warning, not the Cancel of an upload's row behind it. */
  const cancelSheet = async (id: string): Promise<void> => {
    const found = [
      ...(byTestId(id)?.querySelectorAll<HTMLElement>('[role="button"]') ?? [])
    ].find(node => node.textContent === 'Cancel')
    expect(found, id).not.equals(undefined)
    await press(found!)
    await settle()
  }
  const rowOrder = (): string[] =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid^="angle-row-"], [data-testid="record-video"]'
      )
    ].map(node => node.getAttribute('data-testid')!.replace('angle-row-', ''))

  it('draws mine then others’, oldest first, and ended rows below Record Video', async function () {
    const fake = fakeClient()
    const at = (minute: number): string =>
      `2026-05-20T16:${String(minute).padStart(2, '0')}:00.000Z`
    fake.mine = [
      stream({ id: 'liv_b', createdAt: at(5), deviceId: OTHER_DEVICE }),
      stream({ id: 'liv_a', createdAt: at(9), state: 'ended' }),
      stream({ id: 'liv_c', createdAt: at(1) }),
      stream({ id: 'liv_d', createdAt: at(2), state: 'ended' })
    ]
    fake.others = [
      stream({ id: 'liv_e', createdAt: at(7), deviceId: undefined }),
      stream({
        id: 'liv_f',
        createdAt: at(0),
        deviceId: undefined,
        closesAt: at(3)
      }),
      stream({ id: 'liv_g', createdAt: at(0), deviceId: undefined })
    ]
    await mount(fake)
    expect(rowOrder()).deep.equals([
      'liv_c',
      'liv_b',
      'liv_g',
      'liv_e',
      'record-video',
      'liv_d',
      'liv_a',
      'liv_f'
    ])
  })

  it('opens the RTMP sheet from an own external row, with no source or a chosen one', async function () {
    const fake = fakeClient()
    fake.mine = [
      stream({
        id: 'liv_1',
        deviceId: null,
        deviceModel: null,
        source: null,
        url: undefined
      })
    ]
    fake.reveal = async () => stream({ id: 'liv_1', url: RTMP_URL })
    await mount(fake)
    expect(byTestId('angle-subtitle-liv_1')?.textContent).equals(
      'Using RTMP URL'
    )
    await press(byTestId('angle-row-liv_1')!)
    await settle()
    expect(fake.revealed).deep.equals(['liv_1'])
    expect(byTestId('rtmp-url')?.textContent).equals(RTMP_URL)
    expect(fake.added).deep.equals([])
  })

  it('plays somebody else’s ended row only when it has a video', async function () {
    const fake = fakeClient()
    fake.others = [
      stream({
        id: 'liv_1',
        deviceId: undefined,
        state: 'ended',
        playableVideoId: 'vid_1'
      }),
      stream({ id: 'liv_2', deviceId: undefined, state: 'ended' }),
      stream({ id: 'liv_3', deviceId: undefined })
    ]
    await mount(fake)
    await press(byTestId('angle-row-liv_1')!)
    expect(played).deep.equals(['vid_1'])
    expect(byTestId('angle-row-liv_2')?.getAttribute('role')).not.equals(
      'button'
    )
    await press(byTestId('angle-row-liv_2')!)
    await press(byTestId('angle-row-liv_3')!)
    expect(played).deep.equals(['vid_1'])
    expect(fake.added).deep.equals([])
  })

  it('shows End on an own phone row elsewhere only, and asks before it ends', async function () {
    const fake = fakeClient()
    fake.mine = [
      stream({ id: 'liv_1', label: 'Mine Here' }),
      stream({
        id: 'liv_2',
        label: 'Third Base',
        deviceId: OTHER_DEVICE,
        deviceModel: 'Pixel 10',
        state: 'publishing'
      }),
      stream({
        id: 'liv_3',
        label: 'Over There',
        deviceId: OTHER_DEVICE,
        state: 'ended'
      }),
      stream({ id: 'liv_4', deviceId: null, deviceModel: null })
    ]
    fake.others = [stream({ id: 'liv_5', deviceId: undefined })]
    await mount(fake)
    for (const id of ['liv_1', 'liv_3', 'liv_4', 'liv_5'])
      expect(byTestId(`angle-end-${id}`), id).equals(null)
    await press(byTestId('angle-row-liv_2')!)
    expect(fake.added).deep.equals([])

    await press(byTestId('angle-end-liv_2')!)
    expect(byTestId('end-camera-angle')?.textContent).equals('Third Base')
    await cancelSheet('end-camera-sheet')
    expect(fake.acted).deep.equals([])

    fake.end = async () => {
      throw new HttpError('badRequest', 'Could not end it')
    }
    await press(byTestId('angle-end-liv_2')!)
    await pressId('end-camera-confirm')
    expect(text()).contains('Could not end it')
    fake.end = async () => stream()
    const listed = fake.listed
    await pressId('end-camera-confirm')
    await settle()
    expect(fake.acted).deep.equals(['end liv_2', 'end liv_2'])
    expect(fake.listed).equals(listed + 1)
  })

  it('warns before the delete button, then deletes the video, the upload and the copy', async function () {
    const fake = fakeClient()
    fake.mine = [
      stream({ id: 'liv_1', state: 'ended' }),
      stream({ id: 'liv_2', label: 'Live One', state: 'publishing' }),
      // Ended a moment ago: listed as ended, still publishing until the
      // ingest closes it, which the server's delete refuses.
      stream({
        id: 'liv_3',
        label: 'Closing',
        state: 'publishing',
        closesAt: '2026-05-20T16:30:00.000Z'
      })
    ]
    const native = holding(take({ uploadRunning: true }))
    await mount(fake, CAN_RECORD, native)
    expect(byTestId('angle-delete-liv_2')).equals(null)
    expect(byTestId('angle-delete-liv_3')).equals(null)

    await press(byTestId('angle-delete-liv_1')!)
    expect(text()).contains('deletes the video of')
    expect(text()).contains('cannot be undone')
    expect(byTestId('delete-video-angle')?.textContent).equals('Home Plate')
    await cancelSheet('delete-video-sheet')
    expect(fake.acted).deep.equals([])
    expect(called(native)).deep.equals([])

    // Refused: nothing on this phone goes.
    fake.discard = async () => {
      throw new HttpError('badRequest', 'That camera is still running')
    }
    await press(byTestId('angle-delete-liv_1')!)
    await pressId('delete-video-confirm')
    expect(text()).contains('That camera is still running')
    expect(called(native)).deep.equals([])

    fake.discard = async () => {}
    await pressId('delete-video-confirm')
    await settle()
    expect(fake.acted).deep.equals(['discard liv_1', 'discard liv_1'])
    expect(byTestId('angle-row-liv_1')).equals(null)
    expect(byTestId('upload-row-liv_1')).equals(null)
    expect(called(native)).deep.equals([
      'cancelUpload liv_1',
      'deleteRecording liv_1'
    ])
  })

  it('offers each detail only when it applies', async function () {
    const offers = async (
      row: Partial<LiveStream>,
      native: FakePhoneStreamModule
    ): Promise<string[]> => {
      const fake = fakeClient()
      fake.mine = [stream({ id: 'liv_1', state: 'ended', ...row })]
      await mount(fake, CAN_RECORD, native)
      await press(byTestId('angle-row-liv_1')!)
      const found = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid^="video-details-"]'
        )
      ].map(node => node.getAttribute('data-testid')!.slice(14))
      await act(async () => {
        root?.unmount()
      })
      document.body.textContent = ''
      return found
    }
    const base = ['sheet', 'angle', 'delete']
    expect(await offers({}, holding())).deep.equals(base)
    expect(await offers({ deviceId: null }, holding())).deep.equals(base)
    expect(await offers({ playableVideoId: 'vid_1' }, holding())).deep.equals([
      'sheet',
      'angle',
      'play',
      'delete'
    ])
    expect(await offers({}, holding(take()))).deep.equals([
      ...base,
      'upload',
      'delete-copy'
    ])
    expect(
      await offers({}, holding(take({ uploadedAt: 1_790_000_900_000 })))
    ).deep.equals([...base, 'delete-copy'])
    expect(
      await offers({}, holding(take({ uploadRunning: true })))
    ).deep.equals([...base, 'delete-copy'])
    expect(
      await offers(
        { state: 'publishing', closesAt: '2026-05-20T16:30:00.000Z' },
        holding()
      )
    ).deep.equals(['sheet', 'angle'])
  })

  it('plays, uploads and deletes from Video details', async function () {
    const fake = fakeClient()
    fake.mine = [
      stream({ id: 'liv_1', state: 'ended', playableVideoId: 'vid_1' })
    ]
    const native = holding(take())
    await mount(fake, CAN_RECORD, native)
    const details = async (): Promise<void> => {
      await press(byTestId('angle-row-liv_1')!)
      expect(byTestId('video-details-angle')?.textContent).equals('Home Plate')
    }

    await details()
    await pressId('video-details-play')
    await settle()
    expect(played).deep.equals(['vid_1'])
    expect(fake.added).deep.equals([])

    await details()
    await pressId('video-details-upload')
    await settle()
    expect(
      native.calls.filter(call => call.name === 'uploadRecording')
    ).lengthOf(1)

    // Cancel on the warning goes back to the details.
    await details()
    await pressId('video-details-delete')
    await settle()
    await cancelSheet('delete-video-sheet')
    expect(byTestId('video-details-sheet')).not.equals(null)
    await pressId('sheet-cancel')
    await settle()
    expect(byTestId('video-details-sheet')).equals(null)
    expect(fake.acted).deep.equals([])
  })

  it('deletes the local copy after asking, and tells the server', async function () {
    const fake = fakeClient()
    fake.mine = [
      stream({ id: 'liv_1', state: 'ended', localRecording: 'recorded' })
    ]
    const native = holding(take())
    await mount(fake, CAN_RECORD, native)
    await press(byTestId('angle-row-liv_1')!)
    await pressId('video-details-delete-copy')
    await settle()
    expect(text()).contains('deletes the copy of')
    await cancelSheet('delete-copy-sheet')
    expect(called(native)).deep.equals([])

    await pressId('video-details-delete-copy')
    await settle()
    native.answers.recordings = []
    fake.patch = async () => {
      throw new HttpError('badRequest', 'Offline')
    }
    await pressId('delete-copy-confirm')
    await settle()
    expect(called(native)).deep.equals([
      'cancelUpload liv_1',
      'deleteRecording liv_1'
    ])
    expect(fake.patched[0]).equals('liv_1 removed')
    expect(fake.acted).deep.equals([])
    // Back on the details, which no longer offer a copy.
    expect(byTestId('video-details-sheet')).not.equals(null)
    expect(byTestId('video-details-delete-copy')).equals(null)
  })

  it('shows a refused local delete in its sheet', async function () {
    const fake = fakeClient()
    fake.mine = [stream({ id: 'liv_1', state: 'ended' })]
    const native = holding(take())
    native.failures.deleteRecording = { code: 'stillRecording' }
    await mount(fake, CAN_RECORD, native)
    await press(byTestId('angle-row-liv_1')!)
    await pressId('video-details-delete-copy')
    await settle()
    await pressId('delete-copy-confirm')
    expect(byTestId('delete-copy-sheet')).not.equals(null)
    expect(fake.patched).deep.equals([])
  })

  it('deletes a take the list says was discarded, and no other, again after a refusal', async function () {
    const poll = heldPoll()
    try {
      const fake = fakeClient()
      fake.discarded = ['liv_1']
      fake.mine = [stream({ id: 'liv_2', state: 'ended' })]
      const native = holding(take(), take({ liveStreamId: 'liv_2' }))
      native.failures.deleteRecording = { code: 'uploadInProgress' }
      await mount(fake, CAN_RECORD, native)
      expect(byTestId('upload-row-liv_1')).equals(null)
      expect(byTestId('upload-row-liv_2')).not.equals(null)
      expect(called(native)).deep.equals([
        'cancelUpload liv_1',
        'deleteRecording liv_1'
      ])
      delete native.failures.deleteRecording
      native.calls.length = 0
      await poll.poll()
      expect(called(native)).deep.equals([
        'cancelUpload liv_1',
        'deleteRecording liv_1'
      ])
      expect(fake.acted).deep.equals([])
    } finally {
      poll.restore()
    }
  })

  it('asks the phone nothing more at each poll once no take is of a discarded camera', async function () {
    const poll = heldPoll()
    try {
      const reads = async (discarded: string[]): Promise<number> => {
        const fake = fakeClient()
        fake.discarded = discarded
        fake.mine = [stream({ id: 'liv_2', state: 'ended' })]
        const native = holding(take({ liveStreamId: 'liv_2' }))
        await mount(fake, CAN_RECORD, native)
        const before = native.calls.filter(
          call => call.name === 'recordings'
        ).length
        await poll.poll()
        await poll.poll()
        const after = native.calls.filter(
          call => call.name === 'recordings'
        ).length
        await act(async () => {
          root?.unmount()
        })
        expect(called(native)).deep.equals([])
        return after - before
      }
      expect(await reads(['liv_1'])).equals(await reads([]))
    } finally {
      poll.restore()
    }
  })

  it('says removed only for this phone’s own recorded row it holds no take of', async function () {
    const fake = fakeClient()
    fake.mine = [
      stream({ id: 'liv_1', localRecording: 'recorded' }),
      stream({ id: 'liv_2', localRecording: 'recorded' }),
      stream({ id: 'liv_3', localRecording: 'none' }),
      stream({ id: 'liv_4', localRecording: 'uploaded' }),
      stream({
        id: 'liv_5',
        localRecording: 'recorded',
        deviceId: OTHER_DEVICE
      })
    ]
    fake.others = [
      stream({ id: 'liv_6', localRecording: 'recorded', deviceId: undefined })
    ]
    const poll = heldPoll()
    try {
      await mount(fake, CAN_RECORD, holding(take({ liveStreamId: 'liv_2' })))
      expect(fake.patched).deep.equals(['liv_1 removed'])
      await poll.poll()
      expect(fake.patched).deep.equals(['liv_1 removed'])
    } finally {
      poll.restore()
    }
  })

  it('says nothing until the takes have been read', async function () {
    const fake = fakeClient()
    fake.mine = [stream({ id: 'liv_1', localRecording: 'recorded' })]
    const native = holding()
    native.failures.recordings = { code: 'notReady' }
    await mount(fake, CAN_RECORD, native)
    expect(fake.patched).deep.equals([])
  })

  it('trusts a read of the takes made after the list’s, and says it again after a failure', async function () {
    const poll = heldPoll()
    try {
      const fake = fakeClient()
      fake.mine = [stream({ id: 'liv_1', localRecording: 'recorded' })]
      // The hook's read predates the take; the read after the list finds it.
      const native = holding()
      const reads = { count: 0 }
      const recordings = native.recordings.bind(native)
      native.recordings = async () => {
        reads.count += 1
        native.answers.recordings = reads.count > 1 ? [take()] : []
        return await recordings()
      }
      await mount(fake, CAN_RECORD, native)
      expect(reads.count).greaterThan(1)
      expect(fake.patched).deep.equals([])

      // The take goes, and the first word fails.
      native.recordings = recordings
      native.answers.recordings = []
      fake.patch = async () => {
        throw new HttpError('badRequest', 'Offline')
      }
      await poll.poll()
      expect(fake.patched).deep.equals(['liv_1 removed'])
      fake.patch = async () => {}
      await poll.poll()
      expect(fake.patched).deep.equals(['liv_1 removed', 'liv_1 removed'])
      await poll.poll()
      expect(fake.patched).lengthOf(2)
    } finally {
      poll.restore()
    }
  })

  it('waits on iOS for Video details to leave before the warning comes up', async function () {
    const real = Platform.OS
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true })
    try {
      const fake = fakeClient()
      fake.mine = [stream({ id: 'liv_1', state: 'ended' })]
      await mount(fake)
      await press(byTestId('angle-row-liv_1')!)
      await pressId('video-details-delete')
      await settle()
      expect(byTestId('delete-video-confirm')).not.equals(null)
    } finally {
      Object.defineProperty(Platform, 'OS', {
        value: real,
        configurable: true
      })
    }
  })
})

describe('web camera management', function () {
  async function renderWeb(fake: FakeClient, hasVideo = false): Promise<void> {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <StreamFooter
            signedIn
            client={fake.client}
            gameId="gam_1"
            hasVideo={hasVideo}
            onPlay={id => played.push(id)}
          />
        </ThemeProvider>
      )
      await delay(10)
    })
  }
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    played.length = 0
    document.body.replaceChildren()
  })
  for (const role of ['viewer', 'pending', 'guest', 'nonmember', 'offline']) {
    it(`shows the appropriate empty state for a ${role}`, async function () {
      const fake = fakeClient()
      fake.access =
        role === 'guest' || role === 'offline'
          ? async () => {
              throw new HttpError(
                role === 'guest' ? 'unauthorized' : 'offline',
                'Cannot read'
              )
            }
          : access({
              canRequest: role === 'viewer' || role === 'pending',
              requested: role === 'pending'
            })
      await renderWeb(fake)
      expect(text()).contains('No videos')
      expect(byTestId('record-video')).equals(null)
      expect(fake.listed).equals(0)
      if (role === 'viewer') {
        await pressId('request-access')
        expect(fake.requests.length).equals(1)
        expect(text()).contains('Request sent')
      } else if (role === 'pending') expect(text()).contains('Request sent')
      else expect(byTestId('request-access')).equals(null)
    })
  }
  it('omits controls when a spectator has a video', async function () {
    const fake = fakeClient()
    fake.allowed = false
    await renderWeb(fake, true)
    expect(text()).equals('')
  })
  it('sets up an external camera and reopens and revokes the URL', async function () {
    const fake = fakeClient()
    await renderWeb(fake)
    expect(text()).contains('with an external camera')
    await pressId('record-video')
    expect(byTestId('record-with-phone')).equals(null)
    await pressId('angle-suggestion-Home')
    await pressId('use-external-camera')
    expect(text()).contains('Mevo Studio')
    await pressId('sheet-cancel')
    await toRtmp(fake)
    expect(text()).contains('HEVC')
    await pressId('rtmp-copy')
    expect(text()).contains('Copied')
    await pressId('rtmp-done')
    await pressId('angle-row-' + fake.mine[0].id)
    await pressId('rtmp-revoke')
    await press(button('Cancel'))
    expect(text()).contains('Stream using RTMP')
    await pressId('rtmp-revoke')
    await pressId('revoke-confirm')
    expect(fake.acted).includes('revoke ' + fake.mine[0].id)
  })
  it('uses the server’s game and personal limits and reports slots freed elsewhere', async function () {
    const fake = fakeClient()
    fake.gameCanAdd = 0
    fake.maxGameCameras = 7
    fake.canAdd = 0
    await renderWeb(fake, true)
    expect(text()).contains('7 cameras')
    await act(async () => {
      fake.gameCanAdd = 1
      document.dispatchEvent(new window.Event('visibilitychange'))
      await delay(10)
    })
    expect(text()).contains('4 cameras')
    await act(async () => {
      fake.canAdd = 1
      document.dispatchEvent(new window.Event('visibilitychange'))
      await delay(10)
    })
    expect(byTestId('record-video-limit')).equals(null)
  })
  for (const action of ['revoke', 'end', 'delete'] as const) {
    it(`keeps a newer sheet open when a dismissed ${action} finishes`, async function () {
      const fake = fakeClient()
      fake.mine = [
        stream({
          id: 'old',
          deviceId: action === 'end' ? DEVICE_ID : undefined,
          state: action === 'delete' ? 'ended' : 'idle',
          videoId: action === 'delete' ? 'vid_old' : null
        }),
        stream({ id: 'next', deviceId: undefined }),
        stream({ id: 'next-ended', state: 'ended', videoId: 'vid_next' })
      ]
      let finish!: () => void
      const pending = new Promise<void>(resolve => {
        finish = resolve
      })
      fake.end = async () => {
        await pending
        return stream()
      }
      fake.discard = async () => {
        await pending
      }
      await renderWeb(fake, true)
      if (action === 'revoke') {
        await pressId('angle-row-old')
        await pressId('rtmp-revoke')
      } else await pressId(`angle-${action}-old`)
      const confirmation =
        action === 'revoke'
          ? 'revoke'
          : action === 'end'
            ? 'end-camera'
            : 'delete-video'
      await pressId(`${confirmation}-confirm`)
      await press(
        byTestId(
          `${confirmation}-sheet`
        )!.parentElement!.querySelector<HTMLElement>('[aria-label="Cancel"]')!
      )
      if (action === 'revoke') await pressId('rtmp-done')
      if (action === 'revoke') {
        await pressId('record-video')
        await type('New angle')
      } else
        await pressId(`angle-row-${action === 'end' ? 'next' : 'next-ended'}`)
      const newer =
        action === 'revoke'
          ? 'angle-name-prompt'
          : action === 'end'
            ? 'rtmp-url-sheet'
            : 'video-details-sheet'
      expect(byTestId(newer)).not.equals(null)
      const reads = fake.listed
      await act(async () => {
        finish()
        await delay(20)
      })
      expect(byTestId(newer)).not.equals(null)
      expect(fake.listed).greaterThan(reads)
      if (action === 'revoke')
        expect(
          document.querySelector<HTMLInputElement>(
            'input[aria-label="Camera angle"]'
          )?.value
        ).equals('New angle')
    })
  }
  it('shows remote phone controls and diagnostic data and confirms ending the camera', async function () {
    const fake = fakeClient()
    fake.mine = [
      stream({
        id: 'phone',
        localRecording: 'recorded',
        status: {
          liveStreamId: 'phone',
          ingress: {
            receivingPackets: true,
            publishing: true,
            bytesReceived: 1024,
            bytesPerSecond: 750000
          },
          outputs: [
            {
              label: 'broadcast',
              kind: 'hls',
              state: 'connected',
              bytesWritten: 2048,
              bytesPerSecond: 500000,
              recordedSec: 12,
              restartCount: 1,
              lastError: 'Interrupted'
            }
          ]
        }
      })
    ]
    await renderWeb(fake)
    expect(text()).contains('Receiving 6.0 Mbit/s')
    expect(text()).contains('Interrupted')
    await press(button('Show stream URL'))
    expect(text()).contains('Stream using RTMP')
    await pressId('rtmp-done')
    await pressId('angle-end-phone')
    await pressId('end-camera-confirm')
    expect(fake.acted).includes('end phone')
    await pressId('angle-more-phone')
    await pressId('stream-action-rotate')
    expect(fake.acted).includes('rotate phone')
  })
  it('plays somebody else’s ended video, restricts their live camera and deletes only an own ended row', async function () {
    const fake = fakeClient()
    fake.mine = [
      stream({
        id: 'mine',
        state: 'ended',
        playableVideoId: 'v1',
        videoId: 'v1',
        durationSec: 120
      })
    ]
    fake.others = [
      stream({
        id: 'live',
        state: 'publishing',
        publishedAt: new Date().toISOString()
      }),
      stream({ id: 'ended', state: 'ended', playableVideoId: 'v2' })
    ]
    await renderWeb(fake, true)
    expect(text()).contains('Live')
    expect(text()).contains('0:02')
    await pressId('angle-more-live')
    expect(sheetActions()).deep.equals(['end'])
    await press(button('Cancel'))
    await pressId('angle-row-ended')
    await pressId('angle-row-mine')
    expect(byTestId('video-details-upload')).equals(null)
    await pressId('video-details-play')
    expect(played).deep.equals(['v2', 'v1'])
    await pressId('angle-delete-mine')
    await press(button('Cancel'))
    await pressId('angle-row-mine')
    await pressId('video-details-delete')
    await press(button('Cancel'))
    expect(byTestId('video-details-sheet')).not.equals(null)
    await pressId('video-details-delete')
    await pressId('delete-video-confirm')
    expect(byTestId('angle-row-mine')).equals(null)
    expect(fake.acted).includes('discard mine')
  })
  it('reports linked camera creation failures and allows another choice', async function () {
    const fake = fakeClient()
    fake.next = async () => {
      throw new Error('Game is full')
    }
    await renderWeb(fake)
    await toSources()
    await pressId('camera-source-mevo')
    expect(text()).contains('Game is full')
    expect(fake.added[0].device).deep.equals({ source: 'mevo' })
    await pressId('sheet-cancel')
    expect(byTestId('camera-source-sheet')).equals(null)
  })
  it('shows an operator’s last stream error even without ingest diagnostics', async function () {
    const fake = fakeClient()
    fake.mine = [stream({ status: null, lastError: 'Lost connection' })]
    await renderWeb(fake)
    expect(text()).contains('Lost connection')
  })
  it('keeps the created camera and shows the RTMP sheet if its address cannot form a maker link', async function () {
    const fake = fakeClient()
    const camera = stream({
      deviceId: undefined,
      source: 'mevo',
      url: 'invalid-address'
    })
    fake.next = async () => {
      fake.mine = [camera]
      return camera
    }
    await renderWeb(fake)
    await toSources()
    await pressId('camera-source-mevo')
    expect(text()).contains('Stream using RTMP')
    expect(fake.added.length).equals(1)
    await pressId('rtmp-done')
    expect(byTestId('angle-row-' + camera.id)).not.equals(null)
  })
  it('never navigates from an abandoned source setup when its server answer arrives', async function () {
    const fake = fakeClient()
    let finish: (camera: LiveStream) => void = () => {}
    let signal: AbortSignal | undefined
    fake.client.addLiveStream = async (_game, _name, _source, options) => {
      signal = options?.signal
      return await new Promise(resolve => {
        finish = resolve
      })
    }
    await renderWeb(fake)
    await toSources()
    await pressId('camera-source-gopro')
    await act(async () => {
      root!.unmount()
      root = undefined
    })
    expect(signal?.aborted).equals(true)
    await act(async () => {
      finish(stream())
      await delay(10)
    })
    expect(byTestId('camera-source-sheet')).equals(null)
  })
  it('discards a pending camera read when access is revoked', async function () {
    const fake = fakeClient()
    let finishRead: (rows: GameLiveStreams) => void = () => {}
    fake.client.liveStreams = async () =>
      await new Promise(resolve => {
        finishRead = resolve
      })
    await renderWeb(fake, true)
    fake.allowed = false
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'))
      await delay(10)
      finishRead({
        gameId: 'gam_1',
        mine: [stream()],
        others: [],
        maxCameras: 4,
        canAdd: 1,
        gameCanAdd: 1,
        maxGameCameras: 4,
        discarded: []
      })
      await delay(10)
    })
    expect(text()).equals('')
  })
})

describe('camera footer session boundary', () => {
  for (const Footer of [StreamFooter, NativeStreamFooter]) {
    it(`waits for a session before reading ${Footer === StreamFooter ? 'web' : 'native'} camera access`, async () => {
      const fake = fakeClient()
      const asked: string[] = []
      const access = fake.client.streamAccess.bind(fake.client)
      fake.client.streamAccess = async id => {
        asked.push(id)
        return await access(id)
      }
      const host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      const show = async (signedIn: boolean | null): Promise<void> => {
        await act(async () => {
          root!.render(
            <ThemeProvider>
              <Footer
                signedIn={signedIn}
                client={fake.client}
                gameId="gam_1"
                hasVideo={false}
              />
            </ThemeProvider>
          )
          await delay(30)
        })
      }
      await show(null)
      expect(host.textContent).equals('')
      await show(false)
      expect(host.textContent).contains('No videos')
      expect(asked).deep.equals([])
      await show(true)
      expect(asked).deep.equals(['gam_1'])
      await show(false)
      expect(host.textContent).not.contains('Record Video')
      expect(asked).deep.equals(['gam_1'])
    })
  }
})
