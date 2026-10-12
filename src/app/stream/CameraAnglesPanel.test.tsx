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
import { fakePhoneStreamModule } from './fakePhoneStreamModule'
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
  allowed: boolean
  next: () => Promise<LiveStream>
  reveal: () => Promise<LiveStream>
}

function fakeClient(): FakeClient {
  const fake: FakeClient = {
    added: [],
    revealed: [],
    allowed: true,
    next: async () => stream(),
    reveal: async () => stream(),
    client: undefined as unknown as TeamStationClient
  }
  fake.client = {
    baseUrl: 'https://teamstation.example.test/api/v1',
    token: 'token-0000',
    liveStreams: async (gameId: string): Promise<GameLiveStreams> => {
      if (!fake.allowed) throw new HttpError('notFound', 'Not found')
      return { gameId, mine: [], others: [], canAdd: 4, maxCameras: 4 }
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
  capabilities: unknown = { supported: true, deviceModel: 'iPhone 13 Pro' }
): Promise<void> {
  const native = fakePhoneStreamModule({ capabilities })
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
