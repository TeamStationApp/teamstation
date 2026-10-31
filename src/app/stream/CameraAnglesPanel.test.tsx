import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
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
import {
  type FakePhoneStreamModule,
  fakePhoneStreamModule,
  RECORDING
} from './fakePhoneStreamModule'
import { makePhoneStream } from './phoneStreamClient'
import { StreamFooter } from './StreamFooter'
import { StreamFooter as NativeStreamFooter } from './StreamFooter.native'
import type { StreamingScreenProps } from './StreamingScreen.native'

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
    gameCanAdd: 6,
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
        discarded: []
      }
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
function FakeScreen(props: StreamingScreenProps): React.ReactElement {
  opened.push(props)
  return (
    <button type="button" data-testid="fake-screen" onClick={props.onClose}>
      {props.session.angleName}
    </button>
  )
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
  hasVideo = true
): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <CameraAnglesPanel
          client={fake.client}
          gameId="gam_1"
          phone={makePhoneStream(native)}
          deviceId={async () => DEVICE_ID}
          Screen={FakeScreen as never}
          copy={text => copied.push(text)}
          hasVideo={hasVideo}
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

  it('keeps the stream-URL panel in a browser, and the cameras panel on a phone', async function () {
    const fake = fakeClient()
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <StreamFooter client={fake.client} gameId="gam_1" hasVideo />
        </ThemeProvider>
      )
      await delay(20)
    })
    expect(host.textContent).contains('STREAM TO THIS GAME')
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <NativeStreamFooter
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

  it('lists every angle with its device, owner and state, and reads them again every five seconds', async function () {
    const poll = heldPoll()
    try {
      const fake = fakeClient()
      fake.mine = [
        stream({ id: 'liv_1', label: 'Home Plate', state: 'publishing' }),
        stream({
          id: 'liv_2',
          label: 'First Base',
          deviceModel: 'Pixel 10',
          deviceId: OTHER_DEVICE,
          localRecording: 'recorded',
          closesAt: '2026-05-20T17:00:00.000Z'
        }),
        stream({
          id: 'liv_3',
          label: 'Bullpen',
          deviceModel: null,
          deviceId: null,
          state: 'ended'
        })
      ]
      fake.others = [
        stream({
          id: 'liv_4',
          label: 'Center Field',
          ownerName: 'Shohei Ohtani',
          deviceModel: 'iPad Pro',
          deviceId: undefined
        })
      ]
      await mount(fake)
      expect(byTestId('angle-row-liv_1')?.textContent).equals(
        'Home PlateiPhone 13 ProLive'
      )
      expect(byTestId('angle-row-liv_2')?.textContent).equals(
        'First BasePixel 10Recording on Pixel 10 not uploadedEnded'
      )
      expect(byTestId('angle-row-liv_3')?.textContent).equals('BullpenEnded')
      expect(byTestId('angle-row-liv_4')?.textContent).equals(
        'Center FieldiPad Pro · Shohei OhtaniIdle'
      )
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
    fake.mine = [
      stream({ id: 'liv_2', slot: 2, label: 'Camera 2' }),
      stream({ id: 'liv_3', label: 'Bullpen', state: 'ended' })
    ]
    fake.next = async () => stream({ id: 'liv_2', slot: 2, label: 'Camera 2' })
    await mount(fake)
    await press(byTestId('angle-row-liv_2')!)
    expect(
      (fake.added.at(-1)?.device as DeviceStreamOptions).heldStreamId
    ).equals('liv_2')
    expect(opened.at(-1)?.session.streamId).equals('liv_2')
    await press(byTestId('fake-screen')!)

    // An ended camera is not held any more: tapping it starts it afresh.
    fake.next = async () => stream({ id: 'liv_5', label: 'Bullpen' })
    await press(byTestId('angle-row-liv_3')!)
    expect(fake.added.at(-1)?.label).equals('Bullpen')
    expect(
      (fake.added.at(-1)?.device as DeviceStreamOptions).heldStreamId
    ).equals(undefined)
  })

  it('offers on each camera exactly what the web panel offers', async function () {
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
    expect(await offered('liv_1')).deep.equals([
      'reveal',
      'rotate',
      'end',
      'remove'
    ])
    expect(await offered('liv_2')).deep.equals(['reveal', 'rotate', 'end'])
    expect(await offered('liv_3')).deep.equals([
      'reveal',
      'rotate',
      'deleteVideo',
      'remove'
    ])
    expect(await offered('liv_4')).deep.equals(['end'])
    expect(byTestId('angle-more-liv_5')).equals(null)
    await press(byTestId('angle-more-liv_1')!)
    expect(text()).contains('Copy stream URL')
    expect(text()).contains('Rotate key')
    expect(text()).contains('End')
    expect(text()).contains('Remove')
  })

  it('copies the URL, and acts at once off the air but asks twice on it', async function () {
    const fake = fakeClient()
    fake.mine = [
      stream({ id: 'liv_1', label: 'Home Plate', url: undefined }),
      stream({ id: 'liv_2', label: 'Live One', state: 'publishing' })
    ]
    fake.reveal = async () =>
      stream({ id: 'liv_1', url: 'rtmp://ingest.example.test/live/ts_1' })
    const copied: string[] = []
    await mount(fake, undefined, undefined, copied)

    await press(byTestId('angle-more-liv_1')!)
    await press(byTestId('stream-action-reveal')!)
    await settle()
    expect(copied).deep.equals(['rtmp://ingest.example.test/live/ts_1'])
    expect(text()).contains('Copied the stream URL for Home Plate')
    expect(sheetActions()).deep.equals([])

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

    // A failure stays in the sheet.
    fake.reveal = async () => stream({ id: 'liv_1', url: undefined })
    await press(byTestId('angle-more-liv_1')!)
    await press(byTestId('stream-action-reveal')!)
    expect(text()).contains('This camera has no URL to copy')
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
    expect(opened.at(-1)?.startOnOpen).equals(undefined)
  })

  for (const [row, source] of [
    ['GoPro', 'gopro'],
    ['Mevo', 'mevo'],
    ['Mevo Studio', 'mevoStudio'],
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
      expect(text()).contains(
        'You may now return to the app and stream to the RTMP URL at any time.'
      )
    })
  }

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

  it('says why a camera was refused, with no Revoke', async function () {
    const fake = fakeClient()
    fake.next = async () => {
      throw new HttpError('conflict', 'This game already has 6 cameras.')
    }
    await mount(fake)
    await toSources()
    await pressId('camera-source-rtmp')
    expect(text()).contains('This game already has 6 cameras.')
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
    await mount(full)
    expect(byTestId('record-video-limit')?.textContent).equals(
      'This game already has 6 cameras. End one to add another.'
    )
    await pressId('record-video')
    expect(text()).not.contains('Name this camera angle')
  })
})
