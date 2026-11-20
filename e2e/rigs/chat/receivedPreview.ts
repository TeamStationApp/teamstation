import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import type { HTTPRequest } from 'puppeteer'

import type { MessageView } from '../../../src/app/chat/engine/apply'
import {
  androidScopedBounds,
  flattenPublicHierarchy
} from '../../../src/test/chat2Maestro.e2e'
import type { MaestroDevice } from '../../core/maestro'
import type { WebSession } from '../../core/spec'
import {
  authenticatedActor,
  type ChatLinkFixture,
  type providerFor
} from './messageLinkFixture'

/** Hold only the authenticated thumbnail lookup for this new incoming message. */
export async function receiveWithDelayedImage(
  web: WebSession | undefined,
  thumbnailId: string,
  origin: string,
  receive: () => Promise<MessageView>
): Promise<MessageView> {
  if (web == null) return await receive()
  const page = web.page
  const path = '/chat/attachments/' + encodeURIComponent(thumbnailId)
  const held: HTTPRequest[] = []
  let waiting = true
  const intercept = (request: HTTPRequest): void => {
    if (request.isInterceptResolutionHandled()) return
    const url = new URL(request.url())
    if (
      waiting &&
      request.method() === 'GET' &&
      url.origin === origin &&
      url.pathname.endsWith(path)
    )
      held.push(request)
    else request.continue().catch(() => {})
  }
  const release = async (): Promise<void> => {
    waiting = false
    await Promise.all(
      held.splice(0).map(async request => {
        await request.continue().catch(() => {})
      })
    )
  }
  await page.setRequestInterception(true)
  page.on('request', intercept)
  try {
    const received = await receive()
    const row = '[data-testid="chat-message-' + received.id + '"]'
    const image = row + ' [data-testid="chat-message-preview-thumbnail"]'
    const until = Date.now() + 10000
    while (held.length === 0 && Date.now() < until) await delay(50)
    assert(held.length > 0, 'Expected the actual recipient thumbnail request')
    assert.equal(await page.$(image), null)
    await page.$eval(row, el => {
      el.scrollIntoView({ block: 'center' })
    })
    const geometry = async (): Promise<number[]> =>
      await page.$eval(row, async el => {
        await new Promise<void>(resolve =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              resolve()
            })
          )
        )
        const rect = el.getBoundingClientRect()
        return [rect.top, rect.height]
      })
    const [top, height] = await geometry()
    assert(top < (await page.evaluate(() => innerHeight)) && top + height > 0)
    await release()
    await page.waitForSelector(image, { visible: true, timeout: 15000 })
    const [afterTop, afterHeight] = await geometry()
    assert(
      Math.abs(afterTop - top) <= 2,
      'Loading the image moved the visible incoming message'
    )
    assert(
      Math.abs(afterHeight - height) <= 2,
      'The preview changed the message height when its image arrived'
    )
    return received
  } finally {
    await release()
    page.off('request', intercept)
    await page.setRequestInterception(false)
  }
}

/** Exercise the card itself and read the member's authoritative cursor while it is covered. */
export async function checkCoveredPreview(
  m: MaestroDevice,
  web: WebSession | undefined,
  platform: string,
  fixture: ChatLinkFixture,
  peer: Awaited<ReturnType<typeof providerFor>>,
  received: MessageView
): Promise<void> {
  const actor = await authenticatedActor(fixture, fixture.observer, 'provider')
  const cursor = async (): Promise<number> =>
    (await actor.client.chatReads(fixture.conversationId)).find(
      read => read.userId === actor.person.userId
    )?.seq ?? 0
  const url = received.preview!.url
  const original = web?.page.url()
  const row = { id: 'chat-message-' + received.id }
  if (web != null) {
    await m.tapOn({
      css: '[data-testid="' + row.id + '"] [data-testid="chat-link-preview"] a'
    })
    const target = await web.page
      .browser()
      .waitForTarget(target => target.url() === url, { timeout: 12000 })
    const tab = await target.page()
    assert(tab != null)
    await tab.bringToFront()
    await m.switchTab({ url })
    await web.page.waitForFunction(
      () => document.hidden || !document.hasFocus(),
      { timeout: 10000 }
    )
  } else if (platform === 'android') {
    const box = androidScopedBounds(await m.hierarchy(), {
      id: 'chat-message-preview-thumbnail',
      childOf: row
    })
    await m.tapOn({
      point:
        Math.round(box.x + box.width / 2) +
        ',' +
        Math.round(box.y + box.height / 2)
    })
    assert(fixture.defaultBrowserPackage != null)
    const prefix = fixture.defaultBrowserPackage + ':id/'
    const until = Date.now() + 12000
    while (
      !flattenPublicHierarchy(await m.hierarchy()).some(
        n => n.id?.startsWith(prefix) === true
      )
    ) {
      assert(Date.now() < until, 'The selected Android browser must be visible')
      await delay(100)
    }
  } else {
    await m.tapOn({ id: 'chat-open-preview-with-thumbnail', childOf: row })
    await m.assertVisible({
      text: '^(Done|Close|Close Browser)$',
      timeout: 12000
    })
  }
  try {
    const before = await cursor()
    const incoming = await peer.engine.sendText(
      fixture.conversationId,
      'While you were reading ' + randomUUID().slice(0, 8)
    )
    assert(incoming != null && incoming.seq > before)
    // Allow the socket and the visible-read debounce to run while the browser is foreground.
    for (let i = 0; i < 5; i++) {
      await delay(300)
      assert.equal(
        await cursor(),
        before,
        'The covered conversation advanced its read cursor'
      )
    }
  } finally {
    if (web != null) {
      await m.closeTab()
      await m.switchTab({ url: original })
    } else if (platform === 'android') await m.pressKey({ key: 'BACK' })
    else await m.tapOn({ text: '^(Done|Close|Close Browser)$' })
  }
  await m.assertVisible({ id: 'chat-composer', timeout: 12000 })
}
