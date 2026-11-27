import type { FixtureAccount } from '../../src/server/dev/fixtures/accounts'
import { type BusyRetryOptions, retryWhileBusy } from './busyRetry'
import { typeInto } from './typeInto'

/**
 * The password form, on any surface and at any width: the native apps, a
 * phone's browser and a desktop browser whose home has the navigation
 * sidebar instead of the phone header's "TeamStation menu".
 *
 * `fixtures.ts`'s `signInWithPassword` stays as it is for the streaming
 * freeze; every harness sign-in comes here.
 */

/** The form's own controls. Each one names only itself on the screen. */
const USE_PASSWORD = 'Use a password instead'
const USE_CODE = 'Use a sign-in code'
/** The API's answer while every password job is taken (`src/server/auth/passwords.ts`). */
const BUSY = 'Password verification is busy'

/** How long each try waits for the home screen; the last waits longest. */
const TRY_MS = 8000
const LAST_TRY_MS = 20000
const TRIES = 3

/** `text` as a maestro-d regex that matches it exactly, metacharacters and all. */
function literal(text: string): string {
  return text.replace(/[\]\\^]/g, '\\$&').replace(/[.*+?${}()|[]/g, '[$&]')
}

/**
 * What only a signed-in screen shows, at every width: the account button,
 * "Account, <name>" (with ", notifications waiting" while some are), which
 * the phone header and the wide sidebar both have. It is a regex, so
 * maestro-d matches it the same way on the web and on the phones.
 */
export function signedInMark(account: { displayName?: string }): string {
  const name =
    account.displayName == null || account.displayName === ''
      ? '.+'
      : literal(account.displayName)
  return `^Account, ${name}(, notifications waiting)?$`
}

async function visible(
  device: any,
  text: string,
  timeout: number
): Promise<boolean> {
  return await device.assertVisible({ text, timeout }).then(
    () => true,
    () => false
  )
}

/** The busy answer, as `retryWhileBusy` knows it. */
class FormBusy extends Error {
  readonly code = 'unavailable'
  constructor() {
    super(`${BUSY}: the sign-in form said so`)
  }
}

/**
 * Puts the form on its password view with both fields empty. On the native
 * iOS app a try can leave it on the code view, where "Password" would find
 * "Use a password instead" and the password would go into the e-mail
 * field; from the password view it goes to the code view and back, which
 * empties the password and drops the last error.
 */
async function openPasswordForm(device: any): Promise<void> {
  if (await visible(device, USE_CODE, 2000)) {
    await device.tapOn({ text: USE_CODE })
  }
  await device.assertVisible({ text: USE_PASSWORD, timeout: 30000 })
  await device.tapOn({ text: USE_PASSWORD })
  await device.assertVisible({ text: USE_CODE, timeout: 10000 })
}

/**
 * Types the address and password (`typeInto` erases what a field holds
 * first) and sends the form. iOS submits from the password field's Go key.
 * Android leaves the keyboard over the button, so it is dismissed and the
 * button is tapped. Hiding the keyboard on iOS sends Return, which submits
 * that same field.
 */
async function sendCredentials(
  device: any,
  account: Pick<FixtureAccount, 'email' | 'password'>,
  mark: string
): Promise<void> {
  await typeInto(device, 'E-mail address', account.email)
  await typeInto(device, 'Password', account.password)
  if (await visible(device, mark, 2000)) return
  if (typeof device.hideKeyboard === 'function') {
    await device.hideKeyboard()
    if (await visible(device, mark, 2000)) return
  }
  // Plain text: a browser looks among its buttons first, where a regex
  // would find the header's own "Sign in" title before the form's button.
  await device.tapOn({ text: 'Sign in' })
}

export interface SignInOptions {
  /** The backoff while the form answers busy; `busyRetry.ts`'s by default. */
  busy?: BusyRetryOptions
}

/**
 * Signs `account` in through the real password form. Each try starts from
 * an empty password view. A key the phone keyboard dropped costs a try, and
 * the third one's failure is the device's own; a busy answer from the API
 * costs none, and is tried again with `busyRetry.ts`'s backoff until its
 * budget is spent.
 */
export async function signInOnAnySurface(
  device: any,
  account: Pick<FixtureAccount, 'email' | 'password'> & {
    displayName?: string
  },
  options: SignInOptions = {}
): Promise<void> {
  const mark = signedInMark(account)
  let sent = false
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const last = attempt === TRIES
    const signedIn = await retryWhileBusy(
      'Signing in through the password form',
      async () => {
        // A try that got in after its wait has nothing left to do.
        if (sent && (await visible(device, mark, 1000))) return true
        await openPasswordForm(device)
        sent = true
        await sendCredentials(device, account, mark)
        if (await visible(device, mark, last ? LAST_TRY_MS : TRY_MS)) {
          return true
        }
        if (await visible(device, BUSY, 1000)) throw new FormBusy()
        return false
      },
      options.busy
    )
    if (signedIn) return
    if (last) {
      // The device's own failure, naming the mark it could not find.
      await device.assertVisible({ text: mark, timeout: 1000 })
      return
    }
  }
}
