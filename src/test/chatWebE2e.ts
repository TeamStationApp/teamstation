import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { readSeedTable, type SeedTablePerson } from './chatSeedTable'
import { dismissNotificationAskOn } from './notificationAsk'

/**
 * What `messageButtons.e2e.ts` reads its run through: the run's environment,
 * its seed table, signing a browser in and out by password, reading the page
 * with its session, and screenshots into the run's artifacts.
 * `declaredAge.e2e.ts`, rewritten on develop for the age modal, keeps its own.
 */

export function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}

export interface Device {
  assertVisible: (options: object) => Promise<unknown>
  assertNotVisible: (options: object) => Promise<unknown>
  tapOn: (options: object) => Promise<unknown>
  inputText: (options: object) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  openBrowser: (options: object) => Promise<unknown>
  evalBrowserScript: (options: { script: string }) => Promise<{ data: string }>
  launchApp: (options: object) => Promise<unknown>
  stopApp: (options: object) => Promise<unknown>
  screenshot: () => Promise<Buffer>
}

/** The run's own Maestro D daemon and the device already attached to it. */
export async function attach(): Promise<Device> {
  const { MaestroD } = require(
    resolve(required('MAESTRO_D_CLIENT_ROOT'), 'dist/cjs/index.js')
  )
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  const status = await daemon.status()
  assert(
    status.devices.some(
      (device: { id: string }) => device.id === required('MAESTRO_DEVICE')
    ) === true,
    'Reuse the attached device; never open another'
  )
  return await daemon.attach({ device: required('MAESTRO_DEVICE') })
}

export const seedText = (): string =>
  readFileSync(required('TS_CHAT_FIXTURE'), 'utf8')

export function person(key: string): SeedTablePerson {
  const found = readSeedTable(seedText())[key]
  assert(found != null, `${key} is in the seed table`)
  return found
}

export function step(text: string): void {
  console.log(`$ ${text}`)
}

export async function shot(m: Device, name: string): Promise<void> {
  // A sheet slides up, and a page slides across: let both land first.
  await new Promise(resolve => setTimeout(resolve, 1500))
  const path = resolve(required('TS_CHAT_ARTIFACTS'), name)
  writeFileSync(path, await m.screenshot())
  step(`screenshot ${path}`)
}

export const web = (): string => required('TS_CHAT_WEB').replace(/\/$/, '')
export const api = (): string => required('TS_CHAT_API').replace(/\/$/, '')

export async function read<T>(m: Device, expression: string): Promise<T> {
  return JSON.parse(
    (
      await m.evalBrowserScript({
        script: `return JSON.stringify(await (${expression}))`
      })
    ).data
  ) as T
}

/** Where the page is: its path and query. */
export async function address(m: Device): Promise<string> {
  return await read<string>(m, 'location.pathname + location.search')
}

/** Signs the browser out as the app does, then in as `key`, by password. */
export async function webSignIn(m: Device, key: string): Promise<void> {
  const who = person(key)
  step(`sign out, then sign in as ${key} (${who.email})`)
  await m.openBrowser({ url: web() + '/' })
  // The session is an HttpOnly cookie: only the API's sign-out clears it.
  await read(
    m,
    `fetch(${JSON.stringify(api() + '/auth/logout')}, { method: 'POST', credentials: 'include' }).then(r => r.status).catch(() => 0)`
  )
  await read(
    m,
    '(async () => { localStorage.clear(); sessionStorage.clear(); for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name); return true })()'
  )
  await m.openBrowser({ url: web() + '/' })
  await m.tapOn({ text: 'Use a password instead', timeout: 30000 })
  await m.tapOn({ text: 'E-mail address' })
  await m.inputText({ text: who.email })
  await m.tapOn({ text: 'Password' })
  await m.inputText({ text: who.password })
  await m.tapOn({ text: 'Sign in' })
  await m.assertVisible({ text: 'Account, .*', timeout: 30000 })
}

/**
 * Chat open past its gates asks about notifications, once per person per
 * device: answered Not Now, as nothing here is about it.
 */
export async function notNow(m: Device): Promise<void> {
  if (await dismissNotificationAskOn(m)) step('notification ask: Not Now')
}
