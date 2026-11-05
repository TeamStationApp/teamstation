import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import {
  dictatingHealth,
  fakeDictation,
  type FakeDictationSocket
} from '../../test/dictationFakes'
import {
  byLabel,
  byTestId,
  click,
  manualClock,
  render,
  settle,
  unmount
} from '../../test/tessTestKit'
import { SPACE_HOLD_MS, TessPanel, type TessPanelProps } from './TessPanel'

afterEach(unmount)

async function talk(): Promise<void> {
  for (const type of ['pointerdown', 'pointerup'])
    await act(async () => {
      byLabel('Dictate').dispatchEvent(
        new window.MouseEvent(type, { bubbles: true })
      )
    })
}

/** A client whose sends are kept, and whose answers wait for `answer`. */
function tessClient(slow = false): {
  client: TessPanelProps['client']
  sent: string[]
  answer: () => void
} {
  const sent: string[] = []
  const waiting: Array<() => void> = []
  const client: TessPanelProps['client'] = {
    baseUrl: 'http://192.0.2.10/api/v1',
    token: 'tok_tess_panel',
    health: dictatingHealth,
    tess: async () => ({ available: true, messages: [], contextTokens: 0 }),
    streamTessMessage: async text => {
      sent.push(text)
      if (slow)
        await new Promise<void>(resolve => {
          waiting.push(resolve)
        })
      return [
        {
          id: `u${sent.length}`,
          role: 'user',
          text,
          attachments: [],
          changes: [],
          createdAt: '2027-04-03T12:00:00Z'
        }
      ]
    },
    uploadTessAttachment: async () => {
      throw new Error('no uploads here')
    },
    streamTessConfirmAll: async () => {
      throw new Error('no changes here')
    },
    stopTess: async () => undefined,
    tessUsage: async () => []
  }
  return {
    client,
    sent,
    answer: () => {
      for (const resolve of waiting.splice(0)) resolve()
    }
  }
}

const field = (): HTMLTextAreaElement =>
  byLabel('Ask Tess') as HTMLTextAreaElement

async function type(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )!.set!.call(field(), value)
    field().dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function caret(at: number): Promise<void> {
  await act(async () => {
    field().focus()
    field().setSelectionRange(at, at)
    // A release of the mouse, which also ends any press an earlier test
    // left down, after which the field reports no selection.
    field().dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
  })
}

async function mount(
  client: TessPanelProps['client']
): Promise<ReturnType<typeof fakeDictation>> {
  const fake = fakeDictation()
  await render(
    <TessPanel
      client={client}
      onClose={() => undefined}
      onNavigate={() => undefined}
      dictation={{
        openSocket: fake.openSocket,
        openMicrophone: fake.openMicrophone,
        tapMs: 0,
        tailMs: 0
      }}
    />
  )
  await settle()
  return fake
}

/** What the server heard of the utterance just started. */
async function hears(socket: FakeDictationSocket, text: string): Promise<void> {
  const start = socket.frames.filter(frame => frame.kind === 'start').at(-1)!
  expect(start).deep.include({ scope: 'tess', context: 'tess' })
  await act(async () => {
    socket.reply({ kind: 'transcript', id: start.id, text })
  })
  await settle()
}

describe("Tess's panel", () => {
  it('opens no microphone until pressed, and puts what was said at the cursor, not to the server', async () => {
    const { client, sent } = tessClient()
    const fake = await mount(client)
    // Right of Send, closed.
    expect(byLabel('Send').nextElementSibling).equals(byLabel('Dictate'))
    expect(fake.sockets).deep.equals([])
    expect(fake.microphone.opened).equals(0)
    await type('Hello world')
    await caret('Hello'.length)
    await talk()
    const socket: FakeDictationSocket = fake.socket()
    expect(socket.url).equals('ws://192.0.2.10/api/v1/dictation')
    await act(async () => {
      socket.open()
    })
    await hears(socket, 'there')
    expect(field().value).equals('Hello there world')
    expect(sent).deep.equals([])
    expect(socket.closed).equals(true)
    expect(fake.microphone.stopped).equals(1)
    // Sent with Send, as typed words are.
    await click(byLabel('Send'))
    await settle()
    expect(sent).deep.equals(['Hello there world'])
  })

  it('records while Tess answers, the waveform on an added line, and keeps the words in the field', async () => {
    const { client, sent, answer } = tessClient(true)
    const fake = await mount(client)
    await type('Where are my team settings?')
    await click(byLabel('Send'))
    await settle()
    expect(sent).deep.equals(['Where are my team settings?'])
    await type('And')
    await caret('And'.length)
    // A held press: recording from when the socket connects.
    await act(async () => {
      byLabel('Dictate').dispatchEvent(
        new window.MouseEvent('pointerdown', { bubbles: true })
      )
    })
    await settle()
    expect(byTestId('Tess waveform')).equals(null)
    const socket = fake.socket()
    await act(async () => {
      socket.open()
    })
    expect(byTestId('Tess waveform')).not.equals(null)
    expect(field().value).equals('And\n')
    await act(async () => {
      byLabel('Dictate').dispatchEvent(
        new window.MouseEvent('pointerup', { bubbles: true })
      )
    })
    await settle()
    expect(byTestId('Tess waveform')).equals(null)
    await hears(socket, 'the schedule?')
    expect(field().value).equals('And the schedule?')
    await act(async () => {
      answer()
    })
    await settle()
    expect(sent).deep.equals(['Where are my team settings?'])
    expect(field().value).equals('And the schedule?')
  })

  it('ends quietly when nothing was heard', async () => {
    const { client } = tessClient()
    const fake = await mount(client)
    await talk()
    const socket = fake.socket()
    await act(async () => {
      socket.open()
    })
    const start = socket.frames.find(frame => frame.kind === 'start')!
    await act(async () => {
      socket.reply({
        kind: 'error',
        id: start.id,
        message: 'Nothing was heard'
      })
    })
    await settle()
    // An utterance with no words ends quietly: no line moves the field.
    expect(byTestId('Tess error')).equals(null)
  })

  it('records while Space is held half a second in the field, and types a space on a tap', async () => {
    const { client, sent } = tessClient()
    const fake = await mount(client)
    field().focus()
    const space = async (kind: 'keydown' | 'keyup'): Promise<boolean> => {
      const event = new window.KeyboardEvent(kind, {
        key: ' ',
        bubbles: true,
        cancelable: true
      })
      await act(async () => {
        field().dispatchEvent(event)
      })
      return event.defaultPrevented
    }
    const clock = manualClock(SPACE_HOLD_MS)
    try {
      expect(await space('keydown')).equals(true)
      await clock.advance(SPACE_HOLD_MS - 1)
      expect(fake.sockets).deep.equals([])
      await clock.advance(1)
      const socket = fake.socket()
      await act(async () => {
        socket.open()
      })
      expect(await space('keyup')).equals(true)
      await hears(socket, 'Who pitches Saturday?')
      expect(sent).deep.equals([])
      expect(field().value).equals('Who pitches Saturday?')
      // A tap is the field's: a space, and nothing heard.
      field().focus()
      expect(await space('keydown')).equals(true)
      expect(await space('keyup')).equals(true)
      await clock.advance(1000)
      expect(field().value).equals('Who pitches Saturday? ')
      expect(fake.sockets).has.length(1)
    } finally {
      clock.restore()
    }
  })
})
