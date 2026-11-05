import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'

import type { Health } from '../../common/api'
import {
  dictatingHealth,
  type FakeDictation,
  fakeDictation,
  type FakeDictationSocket
} from '../../test/dictationFakes'
import {
  byLabel,
  manualClock,
  render,
  settle,
  unmount
} from '../../test/tessTestKit'
import { pcmLevel } from '../scoring/dictationHook'
import { TessMicButton } from './TessMicButton'
import {
  PUSH_TO_TALK_MS,
  SPACE_HOLD_MS,
  type TessMicrophone,
  type TessMicrophoneOptions,
  useTessMicrophone
} from './useTessMicrophone'

/** The hook, with its button drawn as the composer draws it. */
function Mic(props: {
  options: TessMicrophoneOptions
  seen: { mic?: TessMicrophone }
}): React.ReactElement | null {
  const mic = useTessMicrophone(props.options)
  props.seen.mic = mic
  return mic.available ? <TessMicButton mic={mic} /> : null
}

// The hook reads the clock at a press and a release; each test sets it.
const realNow = Date.now
let now = 1000

interface Mounted {
  fake: FakeDictation
  heard: string[]
  seen: { mic?: TessMicrophone }
}

async function mount(
  overrides: Partial<TessMicrophoneOptions> = {}
): Promise<Mounted> {
  const fake = fakeDictation()
  const heard: string[] = []
  const seen: { mic?: TessMicrophone } = {}
  await render(
    <Mic
      seen={seen}
      options={{
        health: dictatingHealth,
        url: 'ws://192.0.2.10/api/v1/dictation',
        token: 'tok_tess_mic',
        onTranscript: text => {
          heard.push(text)
        },
        openSocket: fake.openSocket,
        openMicrophone: fake.openMicrophone,
        tailMs: 0,
        ...overrides
      }}
    />
  )
  await settle()
  return { fake, heard, seen }
}

const button = (): HTMLElement => byLabel('Dictate')

async function pointer(
  type: 'pointerdown' | 'pointerup' | 'pointercancel'
): Promise<void> {
  await act(async () => {
    button().dispatchEvent(new window.MouseEvent(type, { bubbles: true }))
  })
  await settle()
}

async function opened(socket: FakeDictationSocket): Promise<void> {
  await act(async () => {
    socket.open()
  })
}

async function reply(
  socket: FakeDictationSocket,
  frame: object
): Promise<void> {
  await act(async () => {
    socket.reply(frame)
  })
  await settle()
}

const starts = (socket: FakeDictationSocket): Array<Record<string, any>> =>
  socket.frames.filter(frame => frame.kind === 'start')

describe("Tess's microphone", function () {
  beforeEach(() => {
    now = 1000
    Date.now = () => now
  })
  afterEach(async () => {
    Date.now = realNow
    await unmount()
  })

  it('opens nothing until pressed, then a tap records until the next press', async function () {
    const { fake, heard, seen } = await mount()
    expect(button().getAttribute('aria-valuetext')).equals('Off')
    expect(fake.sockets).deep.equals([])
    expect(fake.microphone.opened).equals(0)

    await pointer('pointerdown')
    now += 100
    await pointer('pointerup')
    expect(seen.mic?.state).equals('opening')
    expect(fake.microphone.opened).equals(1)
    const socket = fake.socket()
    expect(socket.url).equals('ws://192.0.2.10/api/v1/dictation')
    // Heard since the microphone opened, before the socket did.
    const early = fake.speak([1000, -1000])
    await opened(socket)
    const [start] = starts(socket)
    expect(start).deep.equals({
      kind: 'start',
      id: start.id,
      scope: 'tess',
      target: {},
      context: 'tess',
      model: 'claude-haiku-5-5'
    })
    expect(socket.audio).deep.equals([early])
    expect(seen.mic?.state).equals('recording')
    expect(button().getAttribute('aria-valuetext')).equals('Recording')
    // A tap keeps it recording; the next press ends it.
    now += 3000
    const later = fake.speak([20, 20])
    expect(socket.audio).deep.equals([early, later])
    await pointer('pointerdown')
    expect(socket.frames.at(-1)).deep.equals({ kind: 'release', id: start.id })
    expect(seen.mic?.state).equals('transcribing')
    expect(button().getAttribute('aria-valuetext')).equals('Transcribing')
    // Its own release changes nothing; a press while it works is ignored.
    await pointer('pointerup')
    await pointer('pointerdown')
    await pointer('pointerup')
    expect(starts(socket)).has.length(1)
    expect(fake.microphone.stopped).equals(0)

    await reply(socket, {
      kind: 'transcript',
      id: start.id,
      text: 'Where is the schedule?'
    })
    expect(heard).deep.equals(['Where is the schedule?'])
    expect(seen.mic?.state).equals('idle')
    expect(fake.microphone.stopped).equals(1)
    expect(socket.closed).equals(true)
  })

  it(`records while a press held past ${PUSH_TO_TALK_MS} ms lasts`, async function () {
    const { fake, heard, seen } = await mount()
    await pointer('pointerdown')
    const socket = fake.socket()
    await opened(socket)
    expect(seen.mic?.state).equals('recording')
    now += PUSH_TO_TALK_MS
    await pointer('pointerup')
    const [start] = starts(socket)
    expect(socket.frames.at(-1)).deep.equals({ kind: 'release', id: start.id })
    expect(seen.mic?.state).equals('transcribing')
    await reply(socket, { kind: 'transcript', id: start.id, text: 'Hi' })
    expect(heard).deep.equals(['Hi'])
    // Opened again for the next press: a fresh socket and microphone.
    await pointer('pointerdown')
    expect(fake.sockets).has.length(2)
    expect(fake.microphone.opened).equals(2)
  })

  it('records the pre-roll of a hold let go before the socket connected', async function () {
    const { fake, seen } = await mount()
    await pointer('pointerdown')
    const socket = fake.socket()
    const said = [fake.speak([4000, -4000]), fake.speak([8000, -8000])]
    now += 800
    await pointer('pointerup')
    expect(seen.mic?.state).equals('opening')
    expect(socket.sent).deep.equals([])
    await opened(socket)
    const [start] = starts(socket)
    expect(socket.sent.slice(1, 3)).deep.equals(said)
    expect(socket.frames.at(-1)).deep.equals({ kind: 'release', id: start.id })
    expect(seen.mic?.state).equals('transcribing')
  })

  it('tells a tap from a hold by when the touch happened, not when it was handled', async function () {
    const { fake, seen } = await mount()
    // The finger is up 100 ms after it went down, but opening the
    // microphone holds the release back two seconds: still a tap.
    await pointer('pointerdown')
    now += 100
    const up = new window.MouseEvent('pointerup', { bubbles: true })
    now += 2000
    await act(async () => {
      button().dispatchEvent(up)
    })
    await settle()
    const tapped = fake.socket()
    await opened(tapped)
    expect(seen.mic?.state).equals('recording')
    expect(tapped.frames.filter(frame => frame.kind === 'release')).deep.equals(
      []
    )
    // The next press ends it.
    await pointer('pointerdown')
    await pointer('pointerup')
    expect(tapped.frames.at(-1)).deep.include({ kind: 'release' })
    await reply(tapped, {
      kind: 'transcript',
      id: starts(tapped)[0].id,
      text: 'Hi'
    })
    expect(seen.mic?.state).equals('idle')

    // Held 600 ms by its touches, though handled at once: a hold, which
    // ends as it is let go.
    await act(async () => {
      seen.mic?.press(50000)
    })
    await settle()
    const held = fake.socket()
    await opened(held)
    await act(async () => {
      seen.mic?.lift(50000 + PUSH_TO_TALK_MS + 100)
    })
    await settle()
    expect(held.frames.at(-1)).deep.include({ kind: 'release' })
    expect(seen.mic?.state).equals('transcribing')
    await reply(held, {
      kind: 'transcript',
      id: starts(held)[0].id,
      text: 'Hi'
    })

    // A press with no time of its own is timed by the clock, whatever its
    // release says.
    await act(async () => {
      seen.mic?.press()
    })
    await settle()
    const unstamped = fake.socket()
    await opened(unstamped)
    now += PUSH_TO_TALK_MS
    await act(async () => {
      seen.mic?.cancel(1)
    })
    await settle()
    expect(unstamped.frames.at(-1)).deep.include({ kind: 'release' })
    expect(seen.mic?.state).equals('transcribing')
  })

  it('closes the microphone quietly when nothing was heard', async function () {
    const { fake, heard, seen } = await mount()
    await pointer('pointerdown')
    const socket = fake.socket()
    await opened(socket)
    now += 1000
    await pointer('pointerup')
    const [start] = starts(socket)
    // Blank words wait for the reason.
    await reply(socket, { kind: 'transcript', id: start.id, text: ' ' })
    expect(seen.mic?.state).equals('transcribing')
    await reply(socket, {
      kind: 'error',
      id: start.id,
      message: 'Nothing was heard'
    })
    expect(heard).deep.equals([])
    expect(seen.mic?.state).equals('idle')
    // Nothing shows under the field, which would move it.
    expect(seen.mic?.message).equals(null)
    expect(fake.microphone.stopped).equals(1)
    await pointer('pointerdown')
    expect(seen.mic?.message).equals(null)
  })

  it('closes the microphone when the socket goes while recording', async function () {
    const { fake, seen } = await mount()
    await pointer('pointerdown')
    now += 100
    await pointer('pointerup')
    const socket = fake.socket()
    await opened(socket)
    expect(seen.mic?.state).equals('recording')
    await act(async () => {
      socket.close()
    })
    await settle()
    expect(seen.mic?.state).equals('idle')
    expect(fake.microphone.stopped).equals(1)
    expect(seen.mic?.message).not.equals(null)
    expect(fake.sockets).has.length(1)
  })

  it('closes when the microphone cannot open, and when pressed twice before connecting', async function () {
    const fake = fakeDictation()
    const { seen } = await mount({
      openSocket: fake.openSocket,
      openMicrophone: async () => {
        throw new Error('Permission denied')
      }
    })
    await pointer('pointerdown')
    await settle()
    expect(seen.mic?.state).equals('idle')
    expect(seen.mic?.message).equals(
      'The microphone is not available: Permission denied'
    )

    await unmount()
    const again = await mount()
    // A tap, then two more presses before the socket ever connects.
    await pointer('pointerdown')
    await pointer('pointerup')
    await pointer('pointerdown')
    await pointer('pointerup')
    expect(again.seen.mic?.state).equals('opening')
    await pointer('pointerdown')
    expect(again.seen.mic?.state).equals('idle')
    expect(again.fake.socket().closed).equals(true)
  })

  it('keeps a tap the phone took away recording, and toggles with Enter', async function () {
    const quick = await mount()
    // A finger that moves during a tap: the system takes the press, early.
    await pointer('pointerdown')
    await pointer('pointercancel')
    const tapped = quick.fake.socket()
    await opened(tapped)
    expect(quick.seen.mic?.state).equals('recording')
    // The next press ends it.
    await pointer('pointerdown')
    expect(tapped.frames.at(-1)).deep.include({ kind: 'release' })
    expect(quick.seen.mic?.state).equals('transcribing')
    await pointer('pointerup')
    await unmount()

    const { fake, seen } = await mount()
    await pointer('pointerdown')
    const socket = fake.socket()
    await opened(socket)
    // A hold the system takes away ends as its release would.
    now += 1000
    await pointer('pointercancel')
    expect(socket.frames.at(-1)).deep.include({ kind: 'release' })
    expect(seen.mic?.state).equals('transcribing')
    await reply(socket, {
      kind: 'transcript',
      id: starts(socket)[0].id,
      text: 'Hi'
    })
    const enter = async (): Promise<void> => {
      await act(async () => {
        button().dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
        )
      })
      await settle()
    }
    await enter()
    expect(seen.mic?.state).equals('opening')
    await opened(fake.socket())
    expect(seen.mic?.state).equals('recording')
    await enter()
    expect(seen.mic?.state).equals('transcribing')
    // A cancel with no press under way does nothing.
    await pointer('pointercancel')
    expect(seen.mic?.state).equals('transcribing')
  })

  it('hands the level of each frame to whoever listens, while it is open', async function () {
    const { fake, seen } = await mount()
    const levels: number[] = []
    const unsubscribe = seen.mic!.levels.subscribe(level => levels.push(level))
    await pointer('pointerdown')
    const loud = fake.speak([16384, -16384, 16384, -16384])
    fake.speak([])
    expect(levels).deep.equals([pcmLevel(loud), 0])
    expect(levels[0]).closeTo(0.5, 1e-9)
    unsubscribe()
    fake.speak([100])
    expect(levels).has.length(2)
  })

  it('shows the button once the server says it dictates, asking again until it answers', async function () {
    const clock = manualClock(1000)
    let asked = 0
    try {
      const { seen } = await mount({
        health: async (): Promise<Health> => {
          asked += 1
          if (asked === 1) throw new Error('offline')
          return await dictatingHealth()
        }
      })
      expect(seen.mic?.available).equals(false)
      await clock.advance(1000)
      await settle()
      expect(asked).equals(2)
      expect(seen.mic?.available).equals(true)
    } finally {
      clock.restore()
    }
  })

  it(`records while Space is held ${SPACE_HOLD_MS} ms, and only then`, async function () {
    const clock = manualClock(SPACE_HOLD_MS)
    try {
      const { fake, heard, seen } = await mount()
      const space = async (type: 'keydown' | 'keyup'): Promise<boolean> => {
        const event = new window.KeyboardEvent(type, {
          key: ' ',
          bubbles: true,
          cancelable: true
        })
        await act(async () => {
          document.body.dispatchEvent(event)
        })
        return event.defaultPrevented
      }
      await space('keydown')
      await clock.advance(SPACE_HOLD_MS - 1)
      expect(fake.sockets).deep.equals([])
      await clock.advance(1)
      expect(seen.mic?.state).equals('opening')
      const socket = fake.socket()
      await opened(socket)
      expect(starts(socket)).has.length(1)
      expect(await space('keyup')).equals(true)
      const [start] = starts(socket)
      expect(socket.frames.at(-1)).deep.equals({
        kind: 'release',
        id: start.id
      })
      await reply(socket, { kind: 'transcript', id: start.id, text: 'Hi' })
      expect(heard).deep.equals(['Hi'])
      // While a tap records, a held Space is the page's.
      await pointer('pointerdown')
      await pointer('pointerup')
      await space('keydown')
      await clock.advance(SPACE_HOLD_MS)
      await space('keyup')
      expect(seen.mic?.state).equals('opening')
      expect(fake.sockets).has.length(2)
    } finally {
      clock.restore()
    }
  })
})
