import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import { fixtureFor, providerFor } from '../../../rigs/chat/messageLinkFixture'
import { chatLinkUi, revealChatTarget } from '../../../rigs/chat/messageLinkUi'
import { observedNativeValue } from '../../../rigs/chat2Maestro'

// The hardware keyboard's Up arrow and Escape, sent through maestro-d to the
// focused composer, so the keyboard keeps focus.
async function hardware(ctx: HarnessContext): Promise<void> {
  const f = await fixtureFor(ctx)
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
    const press = async (key: 'up' | 'escape'): Promise<void> => {
      await m.pressKey({ key })
    }
    const text = 'Bring the equipment to practice ' + randomUUID().slice(0, 8)
    const message = await actor.engine.sendText(f.conversationId, text)
    assert(message?.mine === true)
    await enter()
    await m.tapOn({ id: 'chat-composer' })
    await press('up')
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
    await press('escape')
    await m.assertNotVisible({ text: '^Editing your message$' })
    await m.inputText({ text: 'Practice draft' })
    await press('up')
    await m.assertNotVisible({ text: '^Editing your message$' })
    await expectComposerValue('Practice draft')
    await m.tapOn({ text: '^Attach$' })
    await m.assertVisible({ text: '^Photos$' })
    await revealChatTarget(m, node => node.id === 'chat-bubble-' + message.id)
    await m.longPressOn({ id: 'chat-bubble-' + message.id })
    await m.tapOn({ text: '^Edit$' })
    await m.assertVisible({ text: '^Editing your message$' })
    await m.assertNotVisible({ text: '^Photos$' })
    await expectComposerValue(text)
    await press('escape')
    await m.assertNotVisible({ text: '^Editing your message$' })
    await m.assertNotVisible({ text: '^Photos$' })
    await expectComposerValue('Practice draft')
    await m.eraseText({ characters: 'Practice draft'.length })
  } finally {
    actor.engine.stop()
  }
}
export default defineHarness({
  id: 'messaging/chat/edit-message-ipad',
  title: 'The focused iPad chat composer accepts hardware Up and Escape',
  kind: 'e2e',
  covers: [
    'ios/TeamStation/TSShiftReturn.m',
    'ios/TeamStation/ChatKeyboard/**',
    'src/app/chat/Composer.tsx'
  ],
  stack: 'isolated',
  fixtures: ['messaging'],
  exclusive: true,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'tablet', needs: ['ipad'], simulator: 'allowed' }]
    }
  },
  services: [],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 2,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: { hardware }
})
