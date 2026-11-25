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
