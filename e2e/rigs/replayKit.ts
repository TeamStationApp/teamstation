import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
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
  swipe: (params: Record<string, unknown>) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  evalBrowserScript: (params: Record<string, unknown>) => Promise<unknown>
  setNetworkConditions: (params: Record<string, unknown>) => Promise<unknown>
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
  windowSize = '402x874',
  /** Tells apart two browsers open at once. */
  name = 'web'
): Promise<Device> {
  return await daemon.attach({
    device: `${required('MAESTRO_D')}-${name}-${windowSize}`,
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
  const pattern = new RegExp(`sign-in code for ${email}: (\\d{6})`, 'g')
  const codes = (): string[] =>
    [...readFileSync(log, 'utf8').slice(before).matchAll(pattern)].map(
      match => match[1]
    )
  await until('the sign-in code in the log', () => codes().at(0))
  // An app may ask twice; only the newest code is good.
  await new Promise(resolve => setTimeout(resolve, 2000))
  return codes().at(-1)!
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

/**
 * Sessions kept between runs: the server limits how often one address may
 * ask for a code, and a scenario run several times would hit it.
 */
const SESSIONS = join(tmpdir(), 'replay-e2e-sessions.json')

function savedSessions(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSIONS, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

/** A session token for a seeded account, signed in with the logged code. */
export async function sessionFor(email: string): Promise<string> {
  const known = tokens.get(email)
  if (known != null) return known
  const api = required('REPLAY_API')
  const saved = savedSessions()[`${api} ${email}`]
  if (saved != null) {
    const me = await fetch(`${api}/auth/me`, {
      headers: { authorization: `Bearer ${saved}` }
    })
    if (me.ok) {
      tokens.set(email, saved)
      return saved
    }
  }
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
  writeFileSync(
    SESSIONS,
    JSON.stringify({ ...savedSessions(), [`${api} ${email}`]: token }),
    { mode: 0o600 }
  )
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

/** The bench camera, with its sound, for `seconds`, into `path`. */
export function recordWebcam(path: string, seconds: number): ChildProcess {
  return spawn(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-tls_verify',
      '0',
      '-timeout',
      '15000000',
      '-i',
      required('REPLAY_WEBCAM'),
      '-t',
      String(seconds),
      '-c',
      'copy',
      '-y',
      path
    ],
    { stdio: 'inherit' }
  )
}

export const visible = async (
  m: Device,
  text: string,
  timeout = 3000
): Promise<boolean> =>
  await m.assertVisible({ text, timeout }).then(
    () => true,
    () => false
  )

/**
 * Signs a phone in as a seeded account, when it is signed out, with a code
 * from the server's log, whichever way the screen asks for one: a button
 * that sends it, or a code field.
 */
export async function signInPhone(m: Device, email: string): Promise<void> {
  if (!(await visible(m, 'Sign in to TeamStation', 8000))) return
  await m.tapOn({ text: 'E-mail address' })
  await m.eraseText({ characters: 60 })
  await m.inputText({ text: email })
  await m.hideKeyboard().catch(() => undefined)
  const code = await loggedCode(email, async () => {
    for (const button of ['Send me a sign-in code', 'E-mail me a code instead'])
      if (await visible(m, button)) {
        await m.tapOn({ text: button })
        return
      }
    await askForCode(email)
  })
  await m.tapOn({ text: '123456' })
  await m.inputText({ text: code })
  await m.hideKeyboard().catch(() => undefined)
  // A full code signs in by itself on some screens.
  if (await visible(m, '^Sign in$')) await m.tapOn({ text: '^Sign in$' })
  // Android keeps the sign-in screen mounted under the next one, so what the
  // caller opens next proves the session.
}
