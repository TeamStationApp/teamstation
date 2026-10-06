import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import puppeteer, { type Page } from 'puppeteer'

/**
 * What every person in a browser run can read, recorded and compared: the
 * check that history made by one build still opens, unchanged, on another.
 *
 *   TS_CHAT_ARTIFACTS=<run dir> TS_CHAT_WEB_URL=<web app> \
 *     [TS_CHAT_API_URL=<API>] \
 *     node -r sucrase/register src/app/chat/chatHistory.e2e.ts record|compare
 *
 * The API defaults to the web app's own `/api/v1`, as on a deployed copy;
 * name it when it runs apart, as `chat.e2e.ts` does.
 *
 * It opens each browser profile the run left in `<run dir>/profiles` (each
 * signed in as one person, with that device's chat keys), and for every chat
 * that person is in, reads the conversation as the screen shows it: each
 * message's words, each attachment's name, "History is locked" and the like.
 * Lines that change only because somebody read something (read receipts,
 * unread counts, typing) are left out. It also reads the safety number with
 * every member of a direct message and with one member of each other chat.
 * Both modes read every profile until two passes agree (`settledHistory`).
 * `record` writes the result to `<run dir>/history.json`; `compare` reads it
 * all again and fails on any difference.
 */
const ARTIFACTS = process.env.TS_CHAT_ARTIFACTS ?? ''
const WEB = (process.env.TS_CHAT_WEB_URL ?? 'http://127.0.0.1:8080').replace(
  /\/+$/,
  ''
)
const API = (process.env.TS_CHAT_API_URL ?? `${WEB}/api/v1`).replace(/\/+$/, '')

type History = Record<string, Record<string, string[]>>

// A delivery tick (✓ or ✓✓) may lead any of these.
const VOLATILE = [
  /^✓*\s*Seen by/,
  /^✓*\s*Read by/,
  /^\d+ unread/,
  /typing/i,
  /^✓*\s*Sent$/,
  /^✓*\s*Delivered$/
]

async function settledText(page: Page): Promise<string[]> {
  let last = ''
  let stableSince = Date.now()
  const end = Date.now() + 20000
  while (Date.now() < end) {
    const now = await page.evaluate(() => document.body.innerText)
    if (now !== last) {
      last = now
      stableSince = Date.now()
    } else if (Date.now() - stableSince > 1500) {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  // No ?? or ?. in a page function: sucrase turns them into helpers the page
  // does not have.
  const labels = await page.$$eval('[aria-label^="Open "]', nodes =>
    nodes
      .map(node => node.getAttribute('aria-label'))
      .filter((label): label is string => label !== null)
  )
  return [
    ...last
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !VOLATILE.some(rule => rule.test(line))),
    ...labels
  ]
}

async function apiGet(page: Page, path: string): Promise<unknown> {
  return await page.evaluate(async (url: string) => {
    const response = await fetch(url, { credentials: 'include' })
    return response.ok ? await response.json() : undefined
  }, `${API}${path}`)
}

async function safetyNumber(
  page: Page,
  conversationId: string,
  name: string
): Promise<string> {
  await page.goto(`${WEB}/chat/${conversationId}/members`, {
    waitUntil: 'networkidle2'
  })
  const button = await page.$(`[aria-label="Safety number with ${name}"]`)
  if (button == null) return `${name}: no button`
  await button.click()
  // The members row bears the same label as the digits: wait for it to go.
  await page.waitForFunction(row => !row.isConnected, {}, button)
  // The screen settles on the digits, or on why there are none: somebody
  // who has not set up chat, or a number that cannot be loaded.
  const settled = await page.waitForFunction(
    (label: string, who: string) => {
      const grid = document.querySelector(`[aria-label="${label}"]`)
      if (grid !== null && grid.children.length > 0) {
        return [...grid.children].map(cell => cell.textContent).join(' ')
      }
      const text = document.body.innerText
      for (const why of [
        `${who} has not set up chat yet.`,
        'Chat could not be opened.'
      ]) {
        if (text.includes(why)) return why
      }
      return false
    },
    { timeout: 30000 },
    `Safety number with ${name}`,
    name
  )
  const read = (await settled.jsonValue()) as string
  return `${name}: ${read.replace(/\s+/g, ' ').trim()}`
}

async function readProfile(profile: string): Promise<Record<string, string[]>> {
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: join(ARTIFACTS, 'profiles', profile),
    executablePath: process.env.TS_CHROME_PATH
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await page.goto(`${WEB}/chat`, { waitUntil: 'networkidle2' })
    const chats = (await apiGet(page, '/chat/conversations')) as
      Array<{ id: string; title: string; kind: string }> | undefined
    if (chats == null) return { '': ['signed out'] }
    const read: Record<string, string[]> = {}
    for (const chat of [...chats].sort((a, b) => a.id.localeCompare(b.id))) {
      const started = Date.now()
      await page.goto(`${WEB}/chat/${chat.id}`, { waitUntil: 'networkidle2' })
      const lines = await settledText(page)
      const members = ((await apiGet(
        page,
        `/chat/conversations/${chat.id}/members`
      )) ?? []) as Array<{ shortName: string; userId: number }>
      const me = (await apiGet(page, '/auth/me')) as { id?: number } | undefined
      const others = members
        .filter(member => String(member.userId) !== String(me?.id))
        .map(member => member.shortName)
        .sort()
      for (const name of chat.kind === 'dm' ? others : others.slice(0, 1)) {
        lines.push(await safetyNumber(page, chat.id, name))
      }
      read[`${chat.kind} ${chat.title}`] = lines
      console.log(
        `  ${profile} / ${chat.kind} ${chat.title}: ${Date.now() - started} ms`
      )
    }
    return read
  } finally {
    await browser.close()
  }
}

async function readAll(): Promise<History> {
  const profiles = readdirSync(join(ARTIFACTS, 'profiles')).sort()
  const history: History = {}
  for (const profile of profiles) {
    history[profile] = await readProfile(profile)
    console.log(
      `${profile}: ${Object.keys(history[profile]).length} chats read`
    )
  }
  return history
}

/**
 * Every profile read until two passes in a row agree. Reading opens the app
 * as each person, and an open app grants the history to members' devices
 * that lack it, so a first pass can find "History is locked" that the
 * second does not.
 */
async function settledHistory(): Promise<History> {
  let last = await readAll()
  for (let pass = 2; pass <= 4; pass++) {
    const history = await readAll()
    const changed = differences(last, history)
    if (changed.length === 0) return history
    console.log(`Pass ${pass} read differently; reading again:`)
    for (const line of changed.slice(0, 10)) console.log(`  ${line}`)
    last = history
  }
  throw new Error('The history never settled in four passes')
}

/** Each chat two readings disagree on, with its first differing line. */
function differences(was: History, now: History): string[] {
  const found: string[] = []
  for (const profile of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const chats = new Set([
      ...Object.keys(was[profile] ?? {}),
      ...Object.keys(now[profile] ?? {})
    ])
    for (const chat of chats) {
      const before = was[profile]?.[chat] ?? []
      const after = now[profile]?.[chat] ?? []
      let i = 0
      while (
        i < Math.max(before.length, after.length) &&
        before[i] === after[i]
      ) {
        i++
      }
      if (i === Math.max(before.length, after.length)) continue
      found.push(
        `${profile} / ${chat}: "${before[i] ?? ''}" then "${after[i] ?? ''}"`
      )
    }
  }
  return found
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (ARTIFACTS === '' || (mode !== 'record' && mode !== 'compare')) {
    throw new Error(
      'usage: TS_CHAT_ARTIFACTS=<run> chatHistory.e2e.ts record|compare'
    )
  }
  const file = join(ARTIFACTS, 'history.json')
  const history = await settledHistory()
  if (mode === 'record') {
    writeFileSync(file, JSON.stringify(history, null, 2))
    console.log(`Recorded ${file}`)
    return
  }
  const recorded = JSON.parse(readFileSync(file, 'utf8')) as History
  const changed = differences(recorded, history)
  if (changed.length > 0) {
    console.log(`FAIL ${changed.length} chats read differently:`)
    for (const line of changed) console.log(`  ${line}`)
    process.exitCode = 1
    return
  }
  const chats = Object.values(recorded).reduce(
    (sum, read) => sum + Object.keys(read).length,
    0
  )
  console.log(
    `PASS every chat reads the same: ${Object.keys(recorded).length} profiles, ${chats} chats`
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
