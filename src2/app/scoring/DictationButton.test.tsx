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
import { DictationButton } from './DictationButton'
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
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
})

interface Harness {
  sockets: FakeSocket[]
  socket: () => FakeSocket
  dictated: Array<{ transcript: string; actions: ScoringAction[] }>
  microphone: {
    pcm?: (pcm: ArrayBuffer) => void
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
  dictation: true
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
    onActions: (transcript, actions) => {
      dictated.push({ transcript, actions })
    },
    openSocket: url => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    openMicrophone: async onPcm => {
      microphone.pcm = onPcm
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
            <DictationButton {...self.props} />
          </ThemeProvider>
        )
      })
    }
  }
  return self
}

function find(label: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
}
async function press(label: string): Promise<void> {
  await act(async () => {
    find(label)!.click()
  })
}
async function pointer(type: 'pointerdown' | 'pointerup'): Promise<void> {
  await act(async () => {
    find('Hold to dictate')!.dispatchEvent(
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
async function enable(h: Harness): Promise<FakeSocket> {
  await press('Dictation')
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
    expect(find('Hold to dictate')?.getAttribute('aria-disabled')).equals(
      'true'
    )
    expect(on.sockets).to.have.length(0)
    expect(on.microphone.opened).equals(0)
  })

  it('opens the socket and the microphone when switched on, key terms first', async function () {
    const h = harness()
    await h.render()
    const socket = await enable(h)
    expect(socket.url).equals('ws://host/api/v1/dictation')
    expect(socket.binaryType).equals('arraybuffer')
    expect(h.microphone.opened).equals(1)
    expect(socket.frames).deep.equals([
      { kind: 'keyterms', keyterms: keyterms(h.props.session) }
    ])
    expect(find('Hold to dictate')?.getAttribute('aria-disabled')).not.equal(
      'true'
    )
    expect(find('Dictation')?.getAttribute('aria-checked')).equals('true')

    await press('Dictation')
    expect(socket.closed).equals(true)
    expect(h.microphone.stopped).equals(true)
    expect(find('Hold to dictate')?.getAttribute('aria-disabled')).equals(
      'true'
    )
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

  it('sends a hold as a start with the game, then audio, then a release', async function () {
    const h = harness()
    await h.render()
    const socket = await enable(h)
    h.microphone.pcm!(pcm(4))
    expect(socket.audio).to.have.length(0)
    await pointer('pointerdown')
    const start = socket.frames.at(-1)!
    expect(start).deep.include({
      kind: 'start',
      scope: 'scoring',
      target: { gameId: 'gam_1' },
      context: promptContext(h.props.session)
    })
    expect(start.id).is.a('string')
    expect(text('Hold to dictate')).equals('Listening…')
    h.microphone.pcm!(pcm(6))
    h.microphone.pcm!(pcm(8))
    expect(socket.audio.map(b => b.byteLength)).deep.equals([6, 8])
    await server(socket, { kind: 'partial', id: start.id, text: 'Noah sin' })
    expect(text('Dictated text')).equals('Noah sin')
    await pointer('pointerup')
    expect(socket.frames.at(-1)).deep.equals({ kind: 'release', id: start.id })
    expect(find('Hold to dictate')?.getAttribute('aria-disabled')).equals(
      'true'
    )
    h.microphone.pcm!(pcm(2))
    expect(socket.audio).to.have.length(2)
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
    expect(find('Hold to dictate')?.getAttribute('aria-disabled')).not.equal(
      'true'
    )
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
    expect(find('Hold to dictate')?.getAttribute('aria-disabled')).equals(
      'true'
    )
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
    expect(find('Hold to dictate')?.getAttribute('aria-disabled')).not.equal(
      'true'
    )
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
    expect(text('Hold to dictate')).equals('Connecting…')
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
    expect(find('Hold to dictate')?.getAttribute('aria-disabled')).not.equal(
      'true'
    )
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

  it('switches itself off when the microphone is refused', async function () {
    const h = harness(fresh(), {
      openMicrophone: async () =>
        await Promise.reject(new Error('Permission denied'))
    })
    await h.render()
    await press('Dictation')
    expect(text('Dictation message')).equals(
      'The microphone is not available: Permission denied'
    )
    expect(find('Dictation')?.getAttribute('aria-checked')).not.equal('true')
    expect(h.socket().closed).equals(true)
  })

  it('holds and releases from the button with Enter', async function () {
    const h = harness()
    await h.render()
    const socket = await enable(h)
    const key = async (
      type: 'keydown' | 'keyup',
      name: string
    ): Promise<void> => {
      await act(async () => {
        find('Hold to dictate')!.dispatchEvent(
          new window.KeyboardEvent(type, { key: name, bubbles: true })
        )
      })
    }
    await key('keydown', 'Enter')
    await key('keydown', 'Enter')
    await key('keydown', 'x')
    expect(socket.frames.filter(f => f.kind === 'start')).to.have.length(1)
    await key('keyup', 'x')
    expect(socket.frames.at(-1)?.kind).equals('start')
    await key('keyup', 'Enter')
    expect(socket.frames.at(-1)?.kind).equals('release')
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
      expect(find('Or hold Space')).not.equal(null)
      expect(await space('keydown')).equals(true)
      expect(starts(socket)).equals(1)
      expect(text('Hold to dictate')).equals('Listening…')
      expect(find('Or hold Space')).equals(null)
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
      expect(find('Dictation')?.getAttribute('aria-checked')).equals('true')
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
      await press('Dictation')
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

describe('the dictation socket address', function () {
  it('follows the API, over wss where the page is https', function () {
    const page = { protocol: 'https:', host: 'devhost3.examplegs.test' }
    expect(dictationUrl('/api/v1', page)).equals(
      'wss://devhost3.examplegs.test/api/v1/dictation'
    )
    expect(dictationUrl('api/v1/', page)).equals(
      'wss://devhost3.examplegs.test/api/v1/dictation'
    )
    expect(dictationUrl('http://127.0.0.1:9100/api/v1', page)).equals(
      'ws://127.0.0.1:9100/api/v1/dictation'
    )
    expect(dictationUrl('/api/v1')).equals('ws://localhost/api/v1/dictation')
  })
})
