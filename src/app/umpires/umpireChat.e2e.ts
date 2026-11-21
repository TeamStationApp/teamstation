import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Client } from 'pg'

import { CHAT_KINDS_HEADER, NEWER_CHAT_KINDS } from '../../common/chatKinds'
import {
  address,
  api,
  attach,
  type Device,
  notNow,
  person,
  read,
  required,
  seedText,
  shot,
  step,
  web,
  webSignIn
} from '../../test/chatWebE2e'

/**
 * A league's umpire chat in the web app against the chat seed (#349): the
 * Umpire chat pill beside Leaderboard, the chat in the league's Chats and
 * in the chat list, a league administrator who is not an umpire and then
 * grants themselves the role, and the chat's members as the role and the
 * league's settings change.
 *
 *   scripts/chat-e2e-reset.sh <run>/seed
 *
 * With the branch's API and web app served, and either the run's own Maestro
 * D daemon with a Chromium attached (`MAESTRO_D`, `MAESTRO_DEVICE`,
 * `MAESTRO_D_CLIENT_ROOT`), or neither, when the file opens its own
 * (`TS_MAESTRO_D_CLIENT`, `MAESTRO_D_BIN`):
 *
 *   TS_CHAT_WEB=<web app> TS_CHAT_API=<API, as the browser reaches it> \
 *   TS_CHAT_FIXTURE=<run>/seed/seed.txt TS_CHAT_ARTIFACTS=<artifacts> \
 *   TS_CHAT_DATABASE_URL=<the seed's database, from serverConfig.json> \
 *     node -r sucrase/register src/app/umpires/umpireChat.e2e.ts <mode>…
 *
 * Modes, run in this order in one run on a fresh seed: `schedule`, `reply`,
 * `admin`, `membership`. Each person signs in once, so that the browser is
 * the first device of theirs and makes their chat keys. B posts; A and L,
 * whose keys are made after it, see the chat listed and open it, its
 * history waiting for a member who holds the keys to share them, which is
 * chat's own business.
 *
 * Setup, before the first mode, turns on QPLL's umpire management and gives
 * parents B and A the umpire role; the last mode puts everything back.
 */

/** The seed's ids beside its table. */
function seedIds(): { league: string } {
  const found = /^QPLL (\S+)/m.exec(seedText())?.[1]
  assert(found != null, 'the seed table names QPLL')
  return { league: found }
}

async function database<T>(run: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({
    connectionString: required('TS_CHAT_DATABASE_URL')
  })
  await db.connect()
  try {
    return await run(db)
  } finally {
    await db.end()
  }
}

/** Opens `path` and waits for `text`, answering the notification ask. */
async function open(m: Device, path: string, text: string): Promise<void> {
  step(`open ${path}`)
  await m.openBrowser({ url: web() + path })
  await m.assertVisible({ text, timeout: 30000 })
  await notNow(m)
}

/** The league's umpire chat, as the reader's own list holds it. */
async function umpireChatIn(
  m: Device
): Promise<{ id: string; title: string; memberCount: number } | null> {
  const { league } = seedIds()
  return await read(
    m,
    `fetch(${JSON.stringify(api() + '/chat/conversations')}, { credentials: 'include', headers: { ${JSON.stringify(CHAT_KINDS_HEADER)}: ${JSON.stringify(NEWER_CHAT_KINDS.join(','))} } }).then(r => r.json()).then(list => list.find(c => c.kind === 'leagueUmpires' && c.scope && c.scope.id === ${JSON.stringify(league)}) || null).then(c => c && { id: c.id, title: c.title, memberCount: c.memberCount })`
  )
}

/** Waits for the chat's own page, titled for the league. */
async function opened(m: Device): Promise<void> {
  for (let tries = 0; tries < 60; tries++) {
    if ((await address(m)).startsWith('/chat/')) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.match(await address(m), /^\/chat\//, 'the chat opened')
  await notNow(m)
  // The chat's header: the league's name over "League Umpires".
  await m.assertVisible({ text: 'League Umpires', timeout: 30000 })
}

/** Opens the chat's page, then sends `text` and waits to see it. */
async function post(m: Device, text: string): Promise<void> {
  await opened(m)
  await m.assertVisible({ id: 'chat-composer', timeout: 60000 })
  await m.tapOn({ id: 'chat-composer' })
  await m.inputText({ text })
  await m.tapOn({
    css: '[data-testid="chat-composer-band"] [aria-label="Send"]'
  })
  await m.assertVisible({ text, timeout: 30000 })
  step(`posted "${text}"`)
}

/** Where a page element is, for the layout checks. */
async function box(
  m: Device,
  selector: string
): Promise<{ left: number; right: number; middle: number }> {
  return await read(
    m,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, right: r.right, middle: (r.top + r.bottom) / 2 } })()`
  )
}

async function schedule(m: Device): Promise<void> {
  const { league } = seedIds()
  await webSignIn(m, 'B')
  await open(m, `/umpires/${league}`, 'Leaderboard')
  await m.assertVisible({ id: 'umpire-chat', timeout: 30000 })
  // Right after Leaderboard, with the same gap as from Schedule to it; or,
  // where the three do not fit, whole on a row of its own under Schedule.
  const tabs = '[aria-label="Umpire pages"] [role="tab"]'
  const first = await box(m, `${tabs}:nth-child(1)`)
  const second = await box(m, `${tabs}:nth-child(2)`)
  const pill = await box(m, '[data-testid="umpire-chat"]')
  if (Math.abs(pill.middle - second.middle) <= 4)
    assert.ok(
      Math.abs(pill.left - second.right - (second.left - first.right)) <= 4,
      `the pill is the strip's next pill (gaps ${second.left - first.right} and ${pill.left - second.right})`
    )
  else {
    assert.ok(pill.middle > second.middle, 'below the tabs')
    assert.ok(
      Math.abs(pill.left - first.left) <= 2,
      `under Schedule (${pill.left} and ${first.left})`
    )
    // Both tabs whole: the strip is never squeezed.
    const strip = await read<{ clipped: boolean }>(
      m,
      `(() => { const s = document.querySelector('[aria-label="Umpire pages"]'); return { clipped: s.scrollWidth > s.clientWidth + 1 } })()`
    )
    assert.equal(strip.clipped, false, 'neither tab is cut off')
  }
  await shot(m, 'umpire-schedule-after.png')
  await m.tapOn({ id: 'umpire-chat' })
  await post(m, 'Who has the 5 pm plate?')
  await shot(m, 'umpire-chat-message.png')
}

async function reply(m: Device): Promise<void> {
  const { league } = seedIds()
  await webSignIn(m, 'A')
  // The league's Chats list it by its label alone, as they do Org.
  await open(m, `/groups/league/${league}?tab=chats`, 'Umpires')
  await shot(m, 'league-chats.png')
  await open(m, '/chat', 'League Umpires')
  await shot(m, 'chat-list-after.png')
  await m.tapOn({ text: 'League Umpires' })
  // A's keys are new on this device: B's message waits for B to share
  // them, as in any group chat a member joins on a new device.
  await opened(m)
}

async function admin(m: Device): Promise<void> {
  const { league } = seedIds()
  const log: string[] = [
    `# After #349 — paul/improveUmpire3, chat seed, QPLL umpire management on; B and A hold the umpire role`
  ]
  const conversations = async (when: string): Promise<void> => {
    const chat = await umpireChatIn(m)
    log.push(
      `# league admin L, ${when}`,
      '$ GET /api/v1/chat/conversations   (as L; its leagueUmpires entries)',
      `200 ${JSON.stringify(chat == null ? [] : [chat])}`
    )
  }
  await webSignIn(m, 'L')
  await conversations('without the umpire role')
  await open(m, `/umpires/${league}`, 'Leaderboard')
  await m.assertNotVisible({ id: 'umpire-chat', timeout: 5000 })
  await shot(m, 'admin-no-chat.png')
  await open(m, '/chat', 'Messages')
  await m.assertNotVisible({ text: 'League Umpires', timeout: 5000 })
  await open(m, `/groups/league/${league}/umpires`, 'Manage Umpires')
  await m.tapOn({ text: 'Search affiliated people' })
  await m.inputText({ text: 'Lena' })
  // The search result, not the account entry that also names L.
  await m.tapOn({
    css: '[role="button"][aria-label="Lena League"]',
    timeout: 30000
  })
  await m.tapOn({ text: 'Save' })
  await m.assertVisible({ id: 'umpire-management-table', timeout: 30000 })
  for (let tries = 0; tries < 20 && (await umpireChatIn(m)) == null; tries++)
    await new Promise(resolve => setTimeout(resolve, 500))
  await conversations('after granting themselves the umpire role')
  await open(m, `/umpires/${league}`, 'Leaderboard')
  await m.assertVisible({ id: 'umpire-chat', timeout: 30000 })
  await shot(m, 'admin-self-granted.png')
  await m.tapOn({ id: 'umpire-chat' })
  await opened(m)
  writeFileSync(
    resolve(required('TS_CHAT_ARTIFACTS'), 'umpire-chat.log'),
    log.join('\n') + '\n'
  )
}

async function membership(m: Device): Promise<void> {
  const { league } = seedIds()
  const chat = await umpireChatIn(m)
  assert(chat != null, 'L is in the umpire chat')
  const log: string[] = [
    `# After #349 — the QPLL umpire chat's members as L changes the role and the settings`
  ]
  const members = async (): Promise<string[]> =>
    await database(async db =>
      (
        await db.query<{ name: string }>(
          `select users.display_name as name from chat_members
             join users on users.id = chat_members.user_id
            where conversation_id = $1 and left_at is null
            order by name`,
          [chat.id]
        )
      ).rows.map(row => row.name)
    )
  const show = async (before: string[]): Promise<void> => {
    let now = await members()
    for (
      let tries = 0;
      tries < 20 && JSON.stringify(now) === JSON.stringify(before);
      tries++
    ) {
      await new Promise(resolve => setTimeout(resolve, 500))
      now = await members()
    }
    log.push(
      `$ select display_name from chat_members … where conversation_id = <the umpire chat> and left_at is null`,
      JSON.stringify(now)
    )
  }
  const call = async (
    method: string,
    path: string,
    body?: unknown
  ): Promise<void> => {
    const answer = await read<{ status: number; text: string }>(
      m,
      `fetch(${JSON.stringify(api() + path)}, { method: ${JSON.stringify(method)}, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: ${body == null ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, text: await r.text() }))`
    )
    log.push(
      `$ ${method} /api/v1${path}${body == null ? '' : ' ' + JSON.stringify(body)}   (as L)`,
      `${answer.status} ${answer.text.slice(0, 120)}`
    )
    assert.ok(answer.status < 300, `${method} ${path}: ${answer.status}`)
  }
  const blair = person('B').userId
  const fan = person('F').userId
  let before = await members()
  log.push('# at the start', JSON.stringify(before))
  log.push('# revoke B')
  await call('DELETE', `/leagues/${league}/umpires/${blair}`)
  await show(before)
  before = await members()
  log.push(
    '# fan F, who only follows Hawks: a QPLL league membership (no route here), then the role'
  )
  await database(
    async db =>
      await db.query(
        `insert into league_members (id, league_id, user_id, role, source)
         values ('lmb_umpire_chat_e2e', $1, $2, 'member', 'manual')`,
        [league, fan]
      )
  )
  log.push(
    `$ insert into league_members (league_id, user_id) values (<QPLL>, <F>)`
  )
  await call('POST', `/leagues/${league}/umpires`, { userId: fan })
  await show(before)
  before = await members()
  log.push('# F leaves the league, keeping the role (lost acceptance)')
  await database(
    async db =>
      await db.query(
        `delete from league_members where id = 'lmb_umpire_chat_e2e'`
      )
  )
  log.push(
    `$ delete from league_members where league_id = <QPLL> and user_id = <F>`
  )
  await show(before)
  before = await members()
  log.push('# umpire management off, then on')
  await call('PUT', `/leagues/${league}/umpire-settings`, {
    management: false,
    credits: false
  })
  await show(before)
  before = await members()
  await call('PUT', `/leagues/${league}/umpire-settings`, {
    management: true,
    credits: false
  })
  await show(before)
  writeFileSync(
    resolve(required('TS_CHAT_ARTIFACTS'), 'umpire-membership.log'),
    log.join('\n') + '\n'
  )
}

const MODES: Record<string, (m: Device) => Promise<void>> = {
  schedule,
  reply,
  admin,
  membership
}

function viewport(): [number, number] {
  const given = process.env.TS_CHAT_VIEWPORT
  if (given == null) return [1440, 900]
  const [w, h] = given.split('x').map(Number)
  assert(w > 0 && h > 0, `TS_CHAT_VIEWPORT is <w>x<h>, not ${given}`)
  return [w, h]
}

async function device(): Promise<{ m: Device; close: () => Promise<void> }> {
  if (process.env.MAESTRO_DEVICE != null)
    return { m: await attach(), close: async () => {} }
  const { browserSession, maestro } =
    await import('../../test/refinementsMaestro.e2e')
  const daemon = await maestro(process.env.MAESTRO_D ?? 'improveUmpireChat')
  const session = await browserSession(
    daemon,
    'umpire-chat-web',
    viewport()[0],
    viewport()[1],
    required('TS_CHAT_ARTIFACTS')
  )
  return {
    m: session.m as unknown as Device,
    close: async () => {
      await session.browser.close().catch(() => undefined)
      await session.m.detach().catch(() => undefined)
      await daemon.shutdown()
    }
  }
}

async function main(): Promise<void> {
  const modes = process.argv.slice(2)
  assert(modes.length > 0, `Name a mode: ${Object.keys(MODES).join(', ')}`)
  for (const mode of modes) assert(mode in MODES, `Unknown mode ${mode}`)
  readFileSync(required('TS_CHAT_FIXTURE'), 'utf8')
  const { league } = seedIds()
  const umpires = ['B', 'A'].map(key => person(key).userId)
  const managed = await database(
    async db =>
      (
        await db.query<{ umpire_management: boolean }>(
          'select umpire_management from leagues where id = $1',
          [league]
        )
      ).rows[0].umpire_management
  )
  // Only what setup itself grants is taken away after.
  const granted: string[] = []
  const { m, close } = await device()
  try {
    await database(async db => {
      await db.query(
        'update leagues set umpire_management = true where id = $1',
        [league]
      )
      for (const userId of umpires) {
        const made = await db.query(
          `insert into league_umpires (league_id, user_id, granted_by)
           values ($1, $2, $3) on conflict do nothing`,
          [league, userId, person('L').userId]
        )
        if (made.rowCount === 1) granted.push(userId)
      }
    })
    step('QPLL manages umpires; B and A hold the role')
    for (const mode of modes) {
      step(`mode ${mode}`)
      await database(async db => await db.query('delete from rate_events'))
      await MODES[mode](m)
    }
  } finally {
    await close()
    await database(async db => {
      await db.query(
        `delete from league_members where id = 'lmb_umpire_chat_e2e'`
      )
      await db.query(
        'delete from league_umpires where league_id = $1 and user_id = any($2)',
        [league, [...granted, person('L').userId, person('F').userId]]
      )
      await db.query(
        'update leagues set umpire_management = $2 where id = $1',
        [league, managed]
      )
    })
    step('QPLL umpires as they were')
  }
  console.log(`umpireChat: ${modes.join(', ')} passed`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
