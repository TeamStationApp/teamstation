import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'

import { faultControl, requireDropletHandle } from '../core/dropletStack'
import type { FixtureAccount } from '../core/fixtures'
import type { MaestroDevice } from '../core/maestro'
import type { E2eContext } from '../core/spec'
import { browserAppOf, signInOnPhone } from './mobileWeb'
import { FixtureEmailRateLimit, scoringFixtureLink } from './scoringFixtureLink'

/** Use the fixture's real, one-use sign-in email. Check the cookie on the phone. */
export async function signInViewportScorer(
  ctx: E2eContext,
  phone: MaestroDevice,
  account: FixtureAccount
): Promise<void> {
  if (ctx.stack.attached == null)
    throw new Error('An isolated stack is required')
  const { faults } = requireDropletHandle(ctx.stack.attached)
  if (faults == null)
    throw new Error('The stack needs the fixture request observer')
  const control = faultControl(faults)
  const origin = ctx.stack.origin
  const verify = async (action: 'reset' | 'verify'): Promise<void> => {
    const run = randomUUID()
    const url = new URL('/viewportProbe/session.html', origin)
    // Safari can reuse a tab when only its fragment changes. Load a new document.
    url.searchParams.set('visit', run)
    url.hash = new URLSearchParams({
      action,
      run,
      actor: account.userId
    }).toString()
    await phone.openLink({ link: url.href, browser: true })
    const prefix = '/api/v1/viewport-session/' + run + '/'
    for (const until = Date.now() + 16000; Date.now() < until;) {
      const reply = (await control.call(
        'GET',
        'requests?path=' + encodeURIComponent(prefix)
      )) as {
        requests: Array<{ path: string }>
      }
      const last = reply.requests.at(-1)?.path
      if (last === prefix + 'ok') return
      if (last != null)
        throw new Error('Phone has an unexpected session after ' + action)
      await pause(400)
    }
    throw new Error('No browser session observation after ' + action)
  }
  await verify('reset')
  let link: string
  try {
    link = await scoringFixtureLink(ctx, account.email, 'web')
  } catch (error) {
    if (!(error instanceof FixtureEmailRateLimit)) throw error
    await signInOnPhone(
      phone,
      account,
      origin,
      browserAppOf(ctx.surface).platform === 'ios'
    )
    await verify('verify')
    return
  }
  try {
    await phone.openLink({
      link: origin + '/' + link.replace(/^signin\//, 'signin-browser/'),
      browser: true
    })
  } catch {
    throw new Error('The phone could not open the fixture sign-in link')
  }
  // Consume the link before leaving its route. Chrome can omit its text from
  // the accessibility hierarchy, so the cookie is independently checked below.
  await pause(3500)
  await verify('verify')
}

interface BrowserNode {
  id?: string
  text?: string
  type?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: BrowserNode[]
}

function descendants(root: BrowserNode): BrowserNode[] {
  return [root, ...(root.children ?? []).flatMap(descendants)]
}

async function tapBrowserControl(
  phone: MaestroDevice,
  matches: (node: BrowserNode) => boolean
): Promise<boolean> {
  const nodes = descendants((await phone.hierarchy()) as BrowserNode)
  const bounds = nodes.find(
    node =>
      (node.bounds?.height ?? 0) > 0 &&
      (node.bounds?.width ?? 0) > 0 &&
      matches(node)
  )?.bounds
  const screen = nodes.find(node => node.type === 'Application')?.bounds
  if (
    bounds == null ||
    (screen != null &&
      (bounds.y + bounds.height / 2 < screen.y ||
        bounds.y + bounds.height / 2 >= screen.y + screen.height))
  )
    return false
  await phone.tapOn({
    point:
      Math.round(bounds.x + bounds.width / 2) +
      ',' +
      Math.round(bounds.y + bounds.height / 2)
  })
  return true
}

/** iOS 26 puts Hide Toolbar inside the page menu’s More button. On iOS 27
 * it is visible in the first menu. Its ID and location also change by layout. */
export async function hideSafariToolbar(phone: MaestroDevice): Promise<void> {
  const menu = await tapBrowserControl(
    phone,
    node => node.text === 'Page Menu' || node.id === 'PageFormatMenuButton'
  )
  if (!menu) throw new Error('Safari did not show its Page Menu button')
  await pause(600)
  const hide = (node: BrowserNode): boolean =>
    node.id === 'HideToolbar' || /^Hide Toolbars?$/.test(node.text ?? '')
  if (await tapBrowserControl(phone, hide)) return
  if (await tapBrowserControl(phone, node => node.id === 'MoreMenuItem')) {
    await pause(600)
    if (await tapBrowserControl(phone, hide)) return
  }
  // The landscape popover initially shows only its first few actions.
  // Scroll inside the actual menu, leaving the scoring page stationary.
  const nodes = descendants((await phone.hierarchy()) as BrowserNode)
  const screen = nodes.find(node => node.type === 'Application')?.bounds
  const item = nodes.find(node => node.id === 'FindOnPage')?.bounds
  if (screen != null && item != null) {
    const x = Math.round(item.x + item.width / 2)
    const end = Math.round(Math.max(item.y, screen.y + screen.height * 0.23))
    const start = Math.round(screen.y + screen.height * 0.82)
    if (start > end)
      for (let attempt = 0; attempt < 3; attempt++) {
        await phone.swipe({
          start: x + ',' + start,
          end: x + ',' + end,
          duration: 430
        })
        await pause(400)
        if (await tapBrowserControl(phone, hide)) return
      }
  }
  throw new Error('Safari did not show the Hide Toolbar action')
}

/** A collapsed location bar is a small address pill at the top in landscape
 * and the Top layout, or at the foot of a portrait Bottom/Compact page. */
export async function reopenSafariToolbar(
  phone: MaestroDevice,
  portrait: boolean,
  layout: string | undefined
): Promise<void> {
  const pressed = await tapBrowserControl(
    phone,
    node =>
      node.id === 'TabBarItemTitle' ||
      node.id === 'MinimizedLocationBar' ||
      node.id === 'CollapsedLocationBar'
  )
  if (pressed) return
  await phone.tapOn({
    point: !portrait ? '50%,2%' : layout === 'top' ? '50%,9%' : '50%,98%'
  })
}
