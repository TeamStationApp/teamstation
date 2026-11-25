import { asSession, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import {
  type AccountSwitch,
  asSwitchPrompt,
  type SwitchPrompt
} from '../../common/webPasswordLink'
import { passwordKdf } from '../platform/passwordKdf'

function readAuth(
  params: URLSearchParams
): { email: string; password: string } | undefined {
  const values = params.getAll('auth')
  const hex = values[0]
  if (
    values.length !== 1 ||
    hex.length > 2 * (254 + 1 + 1024) ||
    !/^(?:[0-7][0-9a-f])+$/i.test(hex)
  )
    return
  const decoded = hex.replace(/../g, byte =>
    String.fromCharCode(parseInt(byte, 16))
  )
  const newline = decoded.indexOf('\n')
  if (newline < 0) return
  const email = decoded.slice(0, newline).trim()
  const password = decoded.slice(newline + 1)
  if (
    email !== '' &&
    email.length <= 254 &&
    password !== '' &&
    password.length <= 1024
  ) {
    return { email, password }
  }
}

// Kept in the development-only module so the release client has no link
// submission method. Browsers carry the resulting session in the HTTP cookie.
export class PasswordLinkClient extends TeamStationClient {
  async submit(
    email: string,
    password: string,
    confirmation: AccountSwitch | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const clientHash = await this.passwordProof(email, password)
    signal.throwIfAborted()
    await this.request(
      'POST',
      '/auth/password/link',
      asSession,
      { email, clientHash, confirmation },
      { signal }
    )
  }
}

type Submit = PasswordLinkClient['submit']

function switchPrompt(error: unknown): SwitchPrompt | undefined {
  if (!(error instanceof HttpError) || error.code !== 'conflict') return
  try {
    return asSwitchPrompt(error.details)
  } catch {
    return
  }
}

export async function openPasswordLogin(
  credentials: URLSearchParams,
  signIn: Submit = (email, password, confirmation, signal) =>
    new PasswordLinkClient({ baseUrl: '/api/v1', passwordKdf }).submit(
      email,
      password,
      confirmation,
      signal
    ),
  openHome = (): void => {
    window.location.replace('/')
  },
  signal = new AbortController().signal
): Promise<void> {
  const root = document.getElementById('root')!
  const panel = document.createElement('main')
  // A font declared by the original document can reuse its pre-cleanup URL
  // as a referrer. This short-lived sign-in screen only needs local fonts.
  panel.style.cssText =
    'box-sizing:border-box;align-self:center;margin:auto;padding:24px;max-width:34rem;width:100%;font-family:system-ui,sans-serif'
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  root.replaceChildren(panel)
  const auth = readAuth(credentials)

  function fail(message: string): void {
    const retry = document.createElement('a')
    retry.href = '/sign-in'
    retry.textContent = 'Open TeamStation sign-in'
    status.textContent = message
    panel.replaceChildren(status, retry)
  }
  if (!auth) {
    fail('This sign-in link has an invalid auth value.')
    return
  }

  // A back-forward cache restore must never revive a pending decision.
  signal.addEventListener(
    'abort',
    () => fail('This sign-in link has closed.'),
    { once: true }
  )
  async function attempt(confirmation?: AccountSwitch): Promise<void> {
    if (signal.aborted) return
    status.textContent = 'Signing in…'
    panel.replaceChildren(status)
    try {
      await signIn(auth!.email, auth!.password, confirmation, signal)
      if (!signal.aborted) openHome()
    } catch (error) {
      if (signal.aborted) return
      const prompt = switchPrompt(error)
      if (prompt == null) {
        fail('Sign-in failed. Check your email and password, then try again.')
        return
      }
      const heading = document.createElement('h1')
      heading.textContent = 'Switch account?'
      const detail = document.createElement('p')
      detail.textContent = `You are signed in as ${prompt.currentLabel}. This link signs you in as ${prompt.targetLabel}.`
      const keep = document.createElement('button')
      keep.textContent = 'Keep current account'
      const change = document.createElement('button')
      change.textContent = 'Switch account'
      let decided = false
      function choose(switchAccount: boolean): void {
        if (decided || signal.aborted) return
        decided = true
        keep.disabled = change.disabled = true
        if (switchAccount) void attempt(prompt!.confirmation)
        else openHome()
      }
      keep.onclick = () => choose(false)
      change.onclick = () => choose(true)
      panel.replaceChildren(heading, detail, keep, change)
      keep.focus()
    }
  }
  await attempt()
}
