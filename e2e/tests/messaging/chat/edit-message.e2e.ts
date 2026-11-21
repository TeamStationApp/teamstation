import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { MessageView } from '../../../../src/app/chat/engine/apply'
import { flattenPublicHierarchy } from '../../../../src/test/chat2Maestro.e2e'
import {
  dismissNotificationAsk,
  dismissNotificationAskOn
} from '../../../../src/test/notificationAsk'
import { isHubDevice } from '../../../core/maestro'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { fixtureFor, providerFor } from '../../../rigs/chat/messageLinkFixture'
import {
  chatLinkUi,
  clearChatComposer,
  readChatComposer,
  revealChatTarget
} from '../../../rigs/chat/messageLinkUi'

async function edit(ctx: E2eContext): Promise<void> {
  const f = fixtureFor(ctx)
  assert(f.previewPage != null)
  const author = await providerFor(f, f.observer)
  try {
    const peer = await providerFor(f, f.sender)
    try {
      const platform =
        ctx.surface === 'web-chromium'
          ? 'web'
          : ctx.surface === 'ios-app'
            ? 'ios'
            : 'android'
      const { m, web, enter } = await chatLinkUi(ctx, f, author, platform, {
        observeNetwork: true
      })
      const room = f.conversationId
      const tag = randomUUID().slice(0, 8)
      const originalCaption = 'Practice handouts ' + tag
      const files = ['Lineup for practice', 'Bring the bats'].map(
        (text, index) => ({
          fileName: index === 0 ? 'practice.txt' : 'lineup.txt',
          bytes: new TextEncoder().encode(text),
          contentType: 'text/plain'
        })
      )
      const original = await author.engine.attach(room, files, originalCaption)
      assert(
        original?.mine === true && original.attachments.length === files.length
      )
      const newest = await author.engine.sendText(
        room,
        'Thursday practice ' + tag
      )
      assert(newest?.mine === true)
      const incoming = await peer.engine.sendText(
        room,
        'See you at practice ' + tag
      )
      assert(incoming != null)
      await enter()
      if (web != null) {
        await dismissNotificationAsk(web.page, { userId: author.person.userId })
      }
      const row = (id: string): string => 'chat-message-' + id
      const openMenu = async (id: string): Promise<void> => {
        if (web != null) {
          const selector = '[data-testid="' + row(id) + '"]'
          const node = await web.page.waitForSelector(selector, {
            timeout: 15000
          })
          assert(node != null)
          await node.scrollIntoView()
          await node.hover()
          await m.tapOn({
            css: selector + ' [aria-label="More message actions"]'
          })
        } else {
          const target = { id: row(id) }
          await m.scrollUntilVisible({
            element: target,
            direction: 'up',
            timeout: 12000
          })
          const bubbleId = 'chat-bubble-' + id
          await revealChatTarget(m, node => node.id === bubbleId)
          await m.longPressOn({ id: bubbleId })
          await m.assertVisible({ text: '^Reply$' })
        }
      }
      const field = { id: 'chat-composer' }
      const enterText = async (text: string): Promise<void> => {
        await m.inputText({ text, keyPress: platform === 'android' })
        assert.equal(await readChatComposer(m, platform, web), text)
      }
      const pressLocalEscape = (): void => {
        execFileSync('adb', [
          '-s',
          ctx.device('phone'),
          'shell',
          'input',
          'keyboard',
          'keyevent',
          '111'
        ])
      }
      const editButton = { text: '^Edit$' }
      const draft = 'Please bring the equipment list.'
      await m.tapOn(field)
      await enterText(draft)
      if (web != null) {
        await web.page.evaluate(() => {
          const transfer = new DataTransfer()
          transfer.items.add(
            new File(['Team equipment list'], 'equipment.txt', {
              type: 'text/plain'
            })
          )
          const target = document.querySelector(
            '[data-testid="chat-drop-target"]'
          )
          if (target == null) throw Error('Attachment drop target unavailable')
          target.dispatchEvent(
            new DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            })
          )
        })
        await m.assertVisible({ text: '^Remove equipment.txt$' })
        await m.tapOn(field)
        const focused = async (): Promise<boolean> =>
          await web.page.$eval(
            '[data-testid="chat-composer"]',
            node => document.activeElement === node
          )
        assert(
          await focused(),
          'The staged draft field must have focus before the peer update'
        )
        const update = await peer.engine.sendText(
          room,
          'Equipment list confirmed ' + tag
        )
        assert(update != null)
        await m.assertVisible({ id: row(update.id) })
        assert(
          await focused(),
          'The peer update must preserve the focused draft'
        )
        const history = await web.page.waitForSelector(
          '[data-testid="chat-message-history"]'
        )
        assert(history != null)
        const earlier = web.page.waitForResponse(
          response => {
            const url = new URL(response.url())
            return (
              url.pathname.endsWith('/messages') &&
              url.searchParams.has('before') &&
              response.ok()
            )
          },
          { timeout: 20000 }
        )
        await history.hover()
        await web.page.mouse.wheel({ deltaY: -100000 })
        // Activate the public history control as assistive technology can, while the
        // composer keeps keyboard focus. Verify the request and the restored field.
        await history.evaluate(element => {
          const control = Array.from(
            element.querySelectorAll<HTMLElement>('button,[role="button"]')
          ).find(button => button.innerText.trim() === 'Load earlier messages')
          if (control == null)
            throw Error('The history fixture needs an earlier page')
          control.click()
        })
        await earlier
        const parked = await web.page.$eval(
          '[data-testid="chat-composer"]',
          node => ({
            focused: document.activeElement === node,
            value: (node as HTMLTextAreaElement).value
          })
        )
        assert.deepEqual(parked, { focused: true, value: draft })
        await m.assertVisible({ text: '^Remove equipment.txt$' })
        await web.page.mouse.wheel({ deltaY: 100000 })
      }
      await openMenu(original.id)
      await m.tapOn(editButton)
      await m.assertVisible({ text: '^Editing your message$' })
      if (web != null) {
        const state = await web.page.evaluate(() => {
          const input = document.querySelector<HTMLTextAreaElement>(
            '[data-testid="chat-composer"]'
          )
          const attach = document.querySelector('[aria-label="Attach"]')
          if (input == null || attach == null)
            throw Error(
              'Expected the focused edit field and its attachment button'
            )
          return {
            value: input.value,
            caret: input.selectionEnd,
            focused: document.activeElement === input,
            disabled:
              attach.getAttribute('aria-disabled') === 'true' ||
              attach.hasAttribute('disabled')
          }
        })
        assert.deepEqual(state, {
          value: originalCaption,
          caret: originalCaption.length,
          focused: true,
          disabled: true
        })
      }
      const dismissAsk = async (): Promise<void> => {
        await dismissNotificationAskOn(
          {
            assertVisible: async selector => await m.assertVisible(selector),
            tapOn: async selector => await m.tapOn(selector)
          },
          1500
        )
      }
      assert.equal(await readChatComposer(m, platform, web), originalCaption)
      if (platform === 'android' && !isHubDevice(ctx.device('phone'))) {
        // A menu edit brings up the IME over the parked draft. One physical
        // Escape must reach the editor before the IME can consume it.
        await m.tapOn(field)
        const imeVisible = (): boolean =>
          /\bmInputShown=true\b/.test(
            execFileSync(
              'adb',
              ['-s', ctx.device('phone'), 'shell', 'dumpsys', 'input_method'],
              { encoding: 'utf8' }
            )
          )
        const deadline = Date.now() + 5000
        while (!imeVisible() && Date.now() < deadline) await delay(100)
        assert(
          imeVisible(),
          'The soft keyboard must be shown before testing Escape'
        )
        pressLocalEscape()
        await m.assertNotVisible({ text: '^Editing your message$' })
        assert.equal(await readChatComposer(m, platform, web), draft)
        await openMenu(original.id)
        await m.tapOn(editButton)
        assert.equal(await readChatComposer(m, platform, web), originalCaption)
      }
      // Android's default element send-keys can replace a field. Type at the
      // live caret so the action exercises the same append as a keyboard.
      await m.inputText({ text: ' updated', keyPress: platform === 'android' })
      assert.equal(
        await readChatComposer(m, platform, web),
        originalCaption + ' updated'
      )
      await dismissAsk()
      // Use in-app Back so the two conversations retain their draft owner.
      await m.tapOn({ text: '^Back$', timeout: 10000 })
      const listId = 'chat-conversation-' + room
      await m.assertVisible({ id: listId })
      const other =
        web == null
          ? flattenPublicHierarchy(await m.hierarchy())
              .map(node => node.id)
              .find(
                id =>
                  id?.startsWith('chat-conversation-cnv_') === true &&
                  id !== listId
              )
          : await web.page.evaluate(
              current =>
                Array.from(
                  document.querySelectorAll<HTMLElement>(
                    '[data-testid^="chat-conversation-cnv_"]'
                  )
                )
                  .map(node => node.dataset.testid)
                  .find(id => id !== current),
              listId
            )
      assert(
        other != null,
        'The fixture needs a second conversation for switching'
      )
      await m.tapOn({ id: other })
      await m.assertVisible(field)
      await m.assertNotVisible({ text: '^Editing your message$' })
      await dismissAsk()
      await m.tapOn({ text: '^Back$', timeout: 10000 })
      await m.tapOn({ id: listId })
      await m.assertVisible({ text: '^Editing your message$' })
      assert.equal(
        await readChatComposer(m, platform, web),
        originalCaption + ' updated'
      )

      await dismissAsk()
      await m.tapOn({ text: '^Cancel edit$', timeout: 10000 })
      if (web != null) await m.assertVisible({ text: '^Remove equipment.txt$' })
      assert.equal(await readChatComposer(m, platform, web), draft)
      await openMenu(original.id)
      await m.tapOn(editButton)
      await clearChatComposer(m, platform, originalCaption, web)
      const editedCaption = 'Updated handouts ' + tag + ' ' + f.previewPage.url
      await enterText(editedCaption)
      await m.assertVisible({ id: 'chat-dismiss-link-preview', timeout: 18000 })
      await m.tapOn({ text: '^Send$' })
      const readBack = async (body: string): Promise<MessageView> => {
        const deadline = Date.now() + 30000
        do {
          const seen = (await peer.engine.open(room)).messages.find(
            message => message.id === original.id
          )
          if (seen?.body === body && seen.edited) return seen
          await delay(200)
        } while (Date.now() < deadline)
        throw Error(
          body === ''
            ? 'Peer did not receive the cleared caption on the original'
            : 'Peer did not receive the updated caption on the original'
        )
      }
      await m.assertNotVisible({
        text: '^Editing your message$',
        timeout: 12000
      })
      const received = await readBack(editedCaption)
      assert.equal(received.seq, original.seq)
      assert.equal(received.senderUserId, original.senderUserId)
      assert.equal(received.preview?.title, f.previewPage.title)
      assert.deepEqual(received.attachments, original.attachments)
      for (const [i, ref] of received.attachments.entries()) {
        const bytes = await peer.engine.openAttachment(ref)
        assert.equal(
          createHash('sha256').update(bytes).digest('hex'),
          createHash('sha256').update(files[i].bytes).digest('hex')
        )
      }
      await m.assertVisible({
        text: '^edited$',
        childOf: { id: row(original.id) }
      })
      await openMenu(original.id)
      await m.tapOn(editButton)
      await clearChatComposer(m, platform, editedCaption, web)
      await m.assertNotVisible({ id: 'chat-dismiss-link-preview' })
      // Removing the preview changes the composer height. Tap its settled Send
      // button after the card and multiline caption have collapsed.
      if (web == null) await m.waitForAnimationToEnd()
      await m.tapOn({ text: '^Send$' })
      await m.assertNotVisible({
        text: '^Editing your message$',
        timeout: 12000
      })
      const cleared = await readBack('')
      assert.deepEqual(cleared.attachments, original.attachments)
      assert.equal(cleared.preview, undefined)
      if (web != null) await m.tapOn({ text: '^Remove equipment.txt$' })
      await m.tapOn(field)
      await clearChatComposer(m, platform, draft, web)
      let keyboardReceipt = ''
      if (platform !== 'ios') {
        const emptyField = await readChatComposer(m, platform, web)
        if (web != null) await web.page.keyboard.press('ArrowUp')
        else await m.pressKey({ key: 'DPAD_UP' })
        await m.assertVisible({ text: '^Editing your message$' })
        assert.equal(await readChatComposer(m, platform, web), newest.body)
        if (web != null) {
          await web.page.keyboard.press('Escape')
          keyboardReceipt =
            'Chromium delivered Up and Escape to the focused field.'
        } else if (isHubDevice(ctx.device('phone'))) {
          try {
            await m.pressKey({ key: 'ESCAPE' })
            keyboardReceipt = 'The Android hub delivered Up and Escape.'
          } catch (error) {
            if (!/unknown key: escape/i.test(String(error))) throw error
            // Older hubs have no Escape mapping. The companion Android run
            // exercises that key locally with the same signed app.
            await m.tapOn({ text: '^Cancel edit$' })
            keyboardReceipt =
              'The Android hub delivered Up. Cancel restored the draft on this phone. This driver has no Escape mapping.'
          }
        } else {
          pressLocalEscape()
          keyboardReceipt =
            'Android delivered Up and one keyboard Escape for each menu and keyboard edit.'
        }
        await m.assertNotVisible({ text: '^Editing your message$' })
        assert.equal(await readChatComposer(m, platform, web), emptyField)
      }
      await openMenu(incoming.id)
      await m.assertNotVisible(editButton)
      writeFileSync(
        join(ctx.runDir, 'recipient.txt'),
        [
          '$ e2e run messaging/chat/edit-message#edit',
          'The peer decrypted two unchanged ordinary files after the original caption was edited and cleared.',
          'The message ID, sequence, author, file keys and digests matched. The edited caption regenerated its private preview.',
          'The incoming message menu omitted Edit.',
          keyboardReceipt
        ]
          .filter(Boolean)
          .join('\n') + '\n'
      )
    } finally {
      peer.engine.stop()
    }
  } finally {
    author.engine.stop()
  }
}

export default defineE2e({
  id: 'messaging/chat/edit-message',
  title: 'Authors edit their original chat message or caption',
  kind: 'e2e',
  covers: [
    'src/app/chat/Composer.tsx',
    'src/app/chat/ConversationScreen.tsx',
    'src/app/chat/MessageMenu.tsx',
    'src/app/chat/chatWorkspaceModel.ts',
    'src/app/chat/chatWebInteractions*',
    'android/app/src/main/java/app/teamstation/app/chat/ChatHardwareKeys.kt'
  ],
  stack: 'seat',
  fixtures: [],
  exclusive: true,
  surfaces: {
    'web-chromium': { devices: [] },
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'none' }]
    },
    'android-app': {
      devices: [{ role: 'phone', needs: ['android-phone'], hardware: 'none' }]
    }
  },
  services: ['api'],
  apps: [],
  secrets: ['chatLinkFixture'],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: { edit }
})
