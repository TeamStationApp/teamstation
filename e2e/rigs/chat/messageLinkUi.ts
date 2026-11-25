import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import type { Emulation } from '../../core/browserCdp'
import { signInWithPassword } from '../../core/fixtures'
import type { MaestroDevice } from '../../core/maestro'
import type { E2eContext, WebSession } from '../../core/spec'
import {
  appLink,
  openInApp,
  type ServerDevice,
  setServer
} from '../app/setServer'
import {
  flattenPublicHierarchy,
  iosPublicRead,
  type PublicNode
} from '../chat2Maestro'
import {
  authenticatedActor,
  type ChatLinkFixture,
  type providerFor
} from './messageLinkFixture'

const composer = { id: 'chat-composer' }

/** Reveal the target inside the native history. A precise tap uses settled bounds. */
export async function revealChatTarget(
  m: MaestroDevice,
  matches: (node: PublicNode) => boolean,
  offsetFromTop?: number
): Promise<NonNullable<PublicNode['bounds']>> {
  let previous: PublicNode['bounds']
  for (let attempt = 0; attempt < 8; attempt++) {
    const nodes = flattenPublicHierarchy(await m.hierarchy())
    const bounds = (id: string): PublicNode['bounds'] =>
      nodes.find(node => node.id === id && node.bounds != null)?.bounds
    const target = nodes.find(
      node => matches(node) && node.bounds != null
    )?.bounds
    const header = bounds('chat-conversation-identity')
    const composer = bounds('chat-composer-band')
    assert(target != null && header != null && composer != null)
    const pins = bounds('chat-pinned-band')
    const top = Math.max(
      header.y + header.height,
      pins == null ? 0 : pins.y + pins.height
    )
    const height = composer.y - top
    assert(height > 0, 'The message history must have visible space')
    const pressY = target.y + (offsetFromTop ?? target.height / 2)
    if (pressY > top + 8 && pressY < composer.y - 8) {
      if (
        offsetFromTop == null ||
        (previous?.x === target.x && previous.y === target.y)
      )
        return target
      previous = target
      await delay(200)
      continue
    }
    previous = undefined
    const x = Math.round(header.x + header.width / 2)
    const upper = Math.round(top + height * 0.25)
    const lower = Math.round(top + height * 0.75)
    const above = pressY <= top + 8
    await m.dragAndDrop({
      from: { point: `${x},${above ? upper : lower}` },
      to: { point: `${x},${above ? lower : upper}` },
      holdDuration: 10,
      duration: 400
    })
  }
  assert.fail('The selected target must be reachable in the message history')
}

export async function readChatComposer(
  m: MaestroDevice,
  platform: string,
  web?: WebSession
): Promise<string> {
  if (web != null) {
    return await web.page.$eval(
      '[data-testid="chat-composer"]',
      node => (node as HTMLTextAreaElement).value
    )
  }
  if (platform !== 'ios') {
    // Copying opens Android's clipboard preview over the composer, including
    // during motion recordings. The native editable field exposes the same text.
    const editors = flattenPublicHierarchy(await m.hierarchy()).filter(
      node =>
        node.id === composer.id &&
        (node.type === 'EditText' || node.type === 'android.widget.EditText')
    )
    assert(
      editors.length === 1 && typeof editors[0].text === 'string',
      'One Android composer with readable text is required'
    )
    return editors[0].text
  }
  const { element } = iosPublicRead(
    await m.hierarchyRaw(),
    composer,
    'TextView'
  )
  assert(element != null, 'The editable composer must be present')
  return element.value ?? ''
}

/** Clear the exact draft and verify the native field even when Android clears only a word. */
export async function clearChatComposer(
  m: MaestroDevice,
  platform: string,
  expected: string,
  web?: WebSession
): Promise<void> {
  if (platform === 'android') await m.tapOn(composer)
  assert.equal(await readChatComposer(m, platform, web), expected)
  await m.eraseText({ characters: expected.length })
  if (platform !== 'android') return
  // Android's accessibility Clear can leave React Native's value intact.
  // Use actual edit keys for any text the optimized command left behind.
  const remaining = await readChatComposer(m, platform, web)
  const hasSend = async (): Promise<boolean> =>
    flattenPublicHierarchy(await m.hierarchy()).some(
      node => node.id === 'chat-send'
    )
  if (
    remaining !== '' &&
    (remaining !== 'Message' ||
      (expected.includes(remaining) && (await hasSend())))
  ) {
    assert(expected.includes(remaining))
    let rightKeys = remaining.length
    while (rightKeys-- > 0) await m.pressKey({ key: 'DPAD_RIGHT' })
    let deleteKeys = remaining.length
    while (deleteKeys-- > 0) await m.pressKey({ key: 'BACKSPACE' })
  }
  const cleared = await readChatComposer(m, platform, web)
  if (cleared === '') return
  assert.equal(cleared, 'Message')
  if (!(await hasSend())) return
  // A staged file or an editable caption can keep Send visible on an empty
  // field. Insert one character to distinguish the actual value from its hint.
  await m.pressKey({ key: 'DPAD_RIGHT' })
  await m.inputText({ text: 'x', keyPress: true })
  const marked = await readChatComposer(m, platform, web)
  await m.pressKey({ key: 'BACKSPACE' })
  assert.equal(marked, 'x', 'The Android draft must be empty before typing')
  const restored = await readChatComposer(m, platform, web)
  assert(restored === '' || restored === 'Message')
}

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
    } else if (labels.includes('I’m 18 or Older')) {
      await m.tapOn({ id: 'chat-age-adult' })
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

export async function chatLinkUi(
  ctx: E2eContext,
  f: ChatLinkFixture,
  observer: Awaited<ReturnType<typeof providerFor>>,
  platform: 'ios' | 'android' | 'web',
  emulation?: Emulation,
  role = 'phone'
): Promise<{
  m: MaestroDevice & ServerDevice
  web?: WebSession
  room: string
  enter: () => Promise<void>
}> {
  const web =
    platform === 'web'
      ? await ctx.browser({ width: 880, height: 780 }, emulation)
      : undefined
  const appId = 'app.teamstation.develop'
  const m: MaestroDevice & ServerDevice =
    web?.m ?? (await ctx.attach(role, { platform, appId }))
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
      udid: ctx.device(role),
      appId,
      simulator,
      device: m
    })
    const labels = flattenPublicHierarchy(await m.hierarchy()).map(
      node => node.text
    )
    if (labels.includes('Sign in')) await m.tapOn({ text: '^Sign in$' })
    if (labels.includes('Use a password instead') || labels.includes('Sign in'))
      await signInWithPassword(m, observer.person)
  }
  const enter = async (): Promise<void> => {
    if (web != null) await m.openLink({ link: f.origin + room })
    else {
      assert(platform === 'ios' || platform === 'android')
      await openInApp({
        platform,
        udid: ctx.device(role),
        appId,
        device: m,
        simulator,
        link: appLink(room)
      })
    }
    await waitForComposer(m, observer, platform, web)
  }
  return { m, web, room, enter }
}
