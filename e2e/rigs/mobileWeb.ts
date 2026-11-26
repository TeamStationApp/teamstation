import { BlockedError } from '../core/result'
import type { Surface } from '../core/spec'

/** The phone browser a web surface runs in, by its app id. */
export function browserAppOf(surface: Surface): {
  platform: 'ios' | 'android'
  appId: string
} {
  if (surface === 'web-safari-ios')
    return { platform: 'ios', appId: 'com.apple.mobilesafari' }
  if (surface === 'web-chrome-android')
    return { platform: 'android', appId: 'com.android.chrome' }
  throw new BlockedError(`${surface} is not a phone browser`)
}

/**
 * Opens `url` in the phone browser of `surface` on the device the role's
 * lease names: the browser is brought forward and the address opened in it,
 * so the page is the web app as a person on that phone has it. Driven, as
 * any device is, through maestro-d (`tapOn`, `inputText`, `assertVisible` on
 * the web view's accessibility tree).
 */
export async function openMobileBrowser(
  surface: Surface,
  attach: (options: Record<string, unknown>) => Promise<any>,
  url: string
): Promise<any> {
  const { platform, appId } = browserAppOf(surface)
  const m = await attach({ platform, appId })
  // As a phone is held: a shared phone can be left on its side.
  await m.run([{ setOrientation: 'PORTRAIT' }]).catch(() => undefined)
  // Android's Chrome starts clean, no session or tab of an earlier run
  // kept; Safari cannot be cleared from here, so a run signs out there.
  await m.launchApp(
    platform === 'android'
      ? { appId, clearState: true }
      : { appId, stopApp: false }
  )
  await pastFirstRun(m)
  await m.openLink({ link: url, browser: true })
  // Some of Chrome's questions rise a moment after the page opens.
  await new Promise(resolve => setTimeout(resolve, 4000))
  await pastFirstRun(m)
  return m
}

/**
 * A browser on a phone that has not been set up asks first: Chrome's
 * sign-in and its notification and search-engine choices. Each is answered
 * the way a person who only wants the page would.
 */
const FIRST_RUN = [
  'Use without an account',
  'Accept & continue',
  'No thanks',
  'No, thanks',
  'Got it',
  'Not now'
]

export async function pastFirstRun(m: any): Promise<void> {
  for (let round = 0; round < 4; round++) {
    let answered = false
    for (const text of FIRST_RUN) {
      try {
        await m.assertVisible({ text, timeout: 1500 })
        await m.tapOn({ text })
        answered = true
      } catch {
        // Not asked.
      }
    }
    if (!answered) return
  }
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Moves the page up once more, clear of the app's bar, which floats over its
 * foot. Swiped in the window's middle: a swipe from its foot starts on
 * Safari's address bar.
 */
export async function clearOfBar(m: any): Promise<void> {
  await m.swipe({ start: '50%,60%', end: '50%,35%' })
  await sleep(800)
}

/** A field's centre, from a node's bounds, as a tap point. */
export function centre(bounds: {
  x: number
  y: number
  width: number
  height: number
}): string {
  return `${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)}`
}

/**
 * The page's text inputs, top to bottom, the browser's own address bar
 * left out. In a phone browser a web field carries no name of its own (the
 * label drawn above it is another node), so it is found where it is.
 */
export async function pageFields(
  m: any
): Promise<Array<{ bounds: any; type: string; id: string }>> {
  const found: Array<{ bounds: any; type: string; id: string }> = []
  const walk = (node: any): void => {
    if (node == null) return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    const attributes = node.attributes ?? {}
    const type = String(node.type ?? attributes.class ?? '')
    const id = String(node.id ?? attributes['resource-id'] ?? '')
    if (
      /EditText|TextField|SecureTextField/.test(type) &&
      !/url_bar|^URL$|^Address$|TabBarItemTitle/i.test(id) &&
      node.bounds != null
    )
      found.push({ bounds: node.bounds, type, id })
    walk(node.children)
  }
  walk(await m.hierarchy())
  return found
    .filter(field => field.bounds.y > 200)
    .sort((a, b) => a.bounds.y - b.bounds.y)
}

/** The password form in a phone's browser. */
export async function signInOnPhone(
  m: any,
  account: { email: string; password: string },
  origin: string,
  /**
   * Safari names each field by its label, and a field is tapped by that
   * name only: a tap at a place can reach Safari's own address bar, and
   * what is typed there goes to a web search.
   */
  ios: boolean
): Promise<void> {
  // The browser keeps the last run's session: out of it first, from the
  // account page, which shows the sign-in form instead when there is none.
  for (let attempt = 0; attempt < 3; attempt++) {
    await m.openLink({ link: `${origin}/account`, browser: true })
    await sleep(3000)
    await pastFirstRun(m)
    const signedOut: boolean = await m
      .assertVisible({ text: 'Sign in to TeamStation', timeout: 5000 })
      .then(
        () => true,
        () => false
      )
    if (signedOut) break
    try {
      // Past every team an administrator holds, which can be many.
      await m.scrollUntilVisible({
        element: { text: 'Sign out' },
        direction: 'DOWN',
        speed: 100,
        timeout: 240000
      })
      await clearOfBar(m)
      await m.tapOn({ text: 'Sign out' })
      await sleep(3000)
    } catch {
      // Not on the page yet: looked for again.
    }
  }
  // A phone's window can hold the form below the fold.
  await m.openLink({ link: `${origin}/`, browser: true })
  await sleep(2000)
  await pastFirstRun(m)
  await m.scrollUntilVisible({
    element: { text: 'Use a password instead' },
    direction: 'DOWN',
    timeout: 30000
  })
  await m.tapOn({ text: 'Use a password instead' })
  await sleep(1500)
  if (ios) {
    await m.tapOn({ id: 'E-mail address' })
    await sleep(1000)
    await m.inputText({ text: account.email })
    // The iPad keyboard may omit Next while the labelled password field
    // remains visible. Focus that field before typing the password.
    try {
      await m.tapOn({ id: '^Next$', timeout: 2000 })
    } catch {
      await m.tapOn({ id: '^Password$', timeout: 5000 })
    }
    await m.inputText({ text: account.password })
  } else {
    const fields = await pageFields(m)
    if (fields.length < 2)
      throw new Error(`the password form shows ${fields.length} fields`)
    await m.tapOn({ point: centre(fields[0].bounds) })
    await m.eraseText({ characters: 80 }).catch(() => undefined)
    await m.inputText({ text: account.email })
    // The keyboard covers the next field: put away, the field is tapped,
    // found again where the page moved to.
    await m.hideKeyboard().catch(() => undefined)
    await sleep(800)
    const password = (await pageFields(m))[1]
    if (password == null) throw new Error('no password field')
    await m.tapOn({ point: centre(password.bounds) })
    await m.inputText({ text: account.password })
  }
  // Sent from the keyboard, as a person on a phone sends the form.
  await m.pressKey({ key: 'Enter' })
  // Signed in: the sign-in form is gone. A phone's keyboard can drop a
  // key, so the password is typed again, up to twice more.
  for (let attempt = 0; ; attempt++) {
    try {
      await m.assertNotVisible({
        text: 'Sign in to TeamStation',
        timeout: 30000
      })
      break
    } catch (caught: unknown) {
      if (attempt === 2) throw caught
    }
    await m.hideKeyboard().catch(() => undefined)
    if (ios) await m.tapOn({ id: 'Password' })
    else {
      const password = (await pageFields(m))[1]
      if (password == null) throw new Error('no password field to type again')
      await m.tapOn({ point: centre(password.bounds) })
    }
    await sleep(800)
    await m.eraseText({ characters: 80 }).catch(() => undefined)
    await sleep(500)
    await m.inputText({ text: account.password })
    await sleep(500)
    await m.hideKeyboard().catch(() => undefined)
    // Gone already when the keyboard's return signed in: checked above.
    await m.tapOn({ text: 'Sign in', index: 1 }).catch(() => undefined)
  }
  await sleep(2000)
}
