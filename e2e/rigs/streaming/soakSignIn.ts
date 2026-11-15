import { readFileSync } from 'node:fs'

import type { MaestroDevice } from '../../core/maestro'

/** What the soak's sign-ins need from the stack: its API and the mirror of its log. */
export interface SignInStack {
  api: string
  serverLog: string
  fetch?: typeof fetch
  readLog?: (path: string) => string
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  /**
   * Clears the stack's sign-in code limits before each request: the soak signs
   * one account in on seven surfaces, past the five codes an address may ask
   * for in fifteen minutes. A throwaway test stack only.
   */
  resetLimits?: () => Promise<void>
}

async function askForCode(
  stack: SignInStack,
  email: string
): Promise<Response> {
  await stack.resetLimits?.()
  return await post(stack, '/auth/email-code', { email })
}

async function post(
  stack: SignInStack,
  path: string,
  body: unknown,
  token?: string
): Promise<Response> {
  return await (stack.fetch ?? fetch)(
    `${stack.api.replace(/\/$/, '')}${path}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token == null ? {} : { authorization: `Bearer ${token}` })
      },
      body: JSON.stringify(body)
    }
  )
}

/** Waits for the stack's log to hold `pattern` past `offset`, and returns its first group. */
async function fromLog(
  stack: SignInStack,
  pattern: RegExp,
  offset: number
): Promise<string> {
  const read = stack.readLog ?? ((path: string) => readFileSync(path, 'utf8'))
  const sleep =
    stack.sleep ??
    (async (ms: number) => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  const end = Date.now() + (stack.timeoutMs ?? 30_000)
  for (;;) {
    const found = pattern.exec(read(stack.serverLog).slice(offset))
    if (found != null) return found[1]
    if (Date.now() > end) {
      throw new Error(`the stack's log never showed ${String(pattern)}`)
    }
    await sleep(500)
  }
}

function logLength(stack: SignInStack): number {
  return (stack.readLog ?? ((path: string) => readFileSync(path, 'utf8')))(
    stack.serverLog
  ).length
}

/** A one-time sign-in link's token, from the e-mail the stack logs instead of sending. */
export async function signInToken(
  stack: SignInStack,
  email: string
): Promise<string> {
  const offset = logLength(stack)
  const asked = await askForCode(stack, email)
  if (asked.status !== 202) {
    throw new Error(`the stack would not send a sign-in code: ${asked.status}`)
  }
  return await fromLog(
    stack,
    /link: https?:\/\/[^/\s]+\/signin\/([A-Za-z0-9_-]+)/,
    offset
  )
}

/** A session token for the account, through its e-mailed code. */
export async function sessionToken(
  stack: SignInStack,
  email: string
): Promise<string> {
  const offset = logLength(stack)
  await askForCode(stack, email)
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const code = await fromLog(
    stack,
    new RegExp(`sign-in code for ${escaped}: (\\d{6})`),
    offset
  )
  const verified = await post(stack, '/auth/email-code/verify', { email, code })
  if (verified.status !== 200) {
    throw new Error(`the stack refused the sign-in code: ${verified.status}`)
  }
  return ((await verified.json()) as { token: string }).token
}

/** Approves the code a TV shows, as the signed-in account would from its phone. */
export async function approveTvCode(
  stack: SignInStack,
  token: string,
  code: string
): Promise<void> {
  const approved = await post(
    stack,
    '/auth/tv/approve',
    { code: code.replace(/[–\-\s]/g, '').toLowerCase() },
    token
  )
  if (approved.status !== 204) {
    throw new Error(`the stack refused the TV's code: ${approved.status}`)
  }
}

/** The eight-letter code in a TV's on-screen text, written with or without its dash. */
export function tvCodeIn(text: string): string | undefined {
  return /\b([A-Z]{4}[–-]?[A-Z]{4})\b/.exec(text)?.[1]
}

/** A signed-out app shows this; a signed-in one does not. */
export const SIGNED_OUT = 'Sign in to TeamStation'

type LinkDevice = MaestroDevice

async function shown(
  device: LinkDevice,
  target: Record<string, unknown>,
  timeout: number
): Promise<boolean> {
  try {
    await device.assertVisible({ ...target, timeout })
    return true
  } catch {
    return false
  }
}

interface Node {
  id?: string
  text?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}

function nodes(node: Node | undefined): Node[] {
  if (node == null) return []
  return [node, ...(node.children ?? []).flatMap(nodes)]
}

/**
 * The first node whose text is exactly `text` and that lies on the screen (the
 * root's bounds): a text tap also matches longer labels, and a list keeps
 * rows that are scrolled away.
 */
function onScreen(root: Node, text: string): Node | undefined {
  const screen = root.bounds
  return nodes(root).find(
    node =>
      node.text === text &&
      node.bounds != null &&
      (screen == null ||
        (node.bounds.y >= screen.y &&
          node.bounds.y + node.bounds.height <= screen.y + screen.height))
  )
}

async function tapExactly(device: LinkDevice, text: string): Promise<void> {
  const found = onScreen((await device.hierarchy()) as Node, text)
  if (found?.bounds == null) throw new Error(`no "${text}" on screen`)
  const { x, y, width, height } = found.bounds
  await device.tapOnPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2)
  })
}

/**
 * Signs out whoever the app holds: the header's account button, Account in its
 * menu, then Sign out at the foot of the account page.
 */
export async function signOutApp(
  device: LinkDevice,
  pauseMs = 500
): Promise<void> {
  const account = nodes((await device.hierarchy()) as Node)
    .map(node => node.text ?? '')
    .find(text => text.startsWith('Account, '))
  if (account == null) throw new Error('signed in, but no account button')
  await device.tapOn({ text: account })
  await device.assertVisible({ text: 'Notifications', timeout: 5000 })
  await tapExactly(device, 'Account')
  // Sign out is at the foot of a long page. maestro's scroll reaches it on
  // iOS; on Android it stops short, and plain swipes get there.
  try {
    await device.scrollUntilVisible({
      element: { text: 'Sign out' },
      direction: 'DOWN',
      timeout: 20_000
    })
  } catch {
    // The swipes below take over.
  }
  for (let swipes = 0; ; swipes++) {
    if (onScreen((await device.hierarchy()) as Node, 'Sign out') != null) break
    if (swipes === 15) throw new Error('no Sign out on the account page')
    // From low on the screen to high, away from the page's text fields: a swipe
    // from the middle can land on the name field and only focus it.
    const root = (await device.hierarchy()) as Node
    const screen = nodes(root)
      .map(node => node.bounds)
      .filter((b): b is NonNullable<Node['bounds']> => b != null)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0]
    if (screen == null) await device.swipe({ direction: 'UP' })
    else {
      const x = Math.round(screen.x + screen.width / 2)
      await device.swipe({
        startX: x,
        startY: Math.round(screen.y + screen.height * 0.8),
        endX: x,
        endY: Math.round(screen.y + screen.height * 0.25),
        duration: 400
      })
    }
    // Let the page come to rest before reading where things are.
    await new Promise(resolve => setTimeout(resolve, pauseMs))
  }
  await tapExactly(device, 'Sign out')
  if (!(await shown(device, { text: SIGNED_OUT }, 15_000))) {
    throw new Error('Sign out did not return to the sign-in page')
  }
}

/**
 * Signs an installed app in through a sign-in link, unless it is signed in
 * already: the soak's account is the same for every run on a stack, and a new
 * stack's apps hold no session for it. `signOutApp` clears a device by hand.
 */
export async function signInApp(
  device: LinkDevice,
  appId: string,
  token: () => Promise<string>,
  options: { scheme?: string; openIn?: (link: string) => Promise<void> } = {}
): Promise<void> {
  await device.launchApp({ appId, stopApp: true })
  // Every run on a stack shares one account: an app signed in already holds it.
  if (!(await shown(device, { text: SIGNED_OUT }, 12_000))) return
  const link = `${options.scheme ?? 'teamstation'}://signin/${await token()}`
  if (options.openIn != null) await options.openIn(link)
  else await device.openLink({ link })
  if (await shown(device, { id: 'signInLinkSignIn' }, 5000)) {
    await device.tapOn({ id: 'signInLinkSignIn' })
  }
  if (await shown(device, { text: SIGNED_OUT }, 8000)) {
    throw new Error('the sign-in link left the app signed out')
  }
}
