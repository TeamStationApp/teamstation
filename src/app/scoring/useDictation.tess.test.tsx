import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { keyterms, type ScoringAction } from '../../common/scoring/actions'
import {
  dictatingHealth,
  type FakeDictation,
  fakeDictation,
  type FakeDictationSocket
} from '../../test/dictationFakes'
import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import { useDictationControls } from './DictationButton'
import type { DictationControls } from './dictationControls'
import type {
  Dictation,
  DictationControlsProps,
  UseDictationOptions
} from './dictationTypes'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState } from './scoringMachine'
import { useDictation } from './useDictation'

let root: Root | undefined
let host: HTMLDivElement | undefined
async function render(element: React.ReactElement): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}
async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
}
afterEach(unmount)

const find = (label: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`)
async function pointer(type: 'pointerdown' | 'pointerup'): Promise<void> {
  await act(async () => {
    find('Dictation')!.dispatchEvent(
      new window.MouseEvent(type, { bubbles: true })
    )
  })
}
/** A press and its release: with `tapMs: 0`, a whole sentence. */
async function talk(): Promise<void> {
  await pointer('pointerdown')
  await pointer('pointerup')
}
async function opened(socket: FakeDictationSocket): Promise<void> {
  await act(async () => {
    socket.open()
  })
}
async function server(
  socket: FakeDictationSocket,
  reply: object
): Promise<void> {
  await act(async () => {
    socket.reply(reply)
  })
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** Tess's controls, mounted as her composer mounts them. */
function Tess(props: {
  fake: FakeDictation
  heard: string[]
  seen: { controls?: DictationControls }
}): React.ReactElement {
  const { fake, heard, seen } = props
  const controls = useDictationControls(tessOptions(fake, heard))
  seen.controls = controls
  return <>{controls.control}</>
}

/** The call Tess makes: no game, the `tess` scope, and Space left alone. */
function tessOptions(
  fake: FakeDictation,
  heard: string[]
): DictationControlsProps {
  return {
    scope: 'tess',
    target: {},
    contextOf: () => 'tess',
    onTranscript: text => {
      heard.push(text)
    },
    startEnabled: true,
    spaceTalks: false,
    shape: 'round',
    size: 56,
    health: dictatingHealth,
    url: 'ws://host/api/v1/dictation',
    token: 'tok_tess',
    openSocket: fake.openSocket,
    openMicrophone: fake.openMicrophone,
    tapMs: 0,
    tailMs: 0
  }
}

async function mountTess(fake = fakeDictation()): Promise<{
  fake: FakeDictation
  heard: string[]
  seen: { controls?: DictationControls }
  socket: FakeDictationSocket
}> {
  const heard: string[] = []
  const seen: { controls?: DictationControls } = {}
  await render(<Tess fake={fake} heard={heard} seen={seen} />)
  await settle()
  const socket = fake.socket()
  await opened(socket)
  return { fake, heard, seen, socket }
}

const starts = (socket: FakeDictationSocket): Array<Record<string, any>> =>
  socket.frames.filter(frame => frame.kind === 'start')

describe('dictation for Tess', function () {
  it('starts with no game, sends no key terms, and hands over the words', async function () {
    const { heard, seen, socket } = await mountTess()
    // Switched on at mount: the socket opened, and with no game, no terms.
    expect(socket.url).equals('ws://host/api/v1/dictation')
    expect(socket.frames).deep.equals([])
    expect(seen.controls?.enabled).equals(true)

    await talk()
    const [start] = starts(socket)
    expect(start).deep.equals({
      kind: 'start',
      id: start.id,
      scope: 'tess',
      target: {},
      context: 'tess',
      model: 'claude-haiku-5-5'
    })
    expect(start).not.have.property('tagOrder')
    expect(socket.frames.at(-1)).deep.equals({ kind: 'release', id: start.id })
    expect(seen.controls?.dictation.busy).equals(true)

    await server(socket, {
      kind: 'transcript',
      id: start.id,
      text: 'Where is the schedule?'
    })
    expect(heard).deep.equals(['Where is the schedule?'])
    expect(seen.controls?.dictation.busy).equals(false)
    expect(seen.controls?.dictation.message).equals(null)
    expect(find('Dictation status')?.textContent).equals('Push to talk')

    // The button takes the next hold at once.
    await talk()
    const second = starts(socket)[1]
    expect(second).deep.include({ scope: 'tess', context: 'tess' })
    expect(second.id).not.equal(start.id)
    await server(socket, {
      kind: 'transcript',
      id: second.id,
      text: 'And the roster?'
    })
    expect(heard).deep.equals(['Where is the schedule?', 'And the roster?'])
    expect(socket.frames.some(frame => frame.kind === 'keyterms')).equals(false)
  })

  it('leaves Space to the page beside the chat', async function () {
    const { socket } = await mountTess()
    const button = document.createElement('button')
    document.body.appendChild(button)
    const pressed: boolean[] = []
    for (const type of ['keydown', 'keyup'] as const) {
      const event = new window.KeyboardEvent(type, {
        key: ' ',
        code: 'Space',
        bubbles: true,
        cancelable: true
      })
      await act(async () => {
        button.dispatchEvent(event)
      })
      pressed.push(event.defaultPrevented)
    }
    button.remove()
    expect(pressed).deep.equals([false, false])
    expect(starts(socket)).deep.equals([])
  })

  it('waits for the reason when a hold heard nothing', async function () {
    const { heard, seen, socket } = await mountTess()
    await talk()
    const [start] = starts(socket)
    await server(socket, { kind: 'transcript', id: start.id, text: '  ' })
    expect(heard).deep.equals([])
    expect(seen.controls?.dictation.busy).equals(true)
    await server(socket, {
      kind: 'error',
      id: start.id,
      message: 'Nothing was heard'
    })
    expect(seen.controls?.dictation.busy).equals(false)
    expect(seen.controls?.dictation.message).equals('Nothing was heard')
    await talk()
    expect(starts(socket)).has.length(2)
  })

  it('switches on with each mount and off with each unmount', async function () {
    const fake = fakeDictation()
    const first = await mountTess(fake)
    expect(fake.microphone.opened).equals(1)
    await unmount()
    expect(first.socket.closed).equals(true)
    expect(fake.microphone.stopped).equals(1)

    // Reopened: a fresh mount is on again, and its first hold transcribes.
    const again = await mountTess(fake)
    expect(fake.sockets).has.length(2)
    expect(again.socket).not.equal(first.socket)
    expect(fake.microphone.opened).equals(2)
    await talk()
    const [start] = starts(again.socket)
    await server(again.socket, {
      kind: 'transcript',
      id: start.id,
      text: 'Show me the standings.'
    })
    expect(again.heard).deep.equals(['Show me the standings.'])
  })
})

/** The hook alone, for options no screen passes. */
function Probe(props: {
  options: UseDictationOptions
  seen: { dictation?: Dictation }
}): null {
  props.seen.dictation = useDictation(props.options)
  return null
}

describe('useDictation without Tess', function () {
  it('still sends a game its key terms, and its actions back', async function () {
    const fake = fakeDictation()
    const state = initialScoringState(scoringSession(gameFixture))
    const dictated: Array<{ transcript: string; actions: ScoringAction[] }> = []
    const seen: { dictation?: Dictation } = {}
    await render(
      <Probe
        seen={seen}
        options={{
          url: 'ws://host/api/v1/dictation',
          gameId: 'gam_1',
          session: state.session,
          log: state.log,
          onActions: (transcript, actions) => {
            dictated.push({ transcript, actions })
          },
          openSocket: fake.openSocket,
          openMicrophone: fake.openMicrophone,
          tailMs: 0
        }}
      />
    )
    await act(async () => {
      seen.dictation!.setEnabled(true)
    })
    const socket = fake.socket()
    await opened(socket)
    expect(socket.frames).deep.equals([
      { kind: 'keyterms', keyterms: keyterms(state.session) }
    ])
    await act(async () => {
      seen.dictation!.hold()
    })
    await act(async () => {
      seen.dictation!.release()
    })
    const [start] = starts(socket)
    expect(start).deep.include({
      scope: 'scoring',
      target: { gameId: 'gam_1' }
    })
    expect(start.tagOrder).deep.equals([...state.session.meta.tagOrder])
    // A transcript is only the words heard so far; the actions answer.
    await server(socket, { kind: 'transcript', id: start.id, text: 'Ball.' })
    expect(seen.dictation?.busy).equals(true)
    const ball = { type: 'pitch', call: 'B' }
    await server(socket, {
      kind: 'actions',
      id: start.id,
      transcript: 'Ball.',
      actions: [ball],
      dropped: []
    })
    expect(dictated).deep.equals([{ transcript: 'Ball.', actions: [ball] }])
    expect(seen.dictation?.busy).equals(false)
  })

  it('starts nothing for a hold with neither a game nor a context', async function () {
    const fake = fakeDictation()
    const seen: { dictation?: Dictation } = {}
    await render(
      <Probe
        seen={seen}
        options={{
          url: 'ws://host/api/v1/dictation',
          scope: 'tess',
          target: {},
          openSocket: fake.openSocket,
          openMicrophone: fake.openMicrophone
        }}
      />
    )
    await act(async () => {
      seen.dictation!.setEnabled(true)
    })
    const socket = fake.socket()
    await opened(socket)
    await act(async () => {
      seen.dictation!.hold()
    })
    expect(socket.frames).deep.equals([])
    expect(seen.dictation?.holding).equals(false)
  })
})
