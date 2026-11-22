import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { dismissNotificationAsk } from '../../../../src/test/notificationAsk'
import { decodeRaster } from '../../../../src/test/rasterImage'
import type { MaestroDevice } from '../../../core/maestro'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { fixtureFor, providerFor } from '../../../rigs/chat/messageLinkFixture'
import {
  chatLinkUi,
  clearChatComposer,
  readChatComposer
} from '../../../rigs/chat/messageLinkUi'
import {
  flattenPublicHierarchy,
  iosPublicRead,
  type PublicNode,
  until
} from '../../../rigs/chat2Maestro'

const field = { id: 'chat-composer' }
const panel = { id: 'chat-attachment-panel' }
const toggle = { id: 'chat-attachment-toggle' }
const filename = 'practice-lineup.txt'
const documentBytes = Buffer.from('Bring the lineup sheet to practice.\n')
function staysAligned(
  a: PublicNode['bounds'],
  b: PublicNode['bounds']
): boolean {
  return (
    a != null &&
    b != null &&
    Math.abs(a.y - b.y) <= 2 &&
    Math.abs(a.height - b.height) <= 2
  )
}

// The app stays mounted under an iOS system sheet. Tap the button on the
// sheet and wait for it to leave before interacting with the chat again.
async function tapIosSystemButton(
  m: MaestroDevice,
  matches: (node: PublicNode) => boolean,
  description: string
): Promise<void> {
  const button = async (): Promise<PublicNode | undefined> =>
    flattenPublicHierarchy(await m.hierarchy()).find(
      node =>
        node.type === 'Button' &&
        node.bounds != null &&
        node.bounds.width > 0 &&
        node.bounds.height > 0 &&
        matches(node)
    )
  const found = await until(button, description)
  assert(found.bounds != null)
  const { x, y, width, height } = found.bounds
  await m.tapOn({
    point: Math.round(x + width / 2) + ',' + Math.round(y + height / 2)
  })
  await until(
    async () => ((await button()) == null ? true : undefined),
    description + ' to leave the screen'
  )
}

function sourceLabelFits(
  nodes: PublicNode[],
  label: string,
  drawer: NonNullable<PublicNode['bounds']>,
  type: string
): boolean {
  // Android exposes the label separately. iOS combines the label and button.
  return nodes.some(node => {
    const bounds = node.bounds
    return (
      node.text === label &&
      node.type === type &&
      bounds != null &&
      bounds.height > 0 &&
      bounds.width > 0 &&
      bounds.y >= drawer.y - 1 &&
      bounds.y + bounds.height <= drawer.y + drawer.height + 1 &&
      bounds.x >= drawer.x - 1 &&
      bounds.x + bounds.width <= drawer.x + drawer.width + 1
    )
  })
}

const digest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

async function attach(ctx: E2eContext): Promise<void> {
  const f = fixtureFor(ctx)
  const platform =
    ctx.surface === 'web-chromium'
      ? 'web'
      : ctx.surface === 'ios-app'
        ? 'ios'
        : 'android'
  const author = await providerFor(f, f.observer)
  try {
    const peer = await providerFor(f, f.sender)
    try {
      const { m, web, enter } = await chatLinkUi(ctx, f, author, platform)
      await enter()
      if (web != null)
        await dismissNotificationAsk(web.page, { userId: author.person.userId })
      const native = f.composerPanel
      const sources =
        web == null
          ? (['Photos', 'Camera', 'File'] as const)
          : (['Photos', 'File'] as const)
      const receipts: string[] = []
      const tag = randomUUID().slice(0, 8)
      const composerGeometry = async (): Promise<
        Record<
          'field' | 'toggle' | 'send' | 'panel' | 'ime',
          PublicNode['bounds'] | undefined
        > & { labelsInside: boolean }
      > => {
        const nodes = flattenPublicHierarchy(await m.hierarchy())
        const drawer = nodes.find(node => node.id === panel.id)?.bounds
        return {
          labelsInside:
            drawer != null &&
            sources.every(label =>
              sourceLabelFits(
                nodes,
                label,
                drawer,
                platform === 'ios' ? 'Button' : 'TextView'
              )
            ),
          field: nodes.find(node => node.id === field.id)?.bounds,
          toggle: nodes.find(node => node.id === toggle.id)?.bounds,
          send: nodes.find(node => node.id === 'chat-send')?.bounds,
          panel: drawer,
          // Android's system input window is separate from the app's drawer.
          ime: nodes.find(
            node =>
              node.id === 'android:id/inputArea' &&
              node.bounds != null &&
              node.bounds.width > 0 &&
              node.bounds.height > 0
          )?.bounds
        }
      }
      type Geometry = Awaited<ReturnType<typeof composerGeometry>>
      const aligned = (a: Geometry, b: Geometry): boolean =>
        staysAligned(a.field, b.field) &&
        staysAligned(a.toggle, b.toggle) &&
        staysAligned(a.send, b.send)
      const draft = async (): Promise<string> =>
        platform === 'android'
          ? (flattenPublicHierarchy(await m.hierarchy()).find(
              node => node.id === field.id
            )?.text ?? '')
          : await readChatComposer(m, platform, web)
      const existing = await draft()
      // A native accessibility tree can expose either the placeholder or a
      // literal draft of “Message”. Only the latter has a text Send action.
      if (
        existing !== '' &&
        (web != null ||
          existing !== 'Message' ||
          (await composerGeometry()).send != null)
      ) {
        await m.tapOn(field)
        await clearChatComposer(m, platform, existing, web)
      }
      const openPanel = async (
        fromKeyboard = false,
        multiline = false
      ): Promise<void> => {
        const before = await web?.page.$eval(
          '[data-testid="chat-composer-field"]',
          el => el.getBoundingClientRect().top
        )
        const scrollBefore = await web?.page.$eval(
          '[data-testid="chat-message-history"]',
          el => el.scrollTop
        )
        if (fromKeyboard && web != null) {
          await m.tapOn(field)
          await m.pressKey({ key: 'Shift+Tab' })
          assert(
            await web.page.$eval(
              '[data-testid="chat-attachment-toggle"]',
              el => el === document.activeElement
            )
          )
          await m.pressKey({ key: 'Enter' })
        } else await m.tapOn(toggle)
        for (const source of sources)
          await m.assertVisible({ text: '^' + source + '$' })
        if (web != null) {
          const geometry = await web.page.evaluate(() => {
            const drawer = document
              .querySelector('[data-testid="chat-attachment-panel"]')!
              .getBoundingClientRect()
            const field = document
              .querySelector('[data-testid="chat-composer-field"]')!
              .getBoundingClientRect()
            const trigger = document
              .querySelector('[data-testid="chat-attachment-toggle"]')!
              .getBoundingClientRect()
            return {
              height: drawer.height,
              triggerHeight: trigger.height,
              fieldHeight: field.height,
              isInside: drawer.left >= 0 && drawer.right <= window.innerWidth,
              fieldTop: field.top,
              scrollTop: document.querySelector(
                '[data-testid="chat-message-history"]'
              )!.scrollTop,
              rows: Array.from(
                document.querySelectorAll(
                  '[data-testid="chat-attachment-panel"] [role="button"]'
                ),
                element => element.getBoundingClientRect().top
              ),
              gap: trigger.top - drawer.bottom,
              camera: document.querySelector('[aria-label="Camera"]') != null
            }
          })
          assert(geometry.height > 0 && geometry.height < 150)
          assert(geometry.isInside)
          assert.equal(geometry.rows.length, 2)
          assert(geometry.rows[1] > geometry.rows[0])
          assert.equal(geometry.fieldTop, before)
          assert.equal(geometry.scrollTop, scrollBefore)
          assert(geometry.gap >= 0 && geometry.gap < 20)
          assert(!geometry.camera)
          if (multiline)
            assert(geometry.fieldHeight > geometry.triggerHeight + 5)
          if (fromKeyboard) {
            const focusedSource = async (): Promise<string | null> =>
              await web.page.$eval(':focus', el =>
                el.getAttribute('aria-label')
              )
            assert.equal(await focusedSource(), 'Photos')
            await m.pressKey({ key: 'Tab' })
            assert.equal(await focusedSource(), 'File')
            await m.pressKey({ key: 'Shift+Tab' })
            assert.equal(await focusedSource(), 'Photos')
          }
        }
      }
      const photo = readFileSync('src/app/assets/sports/baseball-192.png')
      const imagePath = join(ctx.runDir, 'practice.png')
      const filePath = join(ctx.runDir, filename)
      writeFileSync(imagePath, photo)
      writeFileSync(filePath, documentBytes)
      for (const source of sources) {
        await m.tapOn(field)
        let caption =
          web == null && source === 'File'
            ? 'Practice copy of the lineup sheet. Bring it to the field before the first game. ' +
              tag
            : 'Practice ' + source + ' ' + tag
        await m.inputText({ text: caption, keyPress: platform === 'android' })
        if (web != null && source === 'File') {
          await m.pressKey({ key: 'Shift+Enter' })
          await m.inputText({ text: 'Second line' })
          caption += '\nSecond line'
        }
        if (web != null && source === 'Photos') {
          await m.tapOn({ css: '[role="button"][aria-label="Emoji"]' })
          await m.tapOn({ css: '[role="button"][aria-label="grinning face"]' })
          caption += '😀'
          await m.tapOn({ css: '[role="button"][aria-label="Cancel"]' })
        }
        assert.equal(await draft(), caption)
        // Typing can finish while the software keyboard is still moving.
        // Measure the resting composer before opening the attachment panel.
        if (web == null) await m.waitForAnimationToEnd()
        let previous: Geometry | undefined
        const before =
          web == null
            ? await until(async () => {
                const geometry = await composerGeometry()
                if (
                  geometry.field == null ||
                  geometry.toggle == null ||
                  geometry.send == null ||
                  (platform === 'android' && geometry.ime == null)
                )
                  return undefined
                if (
                  source === 'File' &&
                  geometry.field.height <= geometry.toggle.height + 2
                )
                  return undefined
                const settled = previous != null && aligned(previous, geometry)
                previous = geometry
                return settled ? geometry : undefined
              }, 'settled draft and Send before the panel opens')
            : undefined
        await openPanel(
          web != null && source === 'Photos',
          web != null && source === 'File'
        )
        if (web == null) {
          assert(
            before?.field != null &&
              before.toggle != null &&
              before.send != null
          )
          await until(async () => {
            const now = await composerGeometry()
            return now.field != null &&
              now.panel != null &&
              now.labelsInside &&
              (platform !== 'android' || now.ime == null) &&
              aligned(before, now) &&
              now.panel.y >= now.field.y + now.field.height - 2
              ? true
              : undefined
          }, 'attachment panel at the keyboard position')
          if (platform === 'ios')
            assert.equal(
              iosPublicRead(await m.hierarchyRaw(), {}, 'Keyboard').element,
              undefined
            )
          if (platform === 'android' && source === 'Photos') await m.back()
          else if (source === 'File') await m.tapOn(field)
          else await m.tapOn(toggle)
          await m.assertNotVisible(panel)
          await until(async () => {
            const current = await composerGeometry()
            if (
              !aligned(before, current) ||
              (platform === 'android' && current.ime == null)
            )
              return undefined
            if (
              platform === 'ios' &&
              iosPublicRead(await m.hierarchyRaw(), {}, 'Keyboard').element ==
                null
            )
              return undefined
            return true
          }, 'restored keyboard and composer')
          if (source === 'File') {
            await openPanel()
            const history = flattenPublicHierarchy(await m.hierarchy()).find(
              node => node.id === 'chat-message-history'
            )?.bounds
            assert(history != null)
            const x = history.x + 8
            const y = before.field.y - 80
            assert(y > history.y && y < history.y + history.height)
            await m.tapOn({ point: Math.round(x) + ',' + Math.round(y) })
            await m.assertNotVisible(panel)
            assert.equal(await draft(), caption)
            if (platform === 'ios')
              assert.equal(
                iosPublicRead(await m.hierarchyRaw(), {}, 'Keyboard').element,
                undefined
              )
            await m.tapOn(field)
          }
        } else {
          if (source === 'File') {
            const history = await web.page.$eval(
              '[data-testid="chat-message-history"]',
              element => {
                const bounds = element.getBoundingClientRect()
                const x = bounds.left + 3
                const y = bounds.top + bounds.height / 2
                const target = document.elementFromPoint(x, y)
                return target != null &&
                  element.contains(target) &&
                  target.closest('a,button,[role="button"],[role="link"]') ==
                    null
                  ? { x, y }
                  : null
              }
            )
            assert(history != null, 'a visible history margin outside the menu')
            await web.page.mouse.click(history.x, history.y)
            await m.assertNotVisible(panel)
            assert.equal(await draft(), caption)
            await openPanel()
          }
          await web.page.keyboard.press('Escape')
          await m.assertNotVisible(panel)
          assert(
            await web.page.$eval(
              '[data-testid="chat-composer"]',
              el => el === document.activeElement
            )
          )
        }
        assert.equal(await draft(), caption)
        const sourceButton = { text: '^' + source + '$' }
        for (const cancel of [true, false]) {
          await openPanel()
          if (web != null) {
            const [chooser] = await Promise.all([
              web.page.waitForFileChooser(),
              m.tapOn(sourceButton)
            ])
            assert(!chooser.isMultiple())
            const accept = await web.page.$eval(
              'input[type="file"]',
              el => el.accept
            )
            assert.equal(accept, source === 'Photos' ? 'image/*,video/*' : '')
            if (cancel) await chooser.cancel()
            else
              await chooser.accept([source === 'File' ? filePath : imagePath])
          } else {
            assert(
              native != null,
              'Configure the synthetic library photo and document on this phone'
            )
            await m.tapOn(sourceButton)
            if (source === 'Camera') {
              // First use can present the platform camera permission prompt.
              await m.tapOn({
                text: '^(While using the app|Allow|OK)$',
                optional: true,
                timeout: 1200
              })
              await m.assertVisible({ text: native.shutter })
            }
            if (cancel) {
              if (platform === 'android') await m.back()
              else {
                const ids =
                  source === 'Camera'
                    ? ['DismissImagePickerButton', 'DismissButton']
                    : ['Cancel', 'Close']
                await tapIosSystemButton(
                  m,
                  node =>
                    (node.id != null && ids.includes(node.id)) ||
                    (source === 'File' &&
                      (node.text === 'Cancel' || node.text === 'Close')),
                  'visible system picker dismissal button'
                )
              }
            } else if (source === 'Camera') {
              await m.tapOn({ text: native.shutter })
              if (platform === 'ios') {
                await m.assertVisible({ text: '^Retake$' })
                const acceptPhoto = new RegExp(native.acceptPhoto)
                await tapIosSystemButton(
                  m,
                  node =>
                    node.text === 'Use Photo' ||
                    (node.id === 'Done' &&
                      node.text != null &&
                      acceptPhoto.test(node.text)),
                  'accept the captured photo'
                )
                await m.assertNotVisible({ text: '^Retake$' })
              } else await m.tapOn({ text: native.acceptPhoto })
            } else if (source === 'Photos') {
              await m.tapOn({ text: native.libraryPhoto })
              await m.tapOn({
                text: '^(Add|Done)$',
                optional: true,
                timeout: 800
              })
            } else {
              for (const folder of native.documentFolders)
                await m.tapOn({ text: folder })
              if (platform === 'ios') {
                // Files exposes a separate filename label for renaming. Select
                // the document thumbnail inside its cell to import it.
                const documentCell = { id: 'practice-lineup, txt' }
                await m.tapOn({ ...documentCell, point: '50%,24%' })
                await m.tapOn({ text: '^Open$', optional: true, timeout: 800 })
                await m.assertNotVisible(documentCell)
              } else {
                await m.tapOn({ text: '^practice-lineup(?:\\.txt)?$' })
                await m.tapOn({ text: '^Open$', optional: true, timeout: 800 })
              }
            }
          }
          await m.assertVisible(field)
          assert.equal(await draft(), caption)
          if (cancel) await m.assertNotVisible({ id: 'chat-attachment-chip' })
          else {
            await m.assertVisible({ id: 'chat-attachment-chip' })
            if (source !== 'File') {
              await m.assertVisible({ id: 'chat-draft-photo' })
              if (web != null) {
                await web.page.waitForFunction(() => {
                  const image = document.querySelector<HTMLImageElement>(
                    '[data-testid="chat-draft-photo"] img'
                  )
                  return (
                    image != null && image.complete && image.naturalWidth > 0
                  )
                })
                const thumbnail = await web.page.$(
                  '[data-testid="chat-draft-photo"]'
                )
                assert(thumbnail != null)
                const { data } = decodeRaster(
                  Buffer.from(await thumbnail.screenshot())
                )
                // The baseball's red seams must be visible in the actual draft.
                let stitches = 0
                for (let i = 0; i < data.length; i += 4) {
                  if (
                    data[i] > 140 &&
                    data[i] > data[i + 1] * 1.6 &&
                    data[i] > data[i + 2] * 1.6
                  )
                    stitches++
                }
                assert(
                  stitches > 8,
                  'The staged thumbnail must show the chosen baseball'
                )
              }
              await m.waitForAnimationToEnd()
              writeFileSync(
                join(ctx.runDir, 'draft-' + source.toLowerCase() + '.png'),
                await m.screenshot()
              )
            }
          }
        }
        await m.tapOn({ text: '^Send$' })
        const received = await until(
          async () =>
            (await peer.engine.open(f.conversationId)).messages.find(
              msg => msg.body === caption && msg.status === 'ok' && !msg.mine
            ),
          'peer decryption of ' + source,
          45000
        )
        assert.equal(received.attachments.length, 1)
        const ref = received.attachments[0]
        const bytes = await peer.engine.openAttachment(ref)
        assert.equal(bytes.length, ref.size)
        assert(bytes.length > 0)
        if (source === 'File') {
          assert.equal(ref.fileName, filename)
          assert.deepEqual(Buffer.from(bytes), documentBytes)
        } else {
          assert(
            ref.contentType.startsWith('image/') &&
              (ref.width ?? 0) > 0 &&
              (ref.height ?? 0) > 0
          )
          if (web != null) assert.equal(digest(bytes), digest(photo))
          else if (source === 'Photos') {
            assert.equal(ref.width, native?.libraryWidth)
            assert.equal(ref.height, native?.libraryHeight)
          }
        }
        receipts.push(
          [
            source,
            ref.contentType,
            ref.width ?? '-',
            ref.height ?? '-',
            bytes.length,
            digest(bytes)
          ].join(' ')
        )
      }
      writeFileSync(
        join(ctx.runDir, 'recipient.txt'),
        [
          '$ e2e run messaging/chat/composer-panel#attach',
          ...receipts,
          ''
        ].join('\n')
      )
    } finally {
      peer.engine.stop()
    }
  } finally {
    author.engine.stop()
  }
}

export default defineE2e({
  id: 'messaging/chat/composer-panel',
  title:
    'Open the attachment panel and send a photo or file from each available source',
  kind: 'e2e',
  covers: [
    'src/app/chat/Composer.tsx',
    'src/app/chat/ChatViewport.tsx',
    'src/app/chat/ChatHistoryList.native.tsx',
    'src/app/chat/chatWebInteractions.ts',
    'src/app/chat/chatFiles*',
    'src/app/chat/ConversationScreen.tsx'
  ],
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
  minutes: 6,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: { attach }
})
