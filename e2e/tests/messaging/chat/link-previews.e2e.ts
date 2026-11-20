import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import type { HTTPRequest } from 'puppeteer'

import type { ChatLinkPreview } from '../../../../src/common/chatLinkPreview'
import {
  androidScopedBounds,
  exactText
} from '../../../rigs/chat2Maestro'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { fixtureFor, providerFor } from '../../../rigs/chat/messageLinkFixture'
import { chatLinkUi, readChatComposer } from '../../../rigs/chat/messageLinkUi'
import {
  checkCoveredPreview,
  receiveWithDelayedImage
} from '../../../rigs/chat/receivedPreview'

async function send(ctx: E2eContext): Promise<void> {
  const f = fixtureFor(ctx)
  const page = f.previewPage
  assert(
    page != null,
    'A public CORS-enabled fixture page and its expected title are required'
  )
  const author = await providerFor(f, f.observer)
  try {
    const peer = await providerFor(f, f.sender)
    try {
      const platform =
        ctx.surface === 'ios-app'
          ? 'ios'
          : ctx.surface === 'android-app'
            ? 'android'
            : 'web'
      const { m, web, enter } = await chatLinkUi(ctx, f, author, platform, {
        observeNetwork: true
      })
      let pageReads = 0
      const thumbnailUrls = new Set<string>()
      const externalReads: string[] = []
      let receiving = false
      let imageReads = 0
      const inspectedPosts: Array<Promise<boolean>> = []
      const fixtureUrl = new URL(page.url).href
      const deniedUrl =
        page.corsDeniedUrl == null
          ? undefined
          : new URL(page.corsDeniedUrl).href
      web?.page.on('request', request => {
        const url = new URL(request.url())
        if (
          receiving &&
          (url.href === fixtureUrl ||
            url.href === deniedUrl ||
            thumbnailUrls.has(url.href))
        )
          externalReads.push(url.href)
        if (url.href === fixtureUrl || url.href === deniedUrl) pageReads++
        else if (
          request.resourceType() === 'fetch' &&
          request.frame()?.url().endsWith('/chat-link-preview.html') === true
        ) {
          imageReads++
          if (!receiving) thumbnailUrls.add(url.href)
        }
        if (
          request.method() === 'POST' &&
          url.origin === f.origin &&
          url.pathname.endsWith('/messages')
        ) {
          inspectedPosts.push(
            request.fetchPostData().then(
              envelope =>
                envelope != null &&
                envelope !== '' &&
                !envelope.includes(page.title) &&
                !envelope.includes(page.url),
              () => false
            )
          )
        }
      })
      await enter()
      let readyPreview: ChatLinkPreview | undefined
      const outgoing = async (
        mode: 'ready' | 'dismissed' | 'pending' | 'cors-denied',
        beforeSend?: (url: string) => Promise<void>
      ): Promise<void> => {
        const fixtureAddress =
          mode === 'cors-denied'
            ? page.corsDeniedUrl
            : mode === 'pending' && web == null
              ? page.pendingUrl
              : page.url
        assert(fixtureAddress != null, 'Configure the fixture URL for ' + mode)
        const probe = randomUUID()
        const address = new URL(fixtureAddress)
        if (mode === 'pending' && web == null)
          address.searchParams.set('probe', probe)
        const url = address.href
        const body = 'Preview ' + mode + ' ' + probe.slice(0, 8) + ' ' + url
        await m.tapOn({ id: 'chat-composer' })
        await m.inputText({ text: body })
        // A native hierarchy read can outlast a pending preview. Observe the
        // request immediately. The peer verifies the exact body after Send.
        if (mode !== 'pending' || web != null)
          assert.equal(await readChatComposer(m, platform, web), body)
        if (mode === 'ready' || mode === 'dismissed') {
          await m.assertVisible({
            id: 'chat-dismiss-link-preview',
            timeout: 12000
          })
          if (mode === 'ready' && web == null)
            await m.assertVisible({
              id: 'chat-draft-preview-thumbnail',
              timeout: 15000
            })
          if (mode === 'ready' && web != null) {
            await web.page.waitForFunction(
              () => {
                const dismiss = document.querySelector(
                  '[data-testid="chat-dismiss-link-preview"]'
                )
                if (dismiss == null) return false
                const card = dismiss.closest(
                  '[data-testid="chat-link-preview"]'
                )
                return (
                  card != null &&
                  (card.querySelector('img[src^="data:image/"]') != null ||
                    Array.from(
                      card.querySelectorAll<HTMLElement>('[style]')
                    ).some(el =>
                      el.style.backgroundImage.includes('data:image/')
                    ))
                )
              },
              { timeout: 15000 }
            )
          }
          if (mode === 'dismissed')
            await m.tapOn({ id: 'chat-dismiss-link-preview' })
        }
        if (mode === 'pending') await beforeSend?.(url)
        if (web != null && mode !== 'cors-denied') {
          const initialReads = pageReads
          for (const size of [
            { width: 1200, height: 780 },
            { width: 390, height: 780 }
          ]) {
            await web.resize(size)
            await web.page.waitForFunction(
              (wide, draft, ready) => {
                const field = Array.from(
                  document.querySelectorAll<HTMLTextAreaElement>(
                    '[data-testid="chat-composer"]'
                  )
                ).find(el => {
                  const bounds = el.getBoundingClientRect()
                  return (
                    document.elementFromPoint(
                      bounds.x + bounds.width / 2,
                      bounds.y + bounds.height / 2
                    ) === el
                  )
                })
                if (field == null) return false
                if (field.value !== draft) return false
                const composer = field.closest(
                  '[data-testid="chat-composer-band"]'
                )
                if (
                  composer == null ||
                  (composer.querySelector(
                    '[data-testid="chat-dismiss-link-preview"]'
                  ) !=
                    null) !==
                    ready
                )
                  return false
                // The navigation stack retains covered scenes. Inspect the scene
                // that owns the visible field, even when another list is underneath it.
                const workspace = field.closest(
                  '[data-testid="chat-workspace"]'
                )
                if (workspace == null) return false
                const list = workspace.querySelector(
                  '[data-testid="chat-list-pane"]'
                )
                if (list == null) return false
                if (!wide) return list.getBoundingClientRect().width === 0
                return (
                  list.getBoundingClientRect().width > 0 &&
                  list.getBoundingClientRect().right <=
                    field.getBoundingClientRect().left
                )
              },
              { timeout: 12000 },
              size.width >= 960,
              body,
              mode === 'ready'
            )
          }
          if (mode !== 'pending')
            assert.equal(
              pageReads,
              initialReads,
              'Restoring a ready or dismissed draft must reuse its preview decision'
            )
          await m.tapOn({ id: 'chat-composer' })
        }
        if (mode === 'cors-denied') await delay(5500)
        if (mode !== 'pending') await beforeSend?.(url)
        if (web != null) await m.pressKey({ key: 'Enter' })
        else await m.tapOn({ text: '^Send$' })
        const until = Date.now() + 30000
        for (;;) {
          const view = await peer.engine.open(f.conversationId)
          const seen = view.messages.find(message => message.body === body)
          if (seen != null) {
            assert.equal(seen.status, 'ok')
            if (mode === 'ready') {
              assert.equal(seen.preview?.title, page.title)
              assert.equal(seen.preview.url, new URL(url).href)
              readyPreview = seen.preview
              await m.assertVisible({ text: page.title, timeout: 10000 })
            } else assert.equal(seen.preview, undefined)
            break
          }
          assert(
            Date.now() < until,
            'Other member must decrypt the submitted message'
          )
          await delay(250)
        }
      }
      await outgoing('ready')
      await outgoing('dismissed')
      if (web == null) {
        await outgoing('pending', async url => {
          const deadline = Date.now() + 10000
          while (Date.now() < deadline) {
            const probe = await fetch(url, {
              method: 'HEAD',
              cache: 'no-store',
              signal: AbortSignal.timeout(2000)
            })
            if (probe.status === 204) return
            assert.equal(
              probe.status,
              404,
              'Unexpected pending fixture response'
            )
            await delay(80)
          }
          assert.fail(
            'The phone must start the external request before sending'
          )
        })
      } else {
        let held: HTTPRequest | undefined
        const intercept = (request: HTTPRequest): void => {
          if (request.isInterceptResolutionHandled()) return
          if (request.url() === fixtureUrl) held = request
          else request.continue().catch(() => {})
        }
        await web.page.setRequestInterception(true)
        web.page.on('request', intercept)
        try {
          await outgoing('pending', async () => {
            const deadline = Date.now() + 12000
            while (Date.now() < deadline) {
              if (held != null) return
              await delay(30)
            }
            assert.fail('The pending preview must start its external request')
          })
        } finally {
          await held?.abort().catch(() => {})
          web.page.off('request', intercept)
          await web.page.setRequestInterception(false)
        }
      }
      if (web != null && page.corsDeniedUrl != null)
        await outgoing('cors-denied')
      assert(readyPreview != null)
      const { thumbnail, ...metadata } = readyPreview
      const receivedPreview: ChatLinkPreview = { ...metadata }
      assert(
        thumbnail != null,
        'The ready fixture includes an encrypted thumbnail'
      )
      {
        const bytes = await peer.engine.openPreviewThumbnail(thumbnail)
        assert.equal(bytes.length, thumbnail.size)
        receivedPreview.thumbnail = await peer.engine.uploadPreviewThumbnail(
          f.conversationId,
          {
            bytes,
            contentType: thumbnail.contentType,
            width: thumbnail.width,
            height: thumbnail.height,
            fileName: 'preview.jpg'
          }
        )
      }
      receiving = true
      const fileName = 'practice-' + randomUUID().slice(0, 8) + '.txt'
      assert(receivedPreview.thumbnail != null)
      const received = await receiveWithDelayedImage(
        web,
        receivedPreview.thumbnail.id,
        f.origin,
        async () => {
          const incoming = await peer.engine.attach(
            f.conversationId,
            [
              {
                fileName,
                contentType: 'text/plain',
                bytes: new TextEncoder().encode('Practice notes')
              }
            ],
            'Shared back ' + randomUUID().slice(0, 8) + ' ' + page.url,
            { preview: receivedPreview }
          )
          assert(incoming != null)
          assert.equal(incoming.attachments.length, 1)
          await enter()
          await m.assertVisible({
            id: 'chat-message-' + incoming.id,
            timeout: 15000
          })
          await m.assertVisible({ text: fileName, timeout: 12000 })
          return incoming
        }
      )
      if (web == null) {
        const row = { id: 'chat-message-' + received.id }
        if (platform === 'android') {
          // Android may publish the title on several cards. Read the subtree
          // of this incoming message from a single device snapshot.
          const deadline = Date.now() + 15000
          for (;;) {
            const tree = await m.hierarchy()
            try {
              androidScopedBounds(tree, {
                text: exactText(page.title),
                childOf: row
              })
              androidScopedBounds(tree, {
                id: 'chat-message-preview-thumbnail',
                childOf: row
              })
              break
            } catch (error) {
              if (Date.now() >= deadline) throw error
              await delay(150)
            }
          }
        } else {
          await m.assertVisible({
            text: page.title,
            childOf: row,
            timeout: 12000
          })
          await m.assertVisible({
            id: 'chat-open-preview-with-thumbnail',
            childOf: row,
            timeout: 12000
          })
        }
      }
      const openReport = async (): Promise<void> => {
        if (web != null) {
          await m.tapOn({
            css:
              '[data-testid="chat-message-' +
              received.id +
              '"] [aria-label="More message actions"]'
          })
        } else {
          await m.longPressOn({ id: 'chat-message-' + received.id })
        }
        await m.tapOn({ text: '^Report$' })
        await m.assertVisible({ id: 'chat-safety-confirm' })
      }
      await openReport()
      await m.tapOn({ id: 'chat-safety-cancel' })
      await m.assertNotVisible({ id: 'chat-safety-confirm' })
      if (web == null) {
        await m.waitForAnimationToEnd()
        await m.assertVisible({ id: 'chat-message-' + received.id })
      }
      await openReport()
      const reply = web?.page.waitForResponse(
        response =>
          new URL(response.url()).pathname.endsWith('/chat/reports') &&
          response.request().method() === 'POST'
      )
      await m.tapOn({ id: 'chat-safety-confirm' })
      await m.assertVisible({
        text: '.*administrators can now read that message.*',
        timeout: 15000
      })
      if (reply != null) {
        const response = await reply
        assert.equal(response.status(), 201)
        assert.equal((await response.json()).verified, true)
        const payload = JSON.parse((await response.request().fetchPostData())!)
        assert.equal(payload.messageId, received.id)
        assert.deepEqual(JSON.parse(payload.plaintext), {
          type: 'text',
          body: received.body,
          mentions: [],
          attachments: received.attachments
        })
      }
      if (web != null) {
        const selector =
          '[data-testid="chat-message-' +
          received.id +
          '"] [data-testid="chat-link-preview"]'
        await web.page.waitForSelector(selector, { timeout: 12000 })
        assert(
          (await web.page.$eval(selector, card => card.textContent))?.includes(
            page.title
          ) === true
        )
        assert(thumbnail != null)
        assert(pageReads > 0 && imageReads > 0 && thumbnailUrls.size > 0)
        const sealedPosts = await Promise.all(inspectedPosts)
        assert(
          sealedPosts.length >= 3 &&
            sealedPosts.every(privateEnvelope => privateEnvelope)
        )
        assert.equal(
          externalReads.length,
          0,
          'Receiving and reopening must not fetch the external page or image'
        )
        writeFileSync(
          ctx.artifact('request-privacy.txt'),
          [
            'Scenario messaging/chat/link-previews#send on web-chromium',
            'Sender page requests: ' + pageReads,
            'Sender thumbnail requests: ' + imageReads,
            'Inspected encrypted message requests: ' + sealedPosts.length,
            'Message requests disclosing the typed URL or preview title: 0',
            'Receiver external page or image requests on reopen: 0',
            'User submitted a verified report containing only the original message.',
            'Other member opened the encrypted thumbnail: ' +
              thumbnail.size +
              ' bytes'
          ].join('\n') + '\n'
        )
      }
      await checkCoveredPreview(m, web, platform, f, peer, received)
    } finally {
      peer.engine.stop()
    }
  } finally {
    author.engine.stop()
  }
}

export default defineE2e({
  id: 'messaging/chat/link-previews',
  title: 'Chat members receive the sender’s private link preview',
  kind: 'e2e',
  covers: [
    'src/app/chat/*Preview*',
    'src/app/chat/preview*',
    'src/app/chat/linkPreview*',
    'src/common/chatLinkPreview.ts',
    'src/app/chat/engine/send.ts',
    'src/app/chat/engine/decrypt.ts',
    'src/app/chat/engine/apply.ts',
    'crates/chat-link-preview/**',
    'crates/chat-crypto/src/preview.rs',
    'native/linkPreview/**',
    'ios/TeamStation/ChatPreview/**'
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
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: { send }
})
