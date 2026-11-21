import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Client } from 'pg'

import { makeId } from '../../common/ids'
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
 * The Message pill on a person's profile and a player's page, the picker of whom to message for a player who cannot sign in, and a
 * game umpire's league card, in the web app against the chat seed (#347).
 *
 *   scripts/chat-e2e-reset.sh <run>/seed
 *
 * With the branch's API and web app served, and either the run's own Maestro
 * D daemon with a Chromium attached (`MAESTRO_D`, `MAESTRO_DEVICE`,
 * `MAESTRO_D_CLIENT_ROOT`, as `declaredAge.e2e.ts`), or neither, when the
 * file opens its own (`TS_MAESTRO_D_CLIENT`, `MAESTRO_D_BIN`):
 *
 *   TS_CHAT_WEB=<web app> TS_CHAT_API=<API, as the browser reaches it> \
 *   TS_CHAT_FIXTURE=<run>/seed/seed.txt TS_CHAT_ARTIFACTS=<artifacts> \
 *   TS_CHAT_DATABASE_URL=<the seed's database, from serverConfig.json> \
 *     node -r sucrase/register src/app/chat/messageButtons.e2e.ts <mode>…
 *
 * Modes: `profile`, `player`, `phone` (at `TS_CHAT_VIEWPORT=390x844`),
 * `guardian`, `coach`, `game`, `api-log`. `guardian` and `api-log` link parent N as player R's guardian
 * for their length; `game` turns on QPLL's umpires and gives parent B the
 * plate on the Hawks' next game, and takes it all back after.
 */

/** The seed's ids beside its table: league, season, teams and games. */
function seedIds(): {
  league: string
  season: string
  hawks: string
  hawksNext: string
  quilvio: string
} {
  const text = seedText()
  const match = (pattern: RegExp): string => {
    const found = pattern.exec(text)?.[1]
    assert(found != null, `the seed table names ${String(pattern)}`)
    return found
  }
  return {
    league: match(/^QPLL (\S+)/m),
    season: match(/Spring 2027 (\S+)/),
    hawks: match(/Hawks (tem_\S+)/),
    hawksNext: match(/Owls v Hawks \(next week\) (\S+)/),
    quilvio: match(/^Q +.+? +(usr_\S+)/m)
  }
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

/** Parent N as player R's guardian for the length of `run`. */
async function withGuardian(run: () => Promise<void>): Promise<void> {
  const link = makeId('userLink')
  await database(
    async db =>
      await db.query(
        `insert into user_links (id, user_id, related_user_id, kind, created_at)
         values ($1, $2, $3, 'guardian', now())`,
        [link, person('N').userId, person('R').userId]
      )
  )
  step('link parent N as player R’s guardian')
  try {
    await run()
  } finally {
    await database(
      async db => await db.query('delete from user_links where id = $1', [link])
    )
    step('unlink parent N from player R')
  }
}

const tapTestId = async (m: Device, id: string): Promise<void> => {
  await m.tapOn({ id })
}

async function dms(m: Device): Promise<number> {
  return (
    await read<Array<{ kind: string }>>(
      m,
      `fetch(${JSON.stringify(api() + '/chat/conversations')}, { credentials: 'include' }).then(r => r.json()).then(b => b.conversations ?? b)`
    )
  ).filter(chat => chat.kind === 'dm').length
}

async function chatOpened(m: Device, who: string): Promise<void> {
  // The DM's own page: a browser signed in afresh links its chat keys there
  // before the composer shows, which is chat's own business, not this one's.
  for (let tries = 0; tries < 60; tries++) {
    if ((await address(m)).startsWith('/chat/')) {
      step(`the DM with ${who} opened at ${await address(m)}`)
      await notNow(m)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.fail(`the DM with ${who} did not open: still at ${await address(m)}`)
}

/** Opens `path` and waits for `text`, answering the notification ask. */
async function open(m: Device, path: string, text: string): Promise<void> {
  step(`open ${path}`)
  await m.openBrowser({ url: web() + path })
  await m.assertVisible({ text, timeout: 30000 })
  await notNow(m)
}

async function pill(m: Device, name: string): Promise<void> {
  await m.tapOn({ css: `[aria-label="Message ${name}"]` })
}

/**
 * Where the Message pill sits on a hero card: inside the card, below the row
 * holding the name, flush with the card's right inset, and above the roles.
 */
async function heroPlacement(
  m: Device,
  name: string
): Promise<{
  inCard: boolean
  below: boolean
  right: boolean
  above: boolean
}> {
  return await read(
    m,
    `(() => {
      const pill = document.querySelector('[data-testid="person-message"]')
      const heading = [...document.querySelectorAll('[role="heading"]')].find(n => n.textContent === ${JSON.stringify(name)})
      const row = heading?.parentElement?.parentElement
      const card = row?.parentElement
      const roles = [...document.querySelectorAll('div')].find(n => n.textContent === 'TEAM ROLES')
      if (pill == null || row == null || card == null) return { inCard: false, below: false, right: false, above: false }
      const p = pill.getBoundingClientRect()
      const r = row.getBoundingClientRect()
      return {
        inCard: card.contains(pill) && !row.contains(pill),
        below: p.top >= r.bottom,
        right: Math.abs(p.right - r.right) < 2,
        above: roles == null || (pill.compareDocumentPosition(roles) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      }
    })()`
  )
}

async function profile(m: Device): Promise<void> {
  const { hawks } = seedIds()
  await webSignIn(m, 'Hc')
  await open(m, `/teams/${hawks}/people/${person('A').userId}`, 'Alex Ashby')
  const placed = await heroPlacement(m, 'Alex Ashby')
  assert.deepEqual(
    placed,
    { inCard: true, below: true, right: true, above: true },
    'the pill is at the hero card’s bottom right'
  )
  await shot(m, 'profile-message-after.png')
  await tapTestId(m, 'person-message')
  await chatOpened(m, 'A')
}

async function player(m: Device): Promise<void> {
  const { hawks } = seedIds()
  await webSignIn(m, 'Hc')
  await open(m, `/teams/${hawks}`, 'Hawks')
  await m.tapOn({ css: '[role="tab"][aria-label="Team"]' })
  await m.assertVisible({ text: 'Pat Player', timeout: 30000 })
  await m.tapOn({ text: 'Pat Player' })
  await m.assertVisible({
    css: '[aria-label="Message Pat Player"]',
    timeout: 30000
  })
  await shot(m, 'player-message-after.png')
  await pill(m, 'Pat Player')
  await chatOpened(m, 'P')
}

/**
 * At a phone's width (`TS_CHAT_VIEWPORT=390x844`): the pill is the chat icon
 * alone, still named for the person, at the profile hero's bottom right.
 */
async function phone(m: Device): Promise<void> {
  const { hawks } = seedIds()
  await webSignIn(m, 'Hc')
  await open(m, `/teams/${hawks}/people/${person('A').userId}`, 'Alex Ashby')
  const words = await read<string>(
    m,
    `String(document.querySelector('[data-testid="person-message"]').textContent)`
  )
  assert.equal(words, 'chat', 'the icon alone, with no label')
  assert.deepEqual(
    await heroPlacement(m, 'Alex Ashby'),
    { inCard: true, below: true, right: true, above: true },
    'the icon is at the hero card’s bottom right'
  )
  await shot(m, 'profile-message-phone.png')
}

async function guardian(m: Device): Promise<void> {
  const { hawks } = seedIds()
  await withGuardian(async () => {
    await webSignIn(m, 'Hc')
    await open(
      m,
      `/teams/${hawks}/people/${person('R').userId}`,
      'Riley Rookie'
    )
    await tapTestId(m, 'person-message')
    await m.assertVisible({
      text: "Riley Rookie can't use chat yet",
      timeout: 20000
    })
    await m.assertVisible({ text: 'Choose a guardian to message' })
    await m.assertVisible({ text: 'Nora Nash' })
    await shot(m, 'guardian-picker.png')
    await m.tapOn({ id: `dm-proxy-${person('N').userId}` })
    await chatOpened(m, 'N')
  })
}

async function coach(m: Device): Promise<void> {
  const { hawks, quilvio } = seedIds()
  await webSignIn(m, 'Hc')
  await open(m, `/teams/${hawks}/people/${quilvio}`, 'Quilvio Veras')
  const before = await dms(m)
  await tapTestId(m, 'person-message')
  await m.assertVisible({ text: 'Choose a coach to message', timeout: 20000 })
  await m.assertVisible({ text: 'Harper Hawkins' })
  await m.assertNotVisible({
    id: `dm-proxy-${person('Hc').userId}`,
    timeout: 2000
  })
  await shot(m, 'coach-picker.png')
  await tapTestId(m, 'dm-proxy-cancel')
  await m.assertNotVisible({ id: 'dm-proxy-picker', timeout: 10000 })
  assert.equal(await dms(m), before, 'Cancel made no DM')
  await tapTestId(m, 'person-message')
  await m.tapOn({ id: `dm-proxy-${person('Ha').userId}`, timeout: 20000 })
  await chatOpened(m, 'Ha')
}

async function game(m: Device): Promise<void> {
  const { league, season, hawksNext } = seedIds()
  const blair = person('B').userId
  const type = makeId('umpireType')
  const level = makeId('umpireLevel')
  const slot = `${type}:1`
  // What the league had, put back after; every write below is undone, and
  // only those.
  const managed = await database(
    async db =>
      (
        await db.query<{ umpire_management: boolean }>(
          'select umpire_management from leagues where id = $1',
          [league]
        )
      ).rows[0].umpire_management
  )
  let granted = false
  try {
    await database(async db => {
      await db.query(
        'update leagues set umpire_management = true where id = $1',
        [league]
      )
      await db.query(
        `insert into umpire_types (id, league_id, name, position) values ($1, $2, 'Plate', 0)`,
        [type, league]
      )
      await db.query(
        `insert into umpire_levels (id, league_id, name, position) values ($1, $2, 'majors', 0)`,
        [level, league]
      )
      await db.query(
        'insert into season_umpire_requirements (season_id, level_id) values ($1, $2)',
        [season, level]
      )
      await db.query(
        `insert into season_umpire_type_requirements (season_id, type_id, required_count, optional_count)
         values ($1, $2, 1, 0)`,
        [season, type]
      )
      granted =
        (
          await db.query(
            `insert into league_umpires (league_id, user_id, granted_by) values ($1, $2, $3)
             on conflict do nothing`,
            [league, blair, person('L').userId]
          )
        ).rowCount === 1
      await db.query(
        `insert into umpire_certifications (user_id, level_id, type_id, enabled) values ($1, $2, $3, true)`,
        [blair, level, type]
      )
      await db.query(
        `insert into umpire_assignments (game_id, slot, user_id, assigned_by) values ($1, $2, $3, $3)`,
        [hawksNext, slot, blair]
      )
    })
    step(
      'QPLL umpires on; Blair Brooks holds the plate on the Hawks’ next game'
    )
    await webSignIn(m, 'Hc')
    await open(m, `/games/${hawksNext}`, 'Blair Brooks')
    await m.tapOn({ text: 'Blair Brooks' })
    await m.assertVisible({
      css: '[aria-label="Message Blair Brooks"]',
      timeout: 30000
    })
    assert.match(
      await address(m),
      new RegExp(`^/leagues/${league}/people/${blair}`),
      'the umpire opened their league card'
    )
    await shot(m, 'game-umpire-message.png')
    await pill(m, 'Blair Brooks')
    await chatOpened(m, 'B')
  } finally {
    await database(async db => {
      await db.query(
        'delete from umpire_assignments where game_id = $1 and slot = $2',
        [hawksNext, slot]
      )
      await db.query('delete from umpire_certifications where type_id = $1', [
        type
      ])
      if (granted)
        await db.query(
          'delete from league_umpires where league_id = $1 and user_id = $2',
          [league, blair]
        )
      await db.query(
        'delete from season_umpire_type_requirements where type_id = $1',
        [type]
      )
      await db.query(
        'delete from season_umpire_requirements where level_id = $1',
        [level]
      )
      await db.query('delete from umpire_levels where id = $1', [level])
      await db.query('delete from umpire_types where id = $1', [type])
      await db.query(
        'update leagues set umpire_management = $2 where id = $1',
        [league, managed]
      )
    })
    step('QPLL umpires as they were')
  }
}

async function apiLog(m: Device): Promise<void> {
  const { quilvio } = seedIds()
  const lines: string[] = []
  const get = async (
    viewer: string,
    path: string,
    key: string
  ): Promise<void> => {
    const answer = await read<{ status: number; body: unknown }>(
      m,
      `fetch(${JSON.stringify(api() + path)}, { credentials: 'include' }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`
    )
    lines.push(
      `$ GET /api/v1${path.replace(/userId=[^&]+/, `userId=<${key}>`)}   (as ${viewer})`
    )
    lines.push(`${answer.status} ${JSON.stringify(answer.body)}`)
  }
  await withGuardian(async () => {
    await webSignIn(m, 'Hc')
    for (const [key, id] of [
      ['A', person('A').userId],
      ['R', person('R').userId],
      ['Q', quilvio]
    ] as const)
      await get('Hc', `/chat/dm-reach?userId=${id}`, key)
    for (const [key, id] of [
      ['R', person('R').userId],
      ['Q', quilvio]
    ] as const)
      await get('Hc', `/chat/dm-proxies?userId=${id}`, key)
    await webSignIn(m, 'Ec')
    await get('Ec', `/chat/dm-reach?userId=${person('R').userId}`, 'R')
    await get('Ec', `/chat/dm-proxies?userId=${person('R').userId}`, 'R')
  })
  const path = resolve(required('TS_CHAT_ARTIFACTS'), 'dm-reach.log')
  writeFileSync(path, lines.join('\n') + '\n')
  step(`log ${path}`)
}

const MODES: Record<string, (m: Device) => Promise<void>> = {
  profile,
  player,
  phone,
  guardian,
  coach,
  game,
  'api-log': apiLog
}

/** `TS_CHAT_VIEWPORT=<w>x<h>`; 1440×900 unless given. */
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
  const daemon = await maestro(process.env.MAESTRO_D ?? 'improveUmpireMessages')
  const session = await browserSession(
    daemon,
    'messages-web',
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
  const { m, close } = await device()
  try {
    for (const mode of modes) {
      step(`mode ${mode}`)
      // Each mode signs in afresh: the sign-in limits start over, as the
      // test harness's own resetLimits does.
      await database(async db => await db.query('delete from rate_events'))
      await MODES[mode](m)
    }
  } finally {
    await close()
  }
  console.log(`messageButtons: ${modes.join(', ')} passed`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
