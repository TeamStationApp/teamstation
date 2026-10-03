import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { Health } from '../../common/api'
import {
  keyterms,
  promptContext,
  type ScoringAction
} from '../../common/scoring/actions'
import { completeMotions } from '../../test/scoringHelpers'
import { ThemeProvider } from '../theme/ThemeContext'
import { createDevelopmentSession } from './developmentSession'
import { useDictationControls } from './DictationButton'
import type { DictationButtonProps, DictationSocket } from './dictationTypes'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import type { ScoringState } from './scoringTypes'
import { dictationContext, dictationUrl, upcoming } from './useDictation'

class FakeSocket implements DictationSocket {
  readyState = 0
  binaryType = ''
  sent: Array<string | ArrayBuffer> = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {}
  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
    this.onclose?.()
  }

  get frames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((f): f is string => typeof f === 'string')
      .map(f => JSON.parse(f) as Record<string, unknown>)
  }

  get audio(): ArrayBuffer[] {
    return this.sent.filter((f): f is ArrayBuffer => f instanceof ArrayBuffer)
  }
}

let root: Root | undefined
let host: HTMLDivElement
async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
}
afterEach(unmount)

interface Harness {
  sockets: FakeSocket[]
  socket: () => FakeSocket
  dictated: Array<{
    transcript: string
    actions: ScoringAction[]
    undo?: boolean
  }>
  microphone: {
    pcm?: (pcm: ArrayBuffer) => void
    fail?: (message: string) => void
    stopped: boolean
    opened: number
  }
  render: (more?: Partial<DictationButtonProps>) => Promise<void>
  props: DictationButtonProps
}

const healthy = async (): Promise<Health> => ({
  status: 'ok',
  version: '1',
  database: 'ok',
  migrations: 1,
  dictation: true,
  dictationModels: ['grok-4.3']
})

function fresh(): ScoringState {
  return initialScoringState(createDevelopmentSession(gameFixture, [], []))
}

function harness(
  state = fresh(),
  more: Partial<DictationButtonProps> = {}
): Harness {
  const sockets: FakeSocket[] = []
  const dictated: Harness['dictated'] = []
  const microphone: Harness['microphone'] = { stopped: false, opened: 0 }
  const props: DictationButtonProps = {
    health: healthy,
    url: 'ws://host/api/v1/dictation',
    gameId: 'gam_1',
    session: state.session,
    log: state.log,
    onActions: (transcript, actions, undo) => {
      dictated.push({ transcript, actions, ...(undo === true ? { undo } : {}) })
    },
    openSocket: url => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    // A press of any length is a hold here, and a release ends it at once;
    // the tap, tail and linger tests set their own.
    tapMs: 0,
    tailMs: 0,
    openMicrophone: async (onPcm, onEnded) => {
      microphone.pcm = onPcm
      microphone.fail = onEnded
      microphone.opened++
      return {
        stop: () => {
          microphone.stopped = true
        }
      }
    },
    ...more
  }
  const self: Harness = {
    sockets,
    socket: () => sockets[sockets.length - 1],
    dictated,
    microphone,
    props,
    render: async extra => {
      Object.assign(self.props, extra)
      if (root == null) {
        host = document.createElement('div')
        document.body.appendChild(host)
        root = createRoot(host)
      }
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <Controls {...self.props} />
          </ThemeProvider>
        )
      })
    }
  }
  return self
}

/** The two pieces, rendered side by side the way the screen places them. */
function Controls(props: DictationButtonProps): React.ReactElement {
  const { control, log } = useDictationControls(props)
  return (
    <>
      {log}
      {control}
    </>
  )
}

function find(label: string): HTMLElement | null {
  // A question is a modal, drawn over the page rather than in the host.
  return document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`)
}
async function press(label: string): Promise<void> {
  await act(async () => {
    find(label)!.click()
  })
}
async function pointer(type: 'pointerdown' | 'pointerup'): Promise<void> {
  await act(async () => {
    find('Dictation')!.dispatchEvent(
      new window.MouseEvent(type, { bubbles: true })
    )
  })
}
async function server(socket: FakeSocket, reply: object): Promise<void> {
  await act(async () => {
    socket.onmessage?.({ data: JSON.stringify(reply) })
  })
}
async function opened(socket: FakeSocket): Promise<void> {
  await act(async () => {
    socket.readyState = 1
    socket.onopen?.()
  })
}
/** A quick press on the microphone button: it switches dictation on or off. */
async function tap(): Promise<void> {
  await pointer('pointerdown')
  await pointer('pointerup')
}
async function enable(h: Harness): Promise<FakeSocket> {
  await tap()
  const socket = h.socket()
  await opened(socket)
  return socket
}
function pcm(bytes: number): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}
const text = (label: string): string | null => find(label)?.textContent ?? null

describe('the dictation control', function () {
  it('shows only when the server takes dictation', async function () {
    const off = harness(fresh(), {
      health: async () => ({ ...(await healthy()), dictation: false })
    })
    await off.render()
    expect(find('Dictation')).equals(null)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    const failing = harness(fresh(), {
      health: async () => await Promise.reject(new Error('down'))
    })
    await failing.render()
    expect(find('Dictation')).equals(null)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    const on = harness()
    await on.render()
    expect(find('Dictation')).not.equal(null)
    expect(text('Dictation status')).not.equal('Push to talk')
    expect(on.sockets).to.have.length(0)
    expect(on.microphone.opened).equals(0)
  })

  it('opens the socket and the microphone when switched on, key terms first', async function () {
    const h = harness(fresh(), { tapMs: 5000 })
    await h.render()
    const socket = await enable(h)
    expect(socket.url).equals('ws://host/api/v1/dictation')
    expect(socket.binaryType).equals('arraybuffer')
    expect(h.microphone.opened).equals(1)
    expect(socket.frames).deep.equals([
      { kind: 'keyterms', keyterms: keyterms(h.props.session) }
    ])
    expect(text('Dictation status')).equals('Push to talk')
    expect(find('Dictation')?.getAttribute('aria-pressed')).equals('true')

    await tap()
    expect(socket.closed).equals(true)
    expect(h.microphone.stopped).equals(true)
    expect(text('Dictation status')).not.equal('Push to talk')
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(h.sockets).to.have.length(1)
  })

  it('retargets on a new at-bat and a lineup change, and on nothing else', async function () {
    let state = fresh()
    const h = harness(state)
    await h.render()
    const socket = await enable(h)
    const sent = (): number =>
      socket.frames.filter(f => f.kind === 'keyterms').length
    const show = async (next: ScoringState): Promise<void> => {
      state = completeMotions(next)
      await h.render({ session: state.session, log: state.log })
    }
    // A pitch changes neither the at-bat nor who is in the game.
    await show(scoringReducer(state, { type: 'PITCH', kind: 'ball' }))
    expect(sent()).equals(1)
    // A lineup action whose names are the same sends nothing.
    await show(
      scoringReducer(state, {
        type: 'DICTATED',
        transcript: 'batting left',
        actions: [{ type: 'lineup', kind: 'batterSide', batSide: 'L' }]
      })
    )
    expect(sent()).equals(1)
    // Four balls, and the next pitch brings a new at-bat.
    for (let n = 0; n < 3; n++)
      await show(scoringReducer(state, { type: 'PITCH', kind: 'ball' }))
    await show(
      scoringReducer(state, {
        type: 'DICTATED',
        transcript: 'ball',
        actions: [{ type: 'pitch', call: 'B' }]
      })
    )
    expect(state.session.liveData.plays.currentPlay?.about.atBatIndex).equals(1)
    expect(sent()).equals(2)
    expect(socket.frames.at(-1)).deep.equals({
      kind: 'keyterms',
      keyterms: keyterms(state.session)
    })
    // A steal moves a name between bases and adds none.
    await show(
      scoringReducer(state, {
        type: 'DICTATED',
        transcript: 'steals second',
        actions: [{ type: 'baseRunning', kind: 'steal', runner: 1, to: '2B' }]
      })
    )
    expect(state.session.liveData.linescore.offense.second?.id).equals(1)
    expect(sent()).equals(2)
  })

  it('describes the next at-bat once the play before is decided', async function () {
    const state = completeMotions(
      scoringReducer(fresh(), {
        type: 'DICTATED',
        transcript: 'single to center',
        actions: [
          { type: 'ballInPlay', contact: 'swing', fielder: 17 },
          { type: 'result', eventType: 'single' }
        ]
      })
    )
    // The single is decided but still open for correction.
    expect(state.session.liveData.plays.currentPlay?.about.atBatIndex).equals(0)
    const h = harness(state)
    await h.render()
    const socket = await enable(h)
    const next = upcoming(state.session)
    expect(next.closed).equals('Single')
    expect(next.state.liveData.plays.currentPlay?.about.atBatIndex).equals(1)
    expect(socket.frames[0]).deep.equals({
      kind: 'keyterms',
      keyterms: keyterms(next.state)
    })
    await pointer('pointerdown')
    const context = socket.frames.at(-1)!.context as string
    expect(context).equals(dictationContext(state.session))
    expect(context).match(/^The last play \(Single\) is decided/)
    expect(context).includes(promptContext(next.state))
    expect(context).includes('count 0-0')
    // An undecided play is described as it is.
    expect(dictationContext(fresh().session)).equals(
      promptContext(fresh().session)
    )
  })

  it('names the model the scorer picked in the start', async function () {
    const h = harness(fresh(), { model: 'grok-4.3' })
    await h.render()
    const socket = await enable(h)
    await pointer('pointerdown')
    expect(socket.frames.at(-1)).deep.include({
      kind: 'start',
      model: 'grok-4.3'
    })
    await pointer('pointerup')
  })

  it('falls back from a picked model this server does not offer', async function () {
    const h = harness(fresh(), { model: 'gpt-6-luna' })
    await h.render()
    const socket = await enable(h)
    await pointer('pointerdown')
    // The server offers neither it nor the default, so its first model
    // stands in.
    expect(socket.frames.at(-1)).deep.include({
      kind: 'start',
      model: 'grok-4.3'
    })
    await pointer('pointerup')
  })

  it('names the default model when the scorer picked none, as settings show it', async function () {
    const h = harness(fresh(), {
      health: async () => ({
        ...(await healthy()),
        dictationModels: ['grok-4.3', 'claude-haiku-4-5-20251001']
      })
    })
    await h.render()
    const socket = await enable(h)
    await pointer('pointerdown')
    expect(socket.frames.at(-1)).deep.include({
      kind: 'start',
      model: 'claude-haiku-4-5-20251001'
    })
    await pointer('pointerup')
  })

  it('sends a hold as a start with the game, then audio, then a release', async function () {
    const h = harness()
    await h.render()
    const socket = await enable(h)
    h.microphone.pcm!(pcm(4))
    expect(socket.audio).to.have.length(0)
    await pointer('pointerdown')
    const start = socket.frames.at(-1)!
    // The frame in hand as the press began leads the words.
    expect(socket.audio.map(b => b.byteLength)).deep.equals([4])
    expect(start).deep.include({
      kind: 'start',
      scope: 'scoring',
      target: { gameId: 'gam_1' },
      context: promptContext(h.props.session)
    })
    expect(start.id).is.a('string')
    expect(text('Dictation status')).equals('Listening…')
    h.microphone.pcm!(pcm(6))
    h.microphone.pcm!(pcm(8))
    expect(socket.audio.map(b => b.byteLength)).deep.equals([4, 6, 8])
    await server(socket, { kind: 'partial', id: start.id, text: 'Noah sin' })
    expect(text('Dictated text')).equals('Noah sin')
    await pointer('pointerup')
    expect(socket.frames.at(-1)).deep.equals({ kind: 'release', id: start.id })
    expect(text('Dictation status')).not.equal('Push to talk')
    h.microphone.pcm!(pcm(2))
    expect(socket.audio).to.have.length(3)
    // A second hold while the first is answered does nothing.
    await pointer('pointerdown')
    expect(socket.frames.filter(f => f.kind === 'start')).to.have.length(1)
    await server(socket, { kind: 'partial', id: 'another', text: 'not ours' })
    await server(socket, {
      kind: 'transcript',
      id: start.id,
      text: 'Noah singled.'
    })
    expect(text('Dictated text')).equals('Noah singled.')
    const actions = [{ type: 'result', eventType: 'single' }]
    await server(socket, {
      kind: 'actions',
      id: start.id,
      transcript: 'Noah singled.',
      actions,
      dropped: []
    })
    expect(h.dictated).deep.equals([{ transcript: 'Noah singled.', actions }])
    expect(text('Dictation status')).equals('Push to talk')
    expect(find('Dictation message')).equals(null)
  })

  it('shows what was left out, an error, and the screen’s own refusal', async function () {
    const h = harness()
    await h.render()
    const socket = await enable(h)
    const utter = async (): Promise<string> => {
      await pointer('pointerdown')
      const id = socket.frames.at(-1)!.id as string
      await pointer('pointerup')
      return id
    }
    let id = await utter()
    await server(socket, {
      kind: 'actions',
      id,
      transcript: 'ball',
      actions: [{ type: 'pitch', call: 'B' }],
      dropped: [{ code: 'malformed', message: 'pitch: bad call' }]
    })
    expect(text('Dictation message')).equals('Left out: pitch: bad call')
    id = await utter()
    await server(socket, {
      kind: 'error',
      id,
      message: 'api.x.ai answered 503: down'
    })
    expect(text('Dictation message')).equals('api.x.ai answered 503: down')
    await server(socket, {
      kind: 'error',
      id: null,
      message: 'Not a dictation frame'
    })
    expect(text('Dictation message')).equals('Not a dictation frame')
    await act(async () => {
      socket.onmessage?.({ data: 'garbage' })
    })
    expect(text('Dictation message')).equals('Not a dictation frame')

    const refused = harness()
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    await refused.render({
      problem: { code: 'illegal', message: 'There is no runner on second' }
    })
    expect(text('Dictation message')).equals('There is no runner on second')
  })

  it('asks the LLM’s question, and sends the answer or the dismissal', async function () {
    const h = harness()
    await h.render()
    const socket = await enable(h)
    const ask = async (): Promise<string> => {
      await pointer('pointerdown')
      const id = socket.frames.at(-1)!.id as string
      await pointer('pointerup')
      await server(socket, {
        kind: 'ask',
        id,
        question: 'Which Chase?',
        options: [
          { label: 'Chase L.', actions: [{ type: 'pitch', call: 'B' }] },
          { label: 'Chase M.' }
        ]
      })
      return id
    }
    let id = await ask()
    expect(find('Dictation question')?.textContent).includes('Which Chase?')
    expect(find('Chase L.')).not.equal(null)
    await press('Chase M.')
    expect(socket.frames.at(-1)).deep.equals({ kind: 'answer', id, option: 1 })
    expect(find('Dictation question')).equals(null)
    expect(text('Dictation status')).not.equal('Push to talk')
    await server(socket, {
      kind: 'actions',
      id,
      transcript: 'Chase singled',
      actions: [{ type: 'result', eventType: 'single' }],
      dropped: []
    })
    expect(h.dictated).to.have.length(1)

    id = await ask()
    await press('Dismiss question')
    expect(socket.frames.at(-1)).deep.equals({ kind: 'dismiss', id })
    expect(find('Dictation question')).equals(null)
    expect(text('Dictation status')).equals('Push to talk')
  })

  it('reopens a dropped socket after one second, then two, key terms first', async function () {
    this.timeout(10000)
    const h = harness()
    await h.render()
    const first = await enable(h)
    await pointer('pointerdown')
    await act(async () => {
      first.readyState = 3
      first.onclose?.()
    })
    expect(text('Dictation message')).equals(
      'The connection dropped and that was not scored. Say it again.'
    )
    expect(text('Dictation status')).equals('Connecting…')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 900))
    })
    expect(h.sockets).to.have.length(1)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })
    expect(h.sockets).to.have.length(2)
    // It fails to open; the next try waits two seconds.
    await act(async () => {
      h.sockets[1].readyState = 3
      h.sockets[1].onclose?.()
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1500))
    })
    expect(h.sockets).to.have.length(2)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
    })
    expect(h.sockets).to.have.length(3)
    await opened(h.sockets[2])
    expect(h.sockets[2].frames[0]).deep.equals({
      kind: 'keyterms',
      keyterms: keyterms(h.props.session)
    })
    expect(text('Dictation status')).equals('Push to talk')
  })

  it('ignores a close from a socket that has already been replaced', async function () {
    this.timeout(10000)
    const h = harness()
    await h.render()
    const first = await enable(h)
    await act(async () => {
      first.readyState = 3
      first.onclose?.()
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1100))
    })
    expect(h.sockets).to.have.length(2)
    const second = h.sockets[1]
    await opened(second)
    expect(text('Dictation status')).equals('Push to talk')
    await act(async () => {
      first.onclose?.()
    })
    expect(text('Dictation status')).equals('Push to talk')
    expect(second.closed).equals(false)
    expect(h.sockets).to.have.length(2)
  })

  it('does not stop a microphone a newer open already owns', async function () {
    let resolveFirst: ((mic: { stop: () => void }) => void) | undefined
    const stops: string[] = []
    const h = harness(fresh(), {
      tapMs: 5000,
      openMicrophone: async () =>
        await new Promise(resolve => {
          if (resolveFirst == null) {
            resolveFirst = resolve
            return
          }
          resolve({
            stop: () => {
              stops.push('second')
            }
          })
        })
    })
    await h.render()
    await tap()
    await tap()
    await tap()
    expect(stops).deep.equals([])
    await act(async () => {
      resolveFirst?.({
        stop: () => {
          stops.push('first')
        }
      })
    })
    expect(stops).deep.equals([])
    await tap()
    expect(stops).deep.equals(['second'])
  })

  it('stops a microphone that opens after dictation was switched off', async function () {
    let resolveOpen: ((mic: { stop: () => void }) => void) | undefined
    const stops: string[] = []
    const h = harness(fresh(), {
      tapMs: 5000,
      openMicrophone: async () =>
        await new Promise(resolve => {
          resolveOpen = resolve
        })
    })
    await h.render()
    await tap()
    await tap()
    await act(async () => {
      resolveOpen?.({
        stop: () => {
          stops.push('only')
        }
      })
    })
    expect(stops).deep.equals(['only'])
  })

  it('ends the utterance when a reply is not a dictation frame', async function () {
    const h = harness()
    await h.render()
    const socket = await enable(h)
    await pointer('pointerdown')
    await act(async () => {
      socket.onmessage?.({ data: '{not json' })
    })
    expect(text('Dictation message')).equals(
      'The connection dropped and that was not scored. Say it again.'
    )
    expect(text('Dictation status')).equals('Push to talk')
    await pointer('pointerdown')
    expect(
      socket.frames.filter(frame => frame.kind === 'start')
    ).to.have.length(2)
  })

  it('ends a later sentence after the first is settled during its tail', async function () {
    const h = harness(fresh(), { tailMs: 80, tapMs: 0 })
    await h.render()
    const socket = await enable(h)
    await pointer('pointerdown')
    const first = socket.frames.at(-1)!
    await pointer('pointerup')
    await server(socket, {
      kind: 'error',
      id: first.id,
      message: 'Nothing was heard'
    })
    await pointer('pointerdown')
    const second = socket.frames.at(-1)!
    await pointer('pointerup')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })
    expect(socket.frames.filter(frame => frame.kind === 'release')).deep.equals(
      [{ kind: 'release', id: second.id }]
    )
  })

  it('ignores an open and a frame from a socket that is no longer current', async function () {
    this.timeout(10000)
    const h = harness()
    await h.render()
    const first = await enable(h)
    await act(async () => {
      first.readyState = 3
      first.onclose?.()
    })
    expect(text('Dictation status')).equals('Connecting…')
    await act(async () => {
      first.readyState = 1
      first.onopen?.()
    })
    expect(text('Dictation status')).equals('Connecting…')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1100))
    })
    const second = h.sockets[1]
    await opened(second)
    await pointer('pointerdown')
    expect(text('Dictation status')).equals('Listening…')
    await act(async () => {
      first.onmessage?.({ data: '{not json' })
    })
    expect(text('Dictation status')).equals('Listening…')
    expect(text('Dictation message')).equals(null)
  })

  it('keeps dictation on when a superseded microphone open fails', async function () {
    let rejectFirst: ((error: Error) => void) | undefined
    const h = harness(fresh(), {
      tapMs: 5000,
      openMicrophone: async () =>
        await new Promise((resolve, reject) => {
          if (rejectFirst == null) {
            rejectFirst = reject
            return
          }
          resolve({ stop: () => undefined })
        })
    })
    await h.render()
    await tap()
    await tap()
    await tap()
    await act(async () => {
      rejectFirst?.(new Error('late'))
    })
    expect(find('Dictation')?.getAttribute('aria-pressed')).equals('true')
    expect(text('Dictation message')).equals(null)
  })

  it('can end a later sentence after a release tail was cancelled', async function () {
    const h = harness(fresh(), { tailMs: 200, tapMs: 0 })
    await h.render()
    const first = await enable(h)
    await pointer('pointerdown')
    await pointer('pointerup')
    await act(async () => {
      find('Dictation')!.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      )
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 250))
    })
    expect(first.frames.some(frame => frame.kind === 'release')).equals(false)
    const second = await enable(h)
    await pointer('pointerdown')
    await pointer('pointerup')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 250))
    })
    expect(
      second.frames.filter(frame => frame.kind === 'release')
    ).to.have.length(1)
  })

  it('shows the button once a failed health check succeeds', async function () {
    this.timeout(5000)
    let calls = 0
    const h = harness(fresh(), {
      health: async () => {
        calls++
        if (calls === 1) throw new Error('down')
        return await healthy()
      }
    })
    await h.render()
    expect(find('Dictation')).equals(null)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1100))
    })
    expect(find('Dictation')).not.equal(null)
  })

  it('closes the socket and the microphone when the screen goes mid-utterance', async function () {
    const h = harness()
    await h.render()
    const socket = await enable(h)
    await pointer('pointerdown')
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(socket.closed).equals(true)
    expect(h.microphone.stopped).equals(true)
  })

  it('switches itself off when the microphone stops after it has started', async function () {
    const h = harness()
    await h.render()
    await enable(h)
    await act(async () => {
      h.microphone.fail?.('the microphone stopped')
    })
    expect(text('Dictation message')).equals(
      'The microphone is not available: the microphone stopped'
    )
    expect(find('Dictation')?.getAttribute('aria-pressed')).not.equal('true')
  })

  it('switches itself off when the microphone is refused', async function () {
    const h = harness(fresh(), {
      openMicrophone: async () =>
        await Promise.reject(new Error('Permission denied'))
    })
    await h.render()
    await tap()
    expect(text('Dictation message')).equals(
      'The microphone is not available: Permission denied'
    )
    expect(find('Dictation')?.getAttribute('aria-pressed')).not.equal('true')
    expect(h.socket().closed).equals(true)
  })

  it('talks while held, switches off on a quick tap, and toggles with Enter', async function () {
    const h = harness(fresh(), { tapMs: 60 })
    await h.render()
    expect(find('Dictation')?.getAttribute('aria-pressed')).not.equal('true')
    expect(find('Dictation status')).equals(null)
    // Off, a press of any length switches it on.
    const socket = await enable(h)
    expect(find('Dictation')?.getAttribute('aria-pressed')).equals('true')
    // On, a held press talks once it outlasts a tap, and what was heard
    // from the press on leads it.
    const wait = async (ms: number): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, ms))
      })
    }
    h.microphone.pcm!(pcm(3))
    await wait(150)
    h.microphone.pcm!(pcm(4))
    await pointer('pointerdown')
    h.microphone.pcm!(pcm(5))
    expect(socket.frames.map(f => f.kind)).deep.equals(['keyterms'])
    await wait(80)
    expect(socket.audio.map(b => b.byteLength)).deep.equals([4, 5])
    await pointer('pointerup')
    expect(socket.frames.map(f => f.kind)).deep.equals([
      'keyterms',
      'start',
      'release'
    ])
    expect(socket.closed).equals(false)
    await server(socket, {
      kind: 'error',
      id: socket.frames[1].id,
      message: 'Nothing was heard'
    })
    // A quick tap switches it off, and starts nothing.
    await tap()
    expect(socket.frames.map(f => f.kind)).deep.equals([
      'keyterms',
      'start',
      'release'
    ])
    expect(socket.closed).equals(true)
    expect(find('Dictation')?.getAttribute('aria-pressed')).not.equal('true')
    // Enter switches it on and off.
    const key = async (): Promise<void> => {
      await act(async () => {
        find('Dictation')!.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
        )
      })
    }
    await key()
    expect(find('Dictation')?.getAttribute('aria-pressed')).equals('true')
    await key()
    expect(find('Dictation')?.getAttribute('aria-pressed')).not.equal('true')
    // A pointer the browser cancels ends a hold without switching anything.
    await act(async () => {
      find('Dictation')!.dispatchEvent(
        new window.MouseEvent('pointercancel', { bubbles: true })
      )
    })
    expect(find('Dictation')?.getAttribute('aria-pressed')).not.equal('true')
  })

  it('keeps sending audio for a moment after a release, then ends the utterance', async function () {
    const h = harness(fresh(), { tailMs: 60 })
    await h.render()
    const socket = await enable(h)
    await pointer('pointerdown')
    const start = socket.frames.at(-1)!
    h.microphone.pcm!(pcm(4))
    await pointer('pointerup')
    // Released: the button says so, and the audio already in flight still goes.
    expect(text('Dictation status')).not.equal('Listening…')
    expect(socket.frames.at(-1)).deep.equals(start)
    h.microphone.pcm!(pcm(6))
    await pointer('pointerup')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 90))
    })
    expect(socket.frames.filter(f => f.kind === 'release')).deep.equals([
      { kind: 'release', id: start.id }
    ])
    h.microphone.pcm!(pcm(8))
    expect(socket.audio.map(b => b.byteLength)).deep.equals([4, 6])
  })

  it('ends nothing when switched off before the tail runs out', async function () {
    const h = harness(fresh(), { tailMs: 60, tapMs: 1 })
    await h.render()
    const socket = await enable(h)
    await pointer('pointerdown')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    await pointer('pointerup')
    await act(async () => {
      find('Dictation')!.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      )
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 90))
    })
    expect(socket.closed).equals(true)
    expect(socket.frames.some(f => f.kind === 'release')).equals(false)
  })

  it('lets the log fade once nothing new has come for a while', async function () {
    const h = harness(fresh(), { lingerMs: 40 })
    await h.render()
    const socket = await enable(h)
    await pointer('pointerdown')
    const start = socket.frames.at(-1)!
    // While talking it stays, however long.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 80))
    })
    expect(find('Dictation log')).not.equals(null)
    await pointer('pointerup')
    await server(socket, {
      kind: 'error',
      id: start.id,
      message: 'Nothing was heard'
    })
    expect(find('Dictation log')).not.equals(null)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
    })
    expect(find('Dictation log')).equals(null)
    // A new line brings it back.
    await pointer('pointerdown')
    expect(text('Dictated text')).equals('…')
  })

  it('passes on an undo, and logs what it took back', async function () {
    const h = harness()
    await h.render()
    const socket = await enable(h)
    await pointer('pointerdown')
    const start = socket.frames.at(-1)!
    await pointer('pointerup')
    await server(socket, {
      kind: 'actions',
      id: start.id,
      transcript: 'Undo that last play.',
      actions: [],
      dropped: [],
      undo: true
    })
    expect(h.dictated.at(-1)).deep.equals({
      transcript: 'Undo that last play.',
      actions: [],
      undo: true
    })
    await h.render({ undone: { id: 1, line: 'Undid Ball' } })
    expect(text('Dictated play')).equals('Undid Ball')
    // The same undo is not logged twice.
    await h.render({ undone: { id: 1, line: 'Undid Ball' } })
    expect(find('Dictation log')!.textContent).equals(
      'Undo that last play.Undid Ball'
    )
  })

  it('keeps a log of what was heard, the plays and messages, four lines tall', async function () {
    const h = harness()
    await h.render()
    expect(find('Dictation log')).equals(null)
    const socket = await enable(h)
    await pointer('pointerdown')
    const start = socket.frames.at(-1)!
    expect(text('Dictated text')).equals('…')
    await server(socket, { kind: 'partial', id: start.id, text: 'Line drive' })
    await pointer('pointerup')
    await server(socket, {
      kind: 'transcript',
      id: start.id,
      text: 'Line drive double.'
    })
    expect(text('Dictated text')).equals('Line drive double.')
    await server(socket, {
      kind: 'actions',
      id: start.id,
      transcript: 'Line drive double.',
      actions: [{ type: 'result', eventType: 'double' }],
      dropped: []
    })
    await h.render({
      played: {
        id: 1,
        lines: ['Chase L. line drive double to left', 'Ann B. scores']
      }
    })
    expect(text('Dictated play')).equals('Ann B. scores')
    // The same plays again are not logged twice.
    await h.render({
      played: {
        id: 1,
        lines: ['Chase L. line drive double to left', 'Ann B. scores']
      }
    })
    const log = find('Dictation log')!
    expect(log.textContent).equals(
      'Line drive double.Chase L. line drive double to leftAnn B. scores'
    )
    // A refusal is a message line.
    await h.render({
      problem: { code: 'illegal', message: 'There is no runner on second' }
    })
    expect(text('Dictation message')).equals('There is no runner on second')
    // Fixed at four lines tall (the clipping itself is a browser check).
    expect(log.style.height).equals('84px')
    // A dozen entries at most are kept.
    for (let n = 0; n < 15; n++)
      await h.render({ played: { id: 10 + n, lines: [`play ${n}`] } })
    expect(find('Dictation log')!.children.length).equals(12)
    expect(text('Dictated play')).equals('play 14')
  })

  describe('Space, anywhere on the page', function () {
    /** A Space key event from `target`, and whether something prevented its default. */
    async function space(
      type: 'keydown' | 'keyup',
      target: EventTarget = document.body,
      more: KeyboardEventInit = {}
    ): Promise<boolean> {
      const event = new window.KeyboardEvent(type, {
        key: ' ',
        bubbles: true,
        cancelable: true,
        ...more
      })
      await act(async () => {
        target.dispatchEvent(event)
      })
      return event.defaultPrevented
    }
    const starts = (socket: FakeSocket): number =>
      socket.frames.filter(f => f.kind === 'start').length

    it('holds while Space is down, and lets go when it comes up', async function () {
      const h = harness()
      await h.render()
      const socket = await enable(h)
      expect(await space('keydown')).equals(true)
      expect(starts(socket)).equals(1)
      expect(text('Dictation status')).equals('Listening…')
      // Held, the key repeats; nothing more starts.
      expect(await space('keydown', document.body, { repeat: true })).equals(
        true
      )
      expect(starts(socket)).equals(1)
      h.microphone.pcm!(pcm(4))
      expect(socket.audio).to.have.length(1)
      expect(await space('keyup')).equals(true)
      expect(socket.frames.at(-1)).deep.include({ kind: 'release' })
      // A stray keyup afterwards is left alone.
      expect(await space('keyup')).equals(false)
    })

    it('works from a focused button, without clicking it', async function () {
      const h = harness()
      await h.render()
      const socket = await enable(h)
      const toggle = find('Dictation')!
      expect(await space('keydown', toggle)).equals(true)
      expect(await space('keyup', toggle)).equals(true)
      expect(starts(socket)).equals(1)
      expect(find('Dictation')?.getAttribute('aria-pressed')).equals('true')
    })

    it('is left alone with the mic off, while typing, with a modifier, or once handled', async function () {
      const h = harness()
      await h.render()
      // The mic is off: Space is Space.
      expect(await space('keydown')).equals(false)
      expect(await space('keyup')).equals(false)
      expect(h.sockets).to.have.length(0)
      const socket = await enable(h)
      const input = document.createElement('input')
      document.body.appendChild(input)
      const editable = document.createElement('div')
      editable.setAttribute('contenteditable', 'true')
      document.body.appendChild(editable)
      try {
        expect(await space('keydown', input)).equals(false)
        expect(await space('keydown', editable)).equals(false)
        for (const modifier of ['ctrlKey', 'metaKey', 'altKey'])
          expect(
            await space('keydown', document.body, { [modifier]: true })
          ).equals(false)
        // The field grabbed a player with this Space: dictation steps aside.
        const handled = new window.KeyboardEvent('keydown', {
          key: ' ',
          bubbles: true,
          cancelable: true
        })
        handled.preventDefault()
        await act(async () => {
          document.body.dispatchEvent(handled)
        })
        // Another key is not the talk key.
        expect(
          await (async () => {
            const event = new window.KeyboardEvent('keydown', {
              key: 'b',
              bubbles: true,
              cancelable: true
            })
            await act(async () => {
              document.body.dispatchEvent(event)
            })
            return event.defaultPrevented
          })()
        ).equals(false)
        expect(starts(socket)).equals(0)
      } finally {
        input.remove()
        editable.remove()
      }
    })

    it('lets go when the window loses focus, and when the mic goes off', async function () {
      const h = harness()
      await h.render()
      const socket = await enable(h)
      await space('keydown')
      await act(async () => {
        window.dispatchEvent(new window.Event('blur'))
      })
      expect(socket.frames.at(-1)).deep.include({ kind: 'release' })
      await server(socket, {
        kind: 'error',
        id: socket.frames.at(-1)!.id,
        message: 'Nothing was heard'
      })
      // Held again, then the mic is switched off mid-hold.
      await space('keydown')
      expect(starts(socket)).equals(2)
      await act(async () => {
        find('Dictation')!.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
        )
      })
      expect(socket.closed).equals(true)
      expect(await space('keyup')).equals(false)
      expect(await space('keydown')).equals(false)
    })

    it('takes Space before a focused field could grab a player with it', async function () {
      const h = harness()
      await h.render()
      const socket = await enable(h)
      const field = document.createElement('div')
      field.setAttribute('role', 'application')
      document.body.appendChild(field)
      const seen: string[] = []
      field.addEventListener('keydown', event => seen.push(event.key))
      field.addEventListener('keyup', event => seen.push(event.key))
      try {
        expect(await space('keydown', field)).equals(true)
        expect(await space('keyup', field)).equals(true)
        expect(seen).deep.equals([])
        expect(starts(socket)).equals(1)
      } finally {
        field.remove()
      }
    })

    it('leaves Space to the field while it is drawing or dragging', async function () {
      const h = harness(fresh(), { spaceTalks: false })
      await h.render()
      const socket = await enable(h)
      const field = document.createElement('div')
      document.body.appendChild(field)
      const seen: string[] = []
      field.addEventListener('keydown', event => seen.push(event.key))
      try {
        expect(await space('keydown', field)).equals(false)
        expect(seen).deep.equals([' '])
        expect(starts(socket)).equals(0)
        // Back at rest, Space talks; if the screen moves on mid-hold, the
        // key still lets go.
        await h.render({ spaceTalks: true })
        expect(await space('keydown', field)).equals(true)
        expect(starts(socket)).equals(1)
        await h.render({ spaceTalks: false })
        expect(await space('keyup', field)).equals(true)
        expect(socket.frames.at(-1)).deep.include({ kind: 'release' })
      } finally {
        field.remove()
      }
    })

    it('does nothing while the last sentence is still being answered', async function () {
      const h = harness()
      await h.render()
      const socket = await enable(h)
      await space('keydown')
      await space('keyup')
      expect(await space('keydown')).equals(true)
      expect(starts(socket)).equals(1)
      await space('keyup')
      expect(socket.frames.filter(f => f.kind === 'release')).to.have.length(1)
    })
  })
})

describe('a question the screen asks', function () {
  // Before the page is cleared: the question's modal lives on the body.
  afterEach(unmount)

  it('offers one button per answer, and the dismissal', async function () {
    const answers: unknown[] = []
    let dismissed = 0
    const h = harness(fresh(), {
      question: {
        transcript: 'dropped third strike',
        question: 'Did Noah reach first on the dropped third strike?',
        options: [
          { label: 'Safe at first', actions: [] },
          { label: 'Out at first', actions: [] }
        ]
      },
      onAnswer: answer => answers.push(answer),
      onDismissQuestion: () => {
        dismissed++
      }
    })
    await h.render()
    expect(find('Dictation question')?.textContent).includes(
      'Did Noah reach first'
    )
    await press('Out at first')
    expect(answers).deep.equals([{ option: 1 }])
    await press('Dismiss question')
    expect(dismissed).equals(1)
  })

  it('lets the scorer pick any runners and record them', async function () {
    const answers: unknown[] = []
    const h = harness(fresh(), {
      question: {
        transcript: 'fielders choice',
        question: "Which runners were out on the fielder's choice?",
        pick: {
          choices: [
            { label: 'Ann B. out at second', actions: [] },
            { label: 'Cal D. out at third', actions: [] }
          ],
          before: [],
          none: []
        }
      },
      onAnswer: answer => answers.push(answer)
    })
    await h.render()
    expect(find('Record')?.textContent).equals('Record — nobody out')
    await press('Cal D. out at third')
    expect(find('Cal D. out at third')?.getAttribute('aria-checked')).equals(
      'true'
    )
    expect(find('Record')?.textContent).equals('Record')
    await press('Ann B. out at second')
    await press('Ann B. out at second')
    await press('Record')
    expect(answers).deep.equals([{ picks: [1] }])
  })

  it('shows nothing of its own while the LLM is asking', async function () {
    const h = harness(fresh(), {
      question: { transcript: 't', question: 'The screen asks', options: [] }
    })
    await h.render()
    const socket = await enable(h)
    await pointer('pointerdown')
    await pointer('pointerup')
    await server(socket, {
      kind: 'ask',
      id: socket.frames.find(f => f.kind === 'start')!.id,
      question: 'The LLM asks',
      options: [{ label: 'One' }, { label: 'Two' }]
    })
    expect(find('Dictation question')?.textContent).includes('The LLM asks')
    expect(find('Dictation question')?.textContent).not.includes(
      'The screen asks'
    )
  })
})

describe('the dictation socket address', function () {
  it('follows the API, over wss where the page is https', function () {
    const page = { protocol: 'https:', host: 'develop3.teamstation.app' }
    expect(dictationUrl('/api/v1', page)).equals(
      'wss://develop3.teamstation.app/api/v1/dictation'
    )
    expect(dictationUrl('api/v1/', page)).equals(
      'wss://develop3.teamstation.app/api/v1/dictation'
    )
    expect(dictationUrl('http://127.0.0.1:9100/api/v1', page)).equals(
      'ws://127.0.0.1:9100/api/v1/dictation'
    )
    expect(dictationUrl('/api/v1')).equals('ws://localhost/api/v1/dictation')
  })
})
