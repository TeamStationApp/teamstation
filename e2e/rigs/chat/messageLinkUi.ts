import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import { flattenPublicHierarchy } from '../../../src/test/chat2Maestro.e2e'
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
  authenticatedActor,
  type ChatLinkFixture,
  type providerFor
} from './messageLinkFixture'

const composer = { id: 'chat-composer' }

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
