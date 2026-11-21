import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { observedNativeValue } from '../../../../src/test/chat2Maestro.e2e'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { fixtureFor, providerFor } from '../../../rigs/chat/messageLinkFixture'
import { chatLinkUi, revealChatTarget } from '../../../rigs/chat/messageLinkUi'

// Run on the simulator host. Maestro derives the installed WDA port from the
// UUID's final segment. Reuse its existing session so the keyboard keeps focus.
async function hardware(ctx: E2eContext): Promise<void> {
  const f = fixtureFor(ctx)
  const actor = await providerFor(f, f.observer)
  try {
    const { m, enter } = await chatLinkUi(
      ctx,
      f,
      actor,
      'ios',
      undefined,
      'tablet'
    )
    const udid = ctx.device('tablet').split('@')[0]
    assert.match(udid, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
    assert.equal((await m.platformInfo()).isSimulator, true)
    const port = 8100 + (parseInt(udid.slice(-12), 16) % 1000)
    const wda = 'http://127.0.0.1:' + port
    const status = await fetch(wda + '/status')
    assert.equal(status.status, 200)
    const { sessionId, value } = await status.json()
    assert.equal(String(value.device).toLowerCase(), 'ipad')
    assert.match(sessionId, /^[a-z0-9-]+$/i)
    const press = async (usage: number): Promise<void> => {
      const result = await fetch(
        wda +
          '/session/' +
          encodeURIComponent(sessionId) +
          '/wda/performIoHidEvent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page: 7, usage, duration: 0.08 })
        }
      )
      assert.equal(result.status, 200)
      const reply = await result.json()
      assert.equal(reply.value?.error, undefined)
    }
    const text = 'Bring the equipment to practice ' + randomUUID().slice(0, 8)
    const message = await actor.engine.sendText(f.conversationId, text)
    assert(message?.mine === true)
    await enter()
    await m.tapOn({ id: 'chat-composer' })
    await press(82)
    await m.assertVisible({ text: '^Editing your message$' })
    const expectComposerValue = async (value: string): Promise<void> => {
      observedNativeValue(await m.hierarchyRaw(), {
        identifier: 'chat-composer',
        type: 'TextView',
        label: 'Message',
        value
      })
    }
    await expectComposerValue(text)
    await press(41)
    await m.assertNotVisible({ text: '^Editing your message$' })
    await m.inputText({ text: 'Practice draft' })
    await press(82)
    await m.assertNotVisible({ text: '^Editing your message$' })
    await expectComposerValue('Practice draft')
    await m.tapOn({ text: '^Attach$' })
    await m.assertVisible({ text: '^Photo library$' })
    await revealChatTarget(m, node => node.id === 'chat-bubble-' + message.id)
    await m.longPressOn({ id: 'chat-bubble-' + message.id })
    await m.tapOn({ text: '^Edit$' })
    await m.assertVisible({ text: '^Editing your message$' })
    await m.assertNotVisible({ text: '^Photo library$' })
    await expectComposerValue(text)
    await press(41)
    await m.assertNotVisible({ text: '^Editing your message$' })
    await m.assertNotVisible({ text: '^Photo library$' })
    await expectComposerValue('Practice draft')
    await m.eraseText({ characters: 'Practice draft'.length })
  } finally {
    actor.engine.stop()
  }
}
export default defineE2e({
  id: 'messaging/chat/edit-message-ipad',
  title: 'The focused iPad chat composer accepts hardware Up and Escape',
  kind: 'e2e',
  covers: [
    'ios/TeamStation/TSShiftReturn.m',
    'ios/TeamStation/ChatKeyboard/**',
    'src/app/chat/Composer.tsx'
  ],
  stack: 'seat',
  fixtures: [],
  exclusive: true,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'tablet', needs: ['ipad'], hardware: 'none' }]
    }
  },
  services: ['api'],
  apps: [],
  secrets: ['chatLinkFixture'],
  costUsd: 0,
  minutes: 2,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: { hardware }
})
