import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

/**
 * What the replay's end-to-end scenarios share: the maestro-d client, a
 * session for a seeded account, and where the artifacts go.
 *
 *   MAESTRO_D               the daemon's name
 *   MAESTRO_D_CLIENT_ROOT   the maestro-d npm package directory
 *   REPLAY_API              the API, e.g. http://127.0.0.1:9150/api/v1
 *   REPLAY_WEB_URL          the web app, e.g. http://127.0.0.1:8150
 *   REPLAY_SERVER_LOG       the API's log, where sign-in codes are written
 *   REPLAY_ARTIFACTS        where screenshots and results are written
 */

export interface Device {
  launchApp: (params: Record<string, unknown>) => Promise<unknown>
  stopApp: (params: Record<string, unknown>) => Promise<unknown>
  openBrowser: (params: Record<string, unknown>) => Promise<unknown>
  tapOn: (params: Record<string, unknown>) => Promise<unknown>
  inputText: (params: Record<string, unknown>) => Promise<unknown>
  eraseText: (params?: Record<string, unknown>) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  openLink: (params: Record<string, unknown>) => Promise<unknown>
  assertVisible: (params: Record<string, unknown>) => Promise<unknown>
  assertNotVisible: (params: Record<string, unknown>) => Promise<unknown>
  scrollUntilVisible: (params: Record<string, unknown>) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  evalBrowserScript: (params: Record<string, unknown>) => Promise<unknown>
  startRecording: (params: Record<string, unknown>) => Promise<unknown>
  stopRecording: (params?: Record<string, unknown>) => Promise<unknown>
  detach: () => Promise<void>
}
interface Daemon {
  attach: (params: Record<string, unknown>) => Promise<Device>
  shutdown: () => Promise<void>
}
interface Client {
  connect: (params: Record<string, unknown>) => Promise<Daemon>
}

export function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `Set ${key}`)
  return value
}

export async function connect(): Promise<Daemon> {
  const clientRoot = required('MAESTRO_D_CLIENT_ROOT')
  const { MaestroD } = createRequire(join(resolve(clientRoot), 'package.json'))(
    'maestro-d'
  ) as { MaestroD: Client }
  return await MaestroD.connect({ name: required('MAESTRO_D') })
}

/** A Chromium page at a phone's size, or another size when given. */
export async function attachWeb(
  daemon: Daemon,
  windowSize = '402x874'
): Promise<Device> {
  return await daemon.attach({
    device: `${required('MAESTRO_D')}-web-${windowSize}`,
    platform: 'web',
    appId: required('REPLAY_WEB_URL'),
    extra: { browser: 'chromium', windowSize },
    artifacts: 'on-failure'
  })
}

async function until<T>(
  what: string,
  read: () => T | undefined,
  ms = 20000
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value != null) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

const tokens = new Map<string, string>()

/**
 * The sign-in code the server logs for `email` after `ask` asks for one:
 * the API, or the app's own button.
 */
export async function loggedCode(
  email: string,
  ask: () => Promise<unknown>
): Promise<string> {
  const log = required('REPLAY_SERVER_LOG')
  const before = readFileSync(log, 'utf8').length
  await ask()
  const pattern = new RegExp(`sign-in code for ${email}: (\\d{6})`)
  return await until('the sign-in code in the log', () =>
    pattern.exec(readFileSync(log, 'utf8').slice(before))?.at(1)
  )
}

/** Asks the API to send `email` a sign-in code. */
export async function askForCode(email: string): Promise<void> {
  const asked = await fetch(`${required('REPLAY_API')}/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email })
  })
  assert.equal(asked.status, 202, 'email-code')
}

/** A session token for a seeded account, signed in with the logged code. */
export async function sessionFor(email: string): Promise<string> {
  const known = tokens.get(email)
  if (known != null) return known
  const code = await loggedCode(email, async () => {
    await askForCode(email)
  })
  const verified = await fetch(
    `${required('REPLAY_API')}/auth/email-code/verify`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code })
    }
  )
  assert.equal(verified.status, 200, 'verify')
  const token = ((await verified.json()) as { token: string }).token
  tokens.set(email, token)
  return token
}

/**
 * Signs the page in as `email`: the session cookie is set for the API's host,
 * which the web app's credentialed requests carry whatever the port.
 */
export async function signInWeb(m: Device, email: string): Promise<void> {
  const token = await sessionFor(email)
  await m.openBrowser({ url: required('REPLAY_WEB_URL') })
  await m.evalBrowserScript({
    script: `document.cookie = 'ts_session=${encodeURIComponent(token)}; path=/; SameSite=Lax'`
  })
}

export async function artifactsDir(): Promise<string> {
  const dir = resolve(required('REPLAY_ARTIFACTS'))
  await mkdir(dir, { recursive: true })
  return dir
}

export async function shot(m: Device, name: string): Promise<string> {
  const path = join(await artifactsDir(), `${name}.png`)
  await writeFile(path, await m.screenshot())
  return path
}
