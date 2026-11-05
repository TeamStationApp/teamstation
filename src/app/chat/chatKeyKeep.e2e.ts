import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'
import { Pool } from 'pg'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { readSeedTable, type SeedTablePerson } from '../../test/chatSeedTable'

/**
 * Two accounts keep their chat device across sign-out.
 *
 *   scripts/chat-e2e-reset.sh <artifacts>
 *   npm start
 *   TS_API_BASE_URL=http://127.0.0.1:9100/api/v1 npm run start.web
 *   TS_CHAT_ARTIFACTS=<artifacts> \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 180000 src/app/chat/chatKeyKeep.e2e.ts
 *
 * The conversation list after person 1 signs back in is
 * `<artifacts>/chat-relogin-after.png`, at the same 1280×900 frame as the
 * gate shot taken before this change.
 */
const ARTIFACTS = process.env.TS_CHAT_ARTIFACTS ?? ''
const WEB = (process.env.TS_CHAT_WEB_URL ?? 'http://127.0.0.1:8080').replace(
  /\/+$/,
  ''
)
const API = (
  process.env.TS_CHAT_API_URL ?? 'http://127.0.0.1:9100/api/v1'
).replace(/\/+$/, '')

const CHAT_LIST = '[data-testid="chat-conversation-list"]'

function databaseUrl(): string {
  const config = JSON.parse(readFileSync('serverConfig.json', 'utf8')) as {
    databaseUrl: string
  }
  if (
    !/^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl)
  ) {
    throw new Error('serverConfig.json does not name a local database')
  }
  return config.databaseUrl
}

async function until<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 60000
): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value != null && value !== false) return value
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for ${what}`)
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

async function bodyText(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.innerText)
}

async function signIn(page: Page, person: SeedTablePerson): Promise<void> {
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle2' })
  if ((await page.$('input[aria-label="E-mail address"]')) == null) {
    throw new Error('Already signed in')
  }
  const field = async (label: string, text: string): Promise<void> => {
    const input = await page.$(`input[aria-label="${label}"]`)
    if (input == null) throw new Error(`No ${label} field`)
    await input.click({ count: 3 })
    await input.type(text)
  }
  const press = async (words: string): Promise<void> => {
    const node = await until(words, async () => {
      for (const handle of await page.$$('[role="button"]')) {
        const said = await handle.evaluate(found => found.textContent)
        if (said?.trim() === words) return handle
      }
      return undefined
    })
    await node.click()
  }
  await field('E-mail address', person.email)
  await press('Use a password instead')
  await field('Password', person.password)
  await press('Sign in')
  await until('the sign-in to finish', async () =>
    (await page.$('input[aria-label="E-mail address"]')) == null
      ? true
      : undefined
  )
}

async function signOut(page: Page): Promise<void> {
  await page.goto(`${WEB}/account`, { waitUntil: 'networkidle2' })
  const node = await until('Sign out', async () => {
    for (const handle of await page.$$('[role="button"]')) {
      const said = await handle.evaluate(found => found.textContent)
      if (said?.trim() === 'Sign out') return handle
    }
    return undefined
  })
  await node.click()
  await until('the sign-in screen', async () =>
    (await page.$('input[aria-label="E-mail address"]')) != null
      ? true
      : undefined
  )
}

async function openChat(page: Page): Promise<void> {
  await page.goto(`${WEB}/chat`, { waitUntil: 'networkidle2' })
  await until(
    'the chat list',
    async () => {
      const text = await bodyText(page)
      const list = await page.$(CHAT_LIST)
      if (
        text.includes('Link this device') ||
        text.includes('Reset chat on this device')
      ) {
        throw new Error(`Chat asked to link or reset: ${text.slice(0, 500)}`)
      }
      return list != null && !text.includes('Opening chat') ? true : undefined
    },
    90000
  )
}

async function apiGet(page: Page, path: string): Promise<any> {
  const result = await page.evaluate(async (url: string) => {
    const response = await fetch(url, { credentials: 'include' })
    return { status: response.status, body: await response.json() }
  }, `${API}${path}`)
  if (result.status !== 200) {
    throw new Error(`${path} answered ${result.status}`)
  }
  return result.body
}

async function keyNames(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const names = (await indexedDB.databases()).map(found => found.name)
    if (!names.includes('ts-chat')) return []
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ts-chat')
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('indexedDB open failed'))
      }
    })
    try {
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = db
          .transaction('keys', 'readonly')
          .objectStore('keys')
          .getAllKeys()
        request.onsuccess = () => {
          resolve(request.result)
        }
        request.onerror = () => {
          reject(request.error ?? new Error('indexedDB keys failed'))
        }
      })
      return keys.map(key => String(key))
    } finally {
      db.close()
    }
  })
}

describe('chat keys stay across two accounts', function () {
  this.timeout(180000)
  let browser: Browser | undefined
  let profile = ''

  after(async () => {
    await browser?.close()
    if (profile !== '') rmSync(profile, { recursive: true, force: true })
  })

  it('resumes person 1 on the same device after person 2 has signed in', async () => {
    if (ARTIFACTS === '') throw new Error('Set TS_CHAT_ARTIFACTS')
    const people = readSeedTable(readFileSync(join(ARTIFACTS, 'seed.txt'), 'utf8'))
    const pool = new Pool({ connectionString: databaseUrl() })
    let free: Set<string>
    try {
      const found = await pool.query<{ id: string }>(
        `select id from users u
         where not exists (
           select 1 from chat_identities i where i.user_id = u.id
         )`
      )
      free = new Set(found.rows.map(row => row.id))
    } finally {
      await pool.end()
    }
    const available = Object.entries(people).filter(([, person]) =>
      free.has(person.userId)
    )
    const first = available.find(([key]) => key === 'B') ?? available[0]
    const second = available.find(([key]) => key !== first?.[0])
    if (first == null || second == null) {
      throw new Error('Need two seeded people with no chat identity')
    }
    const [firstKey, person1] = first
    const [secondKey, person2] = second
    console.log(`person 1 ${firstKey} ${person1.userId}`)
    console.log(`person 2 ${secondKey} ${person2.userId}`)

    profile = mkdtempSync(join(tmpdir(), 'ts-chat-key-keep-'))
    browser = await puppeteer.launch({
      headless: true,
      userDataDir: profile
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })

    await signIn(page, person1)
    await openChat(page)
    const mine = (await apiGet(page, '/chat/me/keys')) as { deviceId: string }
    console.log(`person 1 device ${mine.deviceId}`)
    await signOut(page)
    const afterFirst = await keyNames(page)
    console.log(`keys after person 1: ${afterFirst.join(' ')}`)
    expect(afterFirst).includes(`record:${person1.userId}`)

    await signIn(page, person2)
    await openChat(page)
    const theirs = (await apiGet(page, '/chat/me/keys')) as { deviceId: string }
    console.log(`person 2 device ${theirs.deviceId}`)
    await signOut(page)
    const afterBoth = await keyNames(page)
    console.log(`keys after both: ${afterBoth.join(' ')}`)
    expect(afterBoth).includes(`record:${person1.userId}`)
    expect(afterBoth).includes(`record:${person2.userId}`)

    await signIn(page, person1)
    await openChat(page)
    const again = (await apiGet(page, '/chat/me/keys')) as { deviceId: string }
    const devices = (await apiGet(page, '/chat/devices')) as Array<{
      id: string
      revokedAt: string | null
    }>
    const device = devices.find(found => found.id === mine.deviceId)
    console.log(
      `person 1 resumed ${again.deviceId} revokedAt ${String(device?.revokedAt)}`
    )
    expect(again.deviceId).equals(mine.deviceId)
    expect(device?.revokedAt ?? null).equals(null)
    const text = await bodyText(page)
    expect(text).not.includes('Link this device')
    expect(text).not.includes('Reset chat on this device')
    await page.screenshot({
      path: join(ARTIFACTS, 'chat-relogin-after.png')
    })
  })
})
