import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  flattenPublicHierarchy,
  iosPublicRead
} from '../../../../src/test/chat2Maestro.e2e'
import { signInWithPassword } from '../../../core/fixtures'
import type { MaestroDevice } from '../../../core/maestro'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import {
  appLink,
  openInApp,
  type ServerDevice,
  setServer
} from '../../../rigs/app/setServer'
import {
  authenticatedActor,
  destinationPage,
  fixtureFor,
  providerFor
} from '../../../rigs/chat/messageLinkFixture'

const composer = { id: 'chat-composer' }
const exact = (s: string): string =>
  '^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'

async function waitForComposer(
  m: MaestroDevice,
  observer: Awaited<ReturnType<typeof providerFor>>,
  platform: string,
  web?: WebSession
): Promise<void> {
  let approved = false
  let readySince: number | undefined
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const nodes = flattenPublicHierarchy(await m.hierarchy())
    const labels = nodes.map(node => node.text ?? '')
    if (web != null) {
      const notices = await web.page.$$eval(
        '[role="dialog"],[aria-modal="true"]',
        dialogs => dialogs.map(dialog => dialog.textContent)
      )
      if (
        notices.some(
          text =>
            text != null &&
            text.includes('asks to read your chats') &&
            text.includes('Later')
        )
      ) {
        await m.tapOn({ text: '^Later$', timeout: 5000 })
        readySince = undefined
        continue
      }
    }
    if (
      labels.includes('Later') &&
      labels.some(label => label.includes('asks to read your chats'))
    ) {
      await m.tapOn({ text: '^Later$', timeout: 5000 })
    } else if (labels.includes('Use a password instead')) {
      await signInWithPassword(m, observer.person)
    } else if (labels.includes('I’m 13 or Older')) {
      await m.tapOn({ text: 'I’m 13 or Older' })
    } else if (nodes.some(node => node.id === 'notification-ask-not-now')) {
      await m.tapOn({ id: 'notification-ask-not-now' })
    } else if (
      nodes.some(node => node.id === composer.id) ||
      (web != null &&
        (await web.page.$('[data-testid="chat-composer"]')) != null)
    ) {
      // Give the initial app-level request and notification dialogs time to mount.
      if (readySince != null && Date.now() - readySince > 1500) return
      readySince ??= Date.now()
    } else if (!approved) {
      if (web != null)
        labels.push(
          ...(await web.page.$$eval('[aria-label^="Six-digit code "]', nodes =>
            nodes.map(node => node.getAttribute('aria-label')!)
          ))
        )
      const code = labels
        .map(label => /^(?:Six-digit code )?(\d{3})\s?(\d{3})$/.exec(label))
        .find(Boolean)
      if (code != null) {
        await observer.approve(code[1] + code[2], platform)
        approved = true
      }
    }
    await delay(300)
  }
  throw new Error('The signed-in synthetic conversation did not open')
}

async function openExternal(
  m: MaestroDevice,
  web: WebSession | undefined,
  platform: string,
  url: string,
  keyboard = false,
  activeBrowser?: () => Promise<void>
): Promise<void> {
  const original = web?.page.url()
  const path = new URL(url)
  const marker = path.pathname + path.search + path.hash
  if (keyboard && web != null) {
    await m.evalBrowserScript({
      script: `const link = document.querySelector('a[href="' + ${JSON.stringify(url)} + '"]'); link.focus(); return document.activeElement === link`
    })
    await m.pressKey({ key: 'Enter' })
  } else {
    await m.tapOn(
      web == null
        ? { text: exact(url), timeout: 8000 }
        : { css: 'a[href="' + url + '"]', timeout: 8000 }
    )
  }
  if (web != null) {
    const target = await web.page
      .browser()
      .waitForTarget(target => target.url() === url)
    const page = await target.page()
    assert(page != null)
    await page.waitForSelector('#address', { visible: true })
    assert.deepEqual(
      await page.$eval('#address', el => [
        el.textContent,
        location.href,
        window.opener === null
      ]),
      [marker, url, true]
    )
    await m.switchTab({ url })
    await m.closeTab()
    await m.switchTab({ url: original })
  } else {
    await m.assertVisible({ text: exact(marker), timeout: 20000 })
    if (platform === 'ios') {
      // Done dismisses the app's Safari sheet.
      await m.tapOn({ text: '^(Done|Close|Close Browser)$' })
    } else {
      await activeBrowser?.()
      await m.pressKey({ key: 'BACK' })
    }
  }
  await m.assertVisible({ ...composer, timeout: 10000 })
}

async function showLink(
  m: MaestroDevice,
  web: WebSession,
  url: string
): Promise<void> {
  const selector = 'a[href="' + url + '"]'
  await web.page.waitForFunction(
    (selector: string) =>
      document.querySelector(selector) != null ||
      document.querySelector('[data-testid="chat-jump-latest"]') != null,
    { timeout: 10000 },
    selector
  )
  if ((await web.page.$(selector)) == null) {
    await m.tapOn({ id: 'chat-jump-latest', timeout: 5000 })
    await web.page.waitForSelector(selector, { timeout: 10000 })
  }
  await m.evalBrowserScript({
    script: `
    const link=document.querySelector('a[href="' + ${JSON.stringify(url)} + '"]')
    if (!link) throw Error('Expected the message link in its chat row')
    link.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})
    for (let n=0;n<15;n++) {
      await new Promise(resolve=>setTimeout(resolve,80))
      const r=link.getClientRects()[0]
      if (r && link.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))) return true
    }
    throw Error('The message link is outside the readable viewport')`
  })
}

async function linkPosition(
  m: MaestroDevice,
  web: WebSession | undefined,
  url: string
): Promise<{ x: number; y: number }> {
  if (web != null) {
    return await web.page.$eval('a[href="' + url + '"]', el => {
      const bounds = el.getClientRects()[0]
      return {
        x: Math.round(bounds.x + bounds.width / 2),
        y: Math.round(bounds.y + bounds.height / 2)
      }
    })
  }
  const node = flattenPublicHierarchy(await m.hierarchy()).find(
    node => node.text === url && node.bounds != null
  )
  assert(node?.bounds != null, 'The visible link must expose its touch target')
  const { x, y, width, height } = node.bounds
  return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) }
}

// The Maestro web driver models longPressOn and swipe with a mouse. Use the
// browser's Touch objects on the same device to exercise its touch responder.
async function touchLink(
  m: MaestroDevice,
  url: string,
  move: boolean
): Promise<void> {
  await m.evalBrowserScript({
    script: `
    const link = document.querySelector('a[href="' + ${JSON.stringify(url)} + '"]')
    const rect = link.getClientRects()[0]
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
    function touch(type, dx, end = false) {
      const point = new Touch({identifier: 1, target: link, clientX: x + dx, clientY: y,
        pageX: x + dx + scrollX, pageY: y + scrollY, screenX: x + dx, screenY: y})
      link.dispatchEvent(new TouchEvent(type, {bubbles: true, cancelable: true,
        touches: end ? [] : [point], targetTouches: end ? [] : [point], changedTouches: [point]}))
    }
    touch('touchstart', 0)
    const dx = ${move ? -28 : 0}
    if (dx) {
      await new Promise(resolve => setTimeout(resolve, 120))
      touch('touchmove', dx)
    }
    await new Promise(resolve => setTimeout(resolve, 700))
    touch('touchend', dx, true)
    link.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, clientX:x+dx, clientY:y}))
    return true`
  })
}

async function cancelHold(
  m: MaestroDevice,
  web: WebSession | undefined,
  url: string
): Promise<void> {
  const before = await linkPosition(m, web, url)
  const browser = web?.page.browser()
  const pagesBefore = (await browser?.pages())?.length
  // Move farther than the message's hold tolerance before the half-second
  // deadline, horizontally so the row remains in the same reading position.
  if (web != null) await touchLink(m, url, true)
  else
    await m.swipe({
      startX: before.x,
      startY: before.y,
      endX: before.x - 28,
      endY: before.y,
      duration: 250
    })
  await m.assertNotVisible({ id: 'chat-message-spotlight', timeout: 1000 })
  await m.assertVisible(composer)
  assert.equal((await browser?.pages())?.length, pagesBefore)
  const after = await linkPosition(m, web, url)
  assert(
    Math.abs(after.y - before.y) <= 3,
    'Cancelling a link hold must preserve the reading position'
  )
}

async function waitForMenuDismissal(m: MaestroDevice): Promise<void> {
  const deadline = Date.now() + 10000
  do {
    const nodes = flattenPublicHierarchy(await m.hierarchy())
    if (
      nodes.some(node => node.id === composer.id) &&
      !nodes.some(node => node.id === 'chat-message-spotlight')
    )
      return
    await delay(200)
  } while (Date.now() < deadline)
  assert.fail(
    'The conversation must become accessible after the message menu closes'
  )
}

async function dismissComposerKeyboard(
  m: MaestroDevice,
  platform: string
): Promise<void> {
  // The WDA hideKeyboard command presses Return, which edits a multiline draft.
  if (platform === 'ios') await m.tapOnPoint({ point: '1%,28%' })
  else await m.hideKeyboard()
}

async function readComposer(
  m: MaestroDevice,
  platform: string
): Promise<string> {
  if (platform !== 'ios') return (await m.copyTextFrom(composer)).data
  const { element } = iosPublicRead(
    await m.hierarchyRaw(),
    composer,
    'TextView'
  )
  assert(element != null, 'The editable composer must be present')
  return element.value ?? ''
}

async function copyMessage(
  m: MaestroDevice,
  web: WebSession | undefined,
  url: string,
  body: string,
  platform: string
): Promise<void> {
  if (web != null) {
    await showLink(m, web, url)
    await touchLink(m, url, false)
  } else await m.longPressOn({ text: exact(url) })
  await m.assertVisible({ text: '^Copy$', timeout: 6000 })
  if (web != null) {
    const clone = await web.page.$(
      '[data-testid="chat-message-spotlight-preview"]'
    )
    assert(clone != null, 'Selected message preview must exist')
    assert.equal(
      await clone.$('a,[role=link]'),
      null,
      'Selected clone must be inert'
    )
  }
  await m.tapOn({ text: '^Copy$' })
  if (web != null) {
    assert.equal(
      await web.page.evaluate(async () => await navigator.clipboard.readText()),
      body
    )
  } else {
    await waitForMenuDismissal(m)
    await m.tapOn(composer)
    await m.longPressOn(composer)
    await m.tapOn({ text: '^Paste$' })
    const nodes = flattenPublicHierarchy(await m.hierarchy())
    if (nodes.some(node => node.text === 'Allow Paste'))
      await m.tapOn({ text: '^Allow Paste$' })
    assert.equal(
      await readComposer(m, platform),
      body,
      'Paste must put the complete message in the editable composer'
    )
    await m.eraseText({ characters: body.length })
    await dismissComposerKeyboard(m, platform)
  }
}

async function verifyWrappedAttention(
  m: MaestroDevice,
  web: WebSession,
  sender: Awaited<ReturnType<typeof providerFor>>,
  room: string,
  reader: string,
  url: string
): Promise<void> {
  const history = `document.querySelector('[data-testid="chat-message-history"]')`
  const count = { id: 'chat-attention-count' }
  const size = async (width: number): Promise<void> => {
    await web.page.setViewport({
      width,
      height: 780,
      hasTouch: true,
      isMobile: true
    })
  }
  await size(590)
  const filler = Array.from(
    { length: 32 },
    (_, i) => 'Score sheet line ' + (i + 1)
  ).join('\n')
  const spacer = await sender.engine.sendText(room, filler)
  assert(spacer != null)
  await web.page.waitForSelector(
    '[data-testid="chat-message-body-' + spacer.id + '"]'
  )
  await m.evalBrowserScript({
    script: `
    const list = ${history}
    list.dispatchEvent(new WheelEvent('wheel', {bubbles:true,deltaY:-350}))
    list.scrollTop = Math.max(0,list.scrollHeight-list.clientHeight-350)
    await new Promise(resolve => setTimeout(resolve,450))
    if (list.scrollHeight-list.clientHeight-list.scrollTop < 260) throw Error('Reader must be above the live edge')
    return true`
  })
  const mention = await sender.engine.sendText(
    room,
    'Scoring details: ' +
      url +
      ' Review the next game on the updated schedule.'.repeat(7),
    { mentions: [reader] }
  )
  assert(mention != null)
  await m.assertVisible({ ...count, timeout: 15000 })
  const tail = await sender.engine.sendText(room, 'End of this score sheet.')
  assert(tail != null)
  const selector = '[data-testid="chat-message-body-' + mention.id + '"]'
  await web.page.waitForSelector(selector)
  let initialHeight = 0
  for (const step of ['partial', 'narrow', 'full']) {
    if (step === 'narrow') await size(395)
    const full = step === 'full'
    const result = await m.evalBrowserScript({
      script: `
      const list=${history}
      const body=document.querySelector(${JSON.stringify(selector)})
      const band=document.querySelector('[data-testid="chat-composer-band"]')
      const frameTop = document.querySelector('[data-testid="chat-conversation-identity"]').getBoundingClientRect().bottom
      for (let i=0;i<10;i++){
        const bottom=Math.min(list.getBoundingClientRect().bottom,band.getBoundingClientRect().top)
        const rect=body.getBoundingClientRect(), wanted=${full ? 'rect.height + 6' : '7'}
        const delta=rect.top-bottom+wanted
        if (Math.abs(delta) < 2 && i>0)
          return JSON.stringify([rect.height,rect.top,rect.bottom,bottom,frameTop])
        list.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:delta}))
        list.scrollTop+=delta
        await new Promise(resolve=>setTimeout(resolve,120))
      }
      throw Error('Could not place the measured linked row in the reading band')`
    })
    const [height, top, bottom, bandBottom, bandTop] = JSON.parse(
      result.data
    ) as number[]
    assert(height > 48, 'The linked message must wrap over multiple lines')
    if (full) {
      assert(
        top >= bandTop && bottom <= bandBottom,
        'The entire linked body must be readable'
      )
      await m.assertNotVisible({ ...count, timeout: 5000 })
    } else {
      assert(
        top < bandBottom && top + 24 > bandBottom,
        'Only part of the leading line must be readable'
      )
      await m.assertVisible(count)
      if (step === 'partial') initialHeight = height
      else
        assert(
          height > initialHeight,
          'Narrowing the viewport must rewrap the same body'
        )
    }
  }
}

async function open(ctx: E2eContext): Promise<void> {
  const f = fixtureFor(ctx)
  const observer = await providerFor(f, f.observer)
  try {
    const sender = await providerFor(f, f.sender)
    try {
      const dest = await destinationPage(f.destinationHost)
      const platform =
        ctx.surface === 'ios-app'
          ? 'ios'
          : ctx.surface === 'android-app'
            ? 'android'
            : 'web'
      const adb = (...args: string[]): string =>
        execFileSync('adb', ['-s', ctx.device('phone'), ...args], {
          stdio: 'pipe',
          encoding: 'utf8'
        })
      let reversed = false
      try {
        if (platform === 'android' && f.destinationHost == null) {
          adb('reverse', '--no-rebind', 'tcp:' + dest.port, 'tcp:' + dest.port)
          reversed = true
        }
        const web =
          platform === 'web'
            ? await ctx.browser({ width: 880, height: 780 })
            : undefined
        const appId = 'app.teamstation.develop'
        const m: MaestroDevice & ServerDevice =
          web?.m ?? (await ctx.attach('phone', { platform, appId }))
        const simulator =
          platform === 'ios' && (await m.platformInfo()).isSimulator === true
        const room = '/chat/' + encodeURIComponent(f.conversationId)
        if (web != null) {
          await web.page.browserContext().setCookie({
            name: 'ts_session',
            value: (await authenticatedActor(f, f.observer, 'browser')).token,
            domain: new URL(f.origin).hostname,
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
          })
          await m.grantPermissions({
            origin: f.origin,
            permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
          })
        } else {
          assert(platform === 'ios' || platform === 'android')
          await setServer({
            platform,
            origin: f.origin,
            udid: ctx.device('phone'),
            appId,
            simulator,
            device: m
          })
          const labels = flattenPublicHierarchy(await m.hierarchy()).map(
            node => node.text
          )
          if (labels.includes('Sign in')) await m.tapOn({ text: '^Sign in$' })
          if (
            labels.includes('Use a password instead') ||
            labels.includes('Sign in')
          )
            await signInWithPassword(m, observer.person)
        }
        const enter = async (): Promise<void> => {
          if (web != null) await m.openLink({ link: f.origin + room })
          else {
            assert(platform === 'ios' || platform === 'android')
            await openInApp({
              platform,
              udid: ctx.device('phone'),
              appId,
              device: m,
              simulator,
              link: appLink(room)
            })
          }
          await waitForComposer(m, observer, platform, web)
        }
        await enter()
        const id = randomUUID().slice(0, 8)
        const first = dest.origin + '/score/' + id + '?side=away#first'
        const second = dest.origin + '/sheet/' + id + '?day=2#caption'
        const internal = f.origin + '/schedule#' + id
        const body =
          'Fixture ' +
          id +
          ': ' +
          first +
          (web == null ? '.\n' : ' and ') +
          internal +
          '. See www.example.org, example.technology, notes.pdf and 2.50.'
        const caption = 'Score sheet ' + id + ': ' + second
        await m.tapOn(composer)
        await m.inputText({ text: body })
        if (web != null) await m.pressKey({ key: 'Enter' })
        else {
          await m.tapOn({ text: '^Send$', timeout: 8000 })
          await dismissComposerKeyboard(m, platform)
        }
        const deadline = Date.now() + 20000
        let sentId: string | undefined
        while (sentId == null && Date.now() < deadline) {
          const latest = await observer.engine.open(f.conversationId)
          sentId = latest.messages.find(
            message => message.mine && message.body === body
          )?.id
          if (sentId == null) await delay(350)
        }
        assert(
          sentId != null,
          'The bound UI actor must send the exact text to the configured room'
        )
        const row = '[data-testid="chat-message-' + sentId + '"]'
        const renderedBody = '[data-testid="chat-message-body-' + sentId + '"]'
        await sender.engine.fillGrants()
        const file = await sender.engine.attach(
          f.conversationId,
          [
            {
              fileName: 'scores.txt',
              contentType: 'text/plain',
              bytes: new TextEncoder().encode('Fixture scores')
            }
          ],
          caption
        )
        assert(
          file?.id != null && file.id !== '',
          'Encrypted attachment must have been posted'
        )
        if (web == null) {
          // A reader above the live edge stays on the same rows when the peer sends.
          // Use the same jump control as the reader to reveal the new attachment.
          await m.tapOn({
            id: 'chat-jump-latest',
            optional: true,
            timeout: 2500
          })
        }
        await m.assertVisible({ id: 'chat-message-' + file.id, timeout: 20000 })
        await m.assertVisible({ text: exact(second), timeout: 20000 })
        if (web != null) {
          const anchors = await web.page.$eval(renderedBody, el =>
            [...el.querySelectorAll('a')].map(link => [
              link.textContent,
              link.href
            ])
          )
          assert.deepEqual(anchors, [
            [first, first],
            [internal, internal],
            ['www.example.org', 'https://www.example.org/'],
            ['example.technology', 'https://example.technology/']
          ])
        }
        const activeBrowser = async (): Promise<void> => {
          if (ctx.device('phone').includes('@')) {
            assert(
              f.defaultBrowserPackage != null && f.defaultBrowserPackage !== '',
              'Set the leased phone’s default browser package in its fixture'
            )
            const prefix = f.defaultBrowserPackage + ':id/'
            const tree = flattenPublicHierarchy(await m.hierarchy())
            assert(
              tree.some(node => node.id?.startsWith(prefix) === true),
              'The selected browser must own the visible controls'
            )
            return
          }
          const userBrowser = adb(
            'shell',
            'cmd',
            'role',
            'get-role-holders',
            'android.app.role.BROWSER'
          )
            .trim()
            .split(/\s+/)
          const resumed = adb('shell', 'dumpsys', 'activity', 'activities')
            .split('\n')
            .find(line => /(?:mResumedActivity|topResumedActivity)/.test(line))
          assert(
            resumed != null &&
              userBrowser.some(
                pkg => pkg !== '' && resumed.includes(pkg + '/')
              ),
            'The user-selected Android browser must own the foreground activity'
          )
        }
        await openExternal(m, web, platform, first, false, activeBrowser)
        await openExternal(m, web, platform, second, true, activeBrowser)
        await m.tapOn(
          web == null
            ? { text: exact(internal), timeout: 8000 }
            : {
                css: renderedBody + ' a[href="' + internal + '"]',
                timeout: 8000
              }
        )
        await m.assertVisible({ text: '^Schedule$' })
        if (web != null) {
          await web.page.waitForFunction(
            () => location.pathname === '/schedule',
            { timeout: 10000 }
          )
          await m.evalBrowserScript({ script: 'history.back(); return true' })
        } else {
          await m.assertVisible({ text: '^Upcoming$', timeout: 10000 })
          // The Schedule tab is at the root, so returning uses the retained
          // Messages tab in the app's navigation.
          await m.tapOn({ text: '^(Messages|Chat)$' })
        }
        if (web == null)
          await m.assertVisible({ text: exact(first), timeout: 12000 })
        if (web != null) {
          await web.page.waitForFunction(
            (path: string) => location.pathname === path,
            { timeout: 10000 },
            room
          )
          await showLink(m, web, first)
          // A pointer entering the row reveals the desktop ellipsis. The
          // browser callback is scoped to the message the test just sent.
          await m.evalBrowserScript({
            script: `const row=document.querySelector(${JSON.stringify(row)}); row.dispatchEvent(new PointerEvent('pointerenter')); return true`
          })
          await m.tapOn({
            css: row + ' [aria-label="More message actions"]',
            timeout: 8000
          })
          await m.tapOn({ text: '^Copy text$', timeout: 8000 })
          assert.equal(
            await web.page.evaluate(
              async () => await navigator.clipboard.readText()
            ),
            body
          )
          await web.page.setViewport({
            width: 480,
            height: 780,
            hasTouch: true,
            isMobile: true
          })
          await enter()
        }
        if (web != null) await showLink(m, web, first)
        await cancelHold(m, web, first)
        await m.tapOn(composer)
        if (web != null) await showLink(m, web, second)
        const reading = await linkPosition(m, web, second)
        if (web != null) await touchLink(m, second, false)
        else await m.longPressOn({ text: exact(second) })
        await m.assertVisible({ text: '^Copy$' })
        if (web != null) {
          await m.pressKey({ key: 'Escape' })
          await m.assertNotVisible({
            id: 'chat-message-spotlight',
            timeout: 3500
          })
        } else {
          // With the keyboard up, the panel can cover the top of the screen.
          // The outside margin is still the backdrop.
          await m.tapOnPoint({ point: '1%,15%' })
          await waitForMenuDismissal(m)
        }
        const restored = await linkPosition(m, web, second)
        assert(
          Math.abs(restored.y - reading.y) <= 3,
          'Menu dismissal must preserve the visible message position'
        )
        // Type with no intervening tap, so a lost composer focus cannot pass.
        const draft = 'Draft ' + id
        await m.inputText({ text: draft })
        if (web == null) assert.equal(await readComposer(m, platform), draft)
        else
          assert.equal(
            await web.page.$eval(
              '[data-testid="chat-composer"]',
              field => (field as HTMLTextAreaElement).value
            ),
            draft
          )
        await m.eraseText({ characters: draft.length })
        if (web == null) await dismissComposerKeyboard(m, platform)
        await copyMessage(m, web, first, body, platform)
        await copyMessage(m, web, second, caption, platform)
        await m.assertVisible({ text: exact(second) })
        if (platform === 'android') {
          await m.longPressOn({ text: exact(second) })
          await m.assertVisible({ text: '^Copy$' })
          await m.pressKey({ key: 'BACK' })
          await waitForMenuDismissal(m)
        }
        if (web != null)
          await verifyWrappedAttention(
            m,
            web,
            sender,
            f.conversationId,
            observer.person.userId,
            first
          )
        await ctx.checkpoint('conversation', { expect: [composer] }, m)
      } finally {
        dest.close()
        if (reversed) adb('reverse', '--remove', 'tcp:' + dest.port)
      }
    } finally {
      sender.engine.stop()
      await sender.engine.idle()
    }
  } finally {
    observer.engine.stop()
    await observer.engine.idle()
  }
}

export default defineE2e({
  id: 'messaging/chat/message-links',
  title:
    'Chat links in text and file captions open their displayed destination',
  kind: 'e2e',
  covers: [
    'src/app/chat/chatMessageLinks.ts',
    'src/app/chat/ChatMessageText.tsx',
    'src/app/chat/chatBrowser*',
    'src/app/chat/NativeChatBrowser.ts',
    'src/app/chat/MessageBubble.tsx',
    'src/app/chat/ChatWorkspace.tsx',
    'src/app/chat/ConversationScreen.tsx',
    'ios/TeamStation/RCTChatBrowser.mm',
    'android/app/src/main/java/app/teamstation/app/browser/**'
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
  minutes: 8,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: { open }
})
