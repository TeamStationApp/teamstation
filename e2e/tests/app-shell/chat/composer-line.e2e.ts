import assert from 'node:assert/strict'
import { setTimeout as wait } from 'node:timers/promises'

import { dismissNotificationAsk } from '../../../../src/test/notificationAsk'
import { defineE2e } from '../../../core/spec'
import { boxOf, type Node } from '../../../rigs/app/keyboardDock'
import { captureComposer, composerBoxes } from '../../../rigs/chat/composerLine'
import { fixtureFor, providerFor } from '../../../rigs/chat/messageLinkFixture'
import {
  chatLinkUi,
  clearChatComposer,
  readChatComposer,
  revealChatTarget
} from '../../../rigs/chat/messageLinkUi'
import { flattenPublicHierarchy, until } from '../../../rigs/chat2Maestro'

export default defineE2e({
  id: 'app-shell/chat/composer-keyboard',
  title: 'The editable chat line is centered beside its controls',
  kind: 'e2e',
  covers: ['src/app/chat/Composer.tsx', 'src/app/chat/chatWebInteractions.ts'],
  stack: 'seat',
  fixtures: [],
  exclusive: true,
  surfaces: {
    'web-chromium': { devices: [] },
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'required' }]
    },
    'android-app': {
      devices: [
        { role: 'phone', needs: ['android-phone'], hardware: 'required' }
      ]
    }
  },
  services: ['api'],
  apps: [],
  secrets: ['chatLinkFixture'],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'centered-text': async ctx => {
      const f = fixtureFor(ctx)
      const author = await providerFor(f, f.observer)
      const platform =
        ctx.surface === 'web-chromium'
          ? 'web'
          : ctx.surface === 'ios-app'
            ? 'ios'
            : 'android'
      const field = { id: 'chat-composer' }
      // Set the signed phone's system text size before the enlarged-type run.
      // The painted caret and field dimensions below verify it took effect.
      const largeText =
        platform !== 'web' && process.env.TS_CHAT_COMPOSER_LARGE_TEXT === '1'
      let seeded: string | undefined
      let clearOwnedDraft: (() => Promise<void>) | undefined
      try {
        const { m, web, enter } = await chatLinkUi(ctx, f, author, platform)
        const message = await author.engine.sendText(f.conversationId, 'Hello')
        assert(
          message?.mine === true,
          'A synthetic message to reply to and edit'
        )
        seeded = message.id
        const originalIds = new Set(
          (await author.engine.open(f.conversationId)).messages.map(
            msg => msg.id
          )
        )
        await enter()
        if (web != null)
          await dismissNotificationAsk(web.page, {
            userId: author.person.userId
          })
        const read = async (): Promise<string> =>
          await readChatComposer(m, platform, web)
        const empty = async (): Promise<boolean> => {
          const text = await read()
          return text === '' || text === 'Message'
        }
        assert(await empty(), 'The fixture must start without a draft')
        clearOwnedDraft = async () => {
          const current = await read()
          if (
            current !== '' &&
            current !== 'Message' &&
            /^(Hello\n?)+$/.test(current)
          ) {
            await m.tapOn(field)
            await clearChatComposer(m, platform, current, web)
          }
        }
        const capture = async (
          name: string,
          focused = false
        ): Promise<void> => {
          await m.waitForAnimationToEnd()
          await captureComposer(ctx, m, web, name, focused, largeText)
        }
        const mode = async (action: 'Reply' | 'Edit'): Promise<void> => {
          if (web != null) {
            const row = '[data-testid="chat-message-' + message.id + '"]'
            const node = await web.page.waitForSelector(row)
            assert(node != null)
            await node.scrollIntoView()
            await node.hover()
            if (action === 'Reply') {
              await m.tapOn({ css: row + ' [aria-label="Reply"]' })
              await m.assertVisible({ css: '[aria-label="Cancel reply"]' })
              return
            }
            await m.tapOn({ css: row + ' [aria-label="More message actions"]' })
          } else {
            const id = 'chat-bubble-' + message.id
            await m.scrollUntilVisible({
              element: { id },
              direction: 'down',
              timeout: 12000
            })
            await revealChatTarget(m, node => node.id === id)
            await m.longPressOn({ id })
          }
          await m.tapOn({ text: '^' + action + '$' })
          if (action === 'Edit') {
            await until(
              async () => ((await read()) === 'Hello' ? true : undefined),
              'the seeded edit'
            )
            await m.tapOn(field)
            await clearChatComposer(m, platform, 'Hello', web)
          }
        }
        const input = async (text: string): Promise<void> => {
          await m.inputText({ text, keyPress: platform === 'android' })
          assert.equal(await read(), text)
          await m.assertVisible({ id: 'chat-send' })
        }
        const multiline = async (text: string): Promise<void> => {
          if (platform === 'ios') await m.inputText({ text })
          else {
            await m.waitForAnimationToEnd()
            await m.setClipboard({ text })
            await m.pasteText()
          }
          await until(
            async () => ((await read()) === text ? true : undefined),
            'the complete multiline draft'
          )
        }
        const blur = async (): Promise<void> => {
          if (web != null) {
            const active = async (): Promise<boolean> =>
              await web.page.$eval(
                '[data-testid="chat-composer"]',
                el => document.activeElement === el
              )
            if (await active()) await m.pressKey({ key: 'TAB' })
            assert(!(await active()), 'The browser editor must lose focus')
          } else {
            // Tapping unhandled history clears the editing focus. Hiding an
            // Android keyboard alone can leave a blinking caret behind.
            const tree = (await m.hierarchy()) as Node
            const list = flattenPublicHierarchy(tree).find(
              n => n.id === 'chat-message-history'
            )?.bounds
            assert(
              list != null,
              'The chat must expose a history area outside its controls'
            )
            await m.tapOnPoint({
              point:
                Math.round(list.x + 2) +
                ',' +
                Math.round(list.y + list.height * 0.25)
            })
            if (platform === 'android')
              await until(async () => {
                const nodes = flattenPublicHierarchy(
                  await m.hierarchy()
                ).filter(n => n.id === field.id)
                return nodes.length > 0 && nodes.every(n => n.focused !== true)
                  ? true
                  : undefined
              }, 'the Android editor to lose focus')
          }
          await m.waitForAnimationToEnd()
        }
        for (const context of ['normal', 'reply', 'edit'] as const) {
          if (context !== 'normal')
            await mode(context === 'reply' ? 'Reply' : 'Edit')
          assert(await empty())
          await blur()
          await capture(context + '-placeholder')
          await m.tapOn(field)
          await capture(context + '-placeholder-focused', true)
          await input('Hello')
          await capture(context + '-hello-focused', true)
          await blur()
          assert.equal(await read(), 'Hello')
          await capture(context + '-hello-unfocused')
          await m.tapOn(field)
          await clearChatComposer(m, platform, 'Hello', web)
          await input('Hello')
          const lines = Array.from({ length: 6 }, () => 'Hello').join('\n')
          await clearChatComposer(m, platform, 'Hello', web)
          // Paste a multiline draft as a single edit. Enter on a desktop
          // keyboard sends the message and would exercise a different action.
          await multiline(lines)
          await capture(context + '-six-lines')
          const six = await composerBoxes(m, ctx.surface, web)
          assert(
            six.input.height / six.units > 90,
            'The draft grows across lines'
          )
          await clearChatComposer(m, platform, lines, web)
          const overflow = lines + '\n' + lines
          await multiline(overflow)
          await m.waitForAnimationToEnd()
          const capped = await composerBoxes(m, ctx.surface, web)
          assert(
            Math.abs(capped.input.height - six.input.height) <= six.units,
            'Additional lines scroll within the cap'
          )
          if (web != null)
            assert(
              await web.page.$eval(
                '[data-testid="chat-composer"]',
                node => node.scrollHeight > node.clientHeight
              )
            )
          await capture(context + '-overflow')
          await clearChatComposer(m, platform, overflow, web)
          await input('Hello')
          await capture(context + '-restored-line', true)
          if (context === 'normal' && web != null) {
            const original = await web.page.evaluate(() => ({
              width: innerWidth,
              height: innerHeight
            }))
            try {
              await web.resize({ width: 390, height: 844 })
              await m.tapOn(field)
              assert.equal(await read(), 'Hello')
              await capture('narrow-hello', true)
            } finally {
              await web.resize(original)
            }
          } else if (context === 'normal' && platform === 'ios') {
            const initial = boxOf((await m.hierarchy()) as Node)
            assert(initial != null)
            const portrait = initial.height >= initial.width
            try {
              await m.setOrientation(portrait ? 'LANDSCAPE_LEFT' : 'PORTRAIT')
              await until(async () => {
                const next = await composerBoxes(m, ctx.surface, web)
                return Math.abs(next.viewport - initial.width) > 1
                  ? true
                  : undefined
              }, 'the rotated composer')
              await m.tapOn(field)
              assert.equal(await read(), 'Hello')
              await capture('rotated-hello', true)
            } finally {
              await m.setOrientation(portrait ? 'PORTRAIT' : 'LANDSCAPE_LEFT')
            }
          }
          await clearChatComposer(m, platform, 'Hello', web)
          if (context !== 'normal') {
            const cancel = 'Cancel ' + context
            await m.tapOn(
              platform === 'ios' ? { id: cancel } : { text: '^' + cancel + '$' }
            )
          }
          await wait(200)
        }
        await ctx.checkpoint('composer-cleared', {
          expect: [field],
          readBack: async () => {
            assert(await empty())
            const after = await author.engine.open(f.conversationId)
            assert(
              !after.messages.some(msg => msg.mine && !originalIds.has(msg.id)),
              'Editing the draft must not send a message'
            )
          }
        })
      } finally {
        try {
          await clearOwnedDraft?.()
        } finally {
          try {
            if (seeded != null)
              await author.engine.deleteMessage(f.conversationId, seeded)
          } finally {
            author.engine.stop()
          }
        }
      }
    }
  }
})
