import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { MaestroDevice } from '../../core/maestro'
import type { PublicNode } from '../chat2Maestro'
import {
  clearChatComposer,
  readChatComposer,
  revealChatTarget
} from './messageLinkUi'

describe('native message link targets', function () {
  it('reveals a covered first line and waits for its actual tap position to settle', async function () {
    const positions = [20, 150, 162, 162]
    const gestures: unknown[] = []
    let reads = 0
    const node = (id: string, y: number, height: number): PublicNode => ({
      id,
      bounds: { x: 0, y, width: 300, height }
    })
    const device: MaestroDevice = {
      screenshot: async () => new Uint8Array(),
      state: async () => ({}),
      detach: async () => undefined,
      hierarchy: async () => ({
        nodes: [
          node('chat-conversation-identity', 0, 80),
          node('chat-pinned-band', 80, 50),
          node('body', positions[reads++], 350),
          node('chat-composer-band', 600, 50)
        ]
      }),
      dragAndDrop: async (gesture: unknown) => gestures.push(gesture)
    }

    const body = await revealChatTarget(device, item => item.id === 'body', 9)
    expect(gestures).to.have.length(1)
    expect(reads).to.equal(4)
    expect(body.y + 9).to.equal(171)
  })
})

describe('reading a native Android composer', function () {
  it('reads multiline text without opening a clipboard preview', async function () {
    const draft = 'First line\nSecond line 🧢'
    const m: MaestroDevice = {
      state: async () => ({}),
      screenshot: async () => new Uint8Array(),
      detach: async () => undefined,
      hierarchy: async () => ({
        nodes: [
          { id: 'other-editor', type: 'EditText', text: 'ignored' },
          { id: 'chat-composer', type: 'android.widget.EditText', text: draft }
        ]
      })
    }
    expect(await readChatComposer(m, 'android')).to.equal(draft)
  })
})

describe('clearing a retained Android draft', function () {
  for (const attachment of [false, true]) {
    it(
      'clears literal Message after an ineffective erase with ' +
        (attachment ? 'a staged file' : 'text only'),
      async function () {
        let value = 'Message'
        let deletes = 0
        const device: MaestroDevice = {
          screenshot: async () => new Uint8Array(),
          state: async () => ({}),
          detach: async () => undefined,
          tapOn: async () => {},
          eraseText: async () => {},
          hierarchy: async () => ({
            nodes: [
              {
                id: 'chat-composer',
                type: 'EditText',
                text: value === '' ? 'Message' : value
              },
              ...(value !== '' || attachment ? [{ id: 'chat-send' }] : [])
            ]
          }),
          pressKey: async ({ key }: { key: string }) => {
            if (key === 'BACKSPACE') {
              value = value.slice(0, -1)
              deletes++
            }
          },
          inputText: async ({ text }: { text: string }) => {
            value += text
          }
        }
        await clearChatComposer(device, 'android', value)
        expect(value).equals('')
        expect(deletes).equals(attachment ? 8 : 7)
      }
    )
  }
})
