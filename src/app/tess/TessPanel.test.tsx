import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import {
  dictatingHealth,
  fakeDictation,
  type FakeDictationSocket
} from '../../test/dictationFakes'
import { byLabel, click, render, settle, unmount } from '../../test/tessTestKit'
import { TessPanel, type TessPanelProps } from './TessPanel'

afterEach(unmount)

async function talk(): Promise<void> {
  for (const type of ['pointerdown', 'pointerup'])
    await act(async () => {
      byLabel('Dictation').dispatchEvent(
        new window.MouseEvent(type, { bubbles: true })
      )
    })
}

describe("Tess's panel", () => {
  it('sends what was said at the microphone as the next message, twice over', async () => {
    const sent: string[] = []
    const client: TessPanelProps['client'] = {
      baseUrl: 'http://192.0.2.10/api/v1',
      token: 'tok_tess_panel',
      health: dictatingHealth,
      tess: async () => ({ available: true, messages: [], contextTokens: 0 }),
      streamTessMessage: async text => {
        sent.push(text)
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
      streamTessConfirm: async () => {
        throw new Error('no changes here')
      },
      tessUsage: async () => []
    }
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
    const socket: FakeDictationSocket = fake.socket()
    expect(socket.url).equals('ws://192.0.2.10/api/v1/dictation')
    await act(async () => {
      socket.open()
    })
    for (const text of ['Where are my team settings?', 'And the schedule?']) {
      await talk()
      const start = socket.frames
        .filter(frame => frame.kind === 'start')
        .at(-1)!
      expect(start).deep.include({ scope: 'tess', context: 'tess' })
      await act(async () => {
        socket.reply({ kind: 'transcript', id: start.id, text })
      })
      await settle()
    }
    expect(sent).deep.equals([
      'Where are my team settings?',
      'And the schedule?'
    ])
    expect(document.body.textContent).includes('And the schedule?')
  })

  it('keeps what was said while Tess is still answering, to send once she has', async () => {
    const sent: string[] = []
    let answer: () => void = () => undefined
    const client: TessPanelProps['client'] = {
      baseUrl: 'http://192.0.2.10/api/v1',
      token: 'tok_tess_panel',
      health: dictatingHealth,
      tess: async () => ({ available: true, messages: [], contextTokens: 0 }),
      streamTessMessage: async text => {
        sent.push(text)
        await new Promise<void>(resolve => {
          answer = resolve
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
      streamTessConfirm: async () => {
        throw new Error('no changes here')
      },
      tessUsage: async () => []
    }
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
    const socket = fake.socket()
    await act(async () => {
      socket.open()
    })
    const say = async (text: string): Promise<void> => {
      await talk()
      const start = socket.frames
        .filter(frame => frame.kind === 'start')
        .at(-1)!
      await act(async () => {
        socket.reply({ kind: 'transcript', id: start.id, text })
      })
      await settle()
    }
    const field = (): HTMLTextAreaElement =>
      byLabel('Ask Tess') as HTMLTextAreaElement
    await say('Where are my team settings?')
    expect(sent).deep.equals(['Where are my team settings?'])
    // Said while Tess is thinking: not lost, and not sent over her.
    await say('And the schedule?')
    expect(sent).deep.equals(['Where are my team settings?'])
    expect(field().value).equals('And the schedule?')
    await act(async () => {
      answer()
    })
    await settle()
    expect(field().value).equals('And the schedule?')
    await click(byLabel('Send'))
    await settle()
    expect(sent).deep.equals([
      'Where are my team settings?',
      'And the schedule?'
    ])
    expect(field().value).equals('')
  })
})
