import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  DeviceStreamOptions,
  GameLiveStreams,
  LiveStream,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { ThemeProvider } from '../theme/ThemeContext'
import { angleNameProblem, angleNameToSend } from './AngleNamePrompt'
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
    userId: 7,
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
  added: Array<{ gameId: string; label?: string; device?: DeviceStreamOptions }>
  revealed: string[]
  /** Every action on a camera, as `<call> <stream id>`. */
  acted: string[]
  /** How many times the game's cameras were read. */
  listed: number
  allowed: boolean
  mine: LiveStream[]
  others: LiveStream[]
  next: () => Promise<LiveStream>
  reveal: () => Promise<LiveStream>
}

function fakeClient(): FakeClient {
  const fake: FakeClient = {
    added: [],
    revealed: [],
    acted: [],
    listed: 0,
    allowed: true,
    mine: [],
    others: [],
    next: async () => stream(),
    reveal: async () => stream(),
    client: undefined as unknown as TeamStationClient
  }
  const acting =
    (name: string) =>
    async (_gameId: string, id: string): Promise<LiveStream> => {
      fake.acted.push(`${name} ${id}`)
      return stream({ id })
    }
  fake.client = {
    baseUrl: 'https://teamstation.example.test/api/v1',
    token: 'token-0000',
    liveStreams: async (gameId: string): Promise<GameLiveStreams> => {
      fake.listed += 1
      if (!fake.allowed) throw new HttpError('notFound', 'Not found')
      return {
        gameId,
        mine: fake.mine,
        others: fake.others,
        canAdd: 4,
        maxCameras: 4
      }
    },
    rotateLiveStream: acting('rotate'),
    endLiveStream: acting('end'),
    removeLiveStream: acting('remove'),
    deleteVideo: async (videoId: string) => {
      fake.acted.push(`deleteVideo ${videoId}`)
      return { id: videoId, removedFromSpace: 0 }
    },
    addLiveStream: async (
      gameId: string,
      label?: string,
      device?: DeviceStreamOptions
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
  capabilities: unknown = { supported: true, deviceModel: 'iPhone 13 Pro' },
  native: FakePhoneStreamModule = fakePhoneStreamModule({ capabilities }),
  copied: string[] = []
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
  ].find(node => (node.textContent ?? '').endsWith(words))
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

describe('Record video on a phone', function () {
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
  })

  it('is hidden on a phone that cannot record, and from anybody who may not film', async function () {
    await mount(fakeClient(), { supported: false, deviceModel: '' })
    expect(text()).equals('')
    await act(async () => {
      root?.unmount()
    })
    const refused = fakeClient()
    refused.allowed = false
    await mount(refused)
    expect(text()).equals('')
  })

  it('asks for the angle’s name, shows a 409 inline, then opens the camera on its stream', async function () {
    const fake = fakeClient()
    await mount(fake)
    expect(text()).contains('CAMERAS')
    await press(button('Record video'))
    expect(text()).contains('Name this camera angle')
    expect(
      document
        .querySelector('input[aria-label="Camera angle"]')
        ?.getAttribute('placeholder')
    ).equals('Home Plate')
    // Held sideways, an Android phone edits the name in place.
    expect(
      fieldProps(document.querySelector('input[aria-label="Camera angle"]'))
        .disableFullscreenUI
    ).equals(true)
    // Nothing to send yet: Start waits.
    await press(button('Start'))
    expect(fake.added).deep.equals([])
    await type('Home — Plate')
    expect(text()).contains('A camera name cannot contain " — ".')
    await press(button('Start'))
    expect(fake.added).deep.equals([])

    fake.next = async () => {
      throw new HttpError(
        'conflict',
        'You already have a camera called Home Plate on this game'
      )
    }
    await type('Home Plate')
    await press(button('Start'))
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
    await press(button('Start'))
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
    await press(button('Record video'))
    await type('First Base')
    await press(button('Start'))
    expect(fake.revealed).deep.equals(['liv_00000000000000000001'])
    expect(text()).contains('Try again')
    fake.reveal = async () =>
      stream({ url: 'rtmp://ingest.example.test:1936/live/ts_revealed' })
    await press(button('Start'))
    expect(opened.at(-1)?.session.url).equals(
      'rtmp://ingest.example.test:1936/live/ts_revealed'
    )
  })

  it('opens empty again, and Cancel leaves without asking the server', async function () {
    const fake = fakeClient()
    await mount(fake)
    await press(button('Record video'))
    await type('Left Field')
    await press(button('Cancel'))
    await settle()
    expect(text()).not.contains('Name this camera angle')
    await press(button('Record video'))
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
          <StreamFooter client={fake.client} gameId="gam_1" />
        </ThemeProvider>
      )
      await delay(20)
    })
    expect(host.textContent).contains('STREAM TO THIS GAME')
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <NativeStreamFooter client={fake.client} gameId="gam_1" />
        </ThemeProvider>
      )
      await delay(20)
    })
    // The browser's own engine stub cannot record, so the phone's panel is empty here.
    expect(host.textContent).equals('')
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
      expect(text()).contains('Record video')

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
          recordsLocally: true
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
      capabilities: { supported: true, deviceModel: 'iPhone 13 Pro' },
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
      capabilities: { supported: true, deviceModel: 'iPhone 13 Pro' },
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
      capabilities: { supported: true, deviceModel: 'iPhone 13 Pro' },
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
      capabilities: { supported: true, deviceModel: 'iPhone 13 Pro' },
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

  it('keeps an uploading angle closed, and Record video under its name says so', async function () {
    const native = fakePhoneStreamModule({
      capabilities: { supported: true, deviceModel: 'iPhone 13 Pro' },
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

    await press(button('Record video'))
    await type('home plate')
    await press(button('Start'))
    expect(text()).contains('home plate is still uploading')
    expect(fake.added).deep.equals([])
  })

  it('starts a running upload’s row where the engine says it stands, then follows its reports', async function () {
    // Resumed at launch, the upload reported before this panel listened: its
    // row read 0% until the next report, which came only as a part landed.
    const native = fakePhoneStreamModule({
      capabilities: { supported: true, deviceModel: 'iPhone 13 Pro' },
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
      capabilities: { supported: true, deviceModel: 'iPhone 13 Pro' },
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

  it('shows the cameras without Record video on a phone that cannot record', async function () {
    const fake = fakeClient()
    fake.others = [stream({ id: 'liv_4', label: 'Center Field' })]
    await mount(fake, { supported: false, deviceModel: '' })
    expect(byTestId('angle-row-liv_4')).not.equals(null)
    expect(text()).not.contains('Record video')
  })
})
