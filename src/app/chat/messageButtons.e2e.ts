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
 * The Message pill on a person's profile, a player's page and every people
 * row, the picker of whom to message for a player who cannot sign in, and a
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
 * Modes: `profile`, `player`, `row`, `guardian`, `coach`, `levels`, `game`,
 * `api-log`. `guardian` and `api-log` link parent N as player R's guardian
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

async function profile(m: Device): Promise<void> {
  const { hawks } = seedIds()
  await webSignIn(m, 'Hc')
  await open(m, `/teams/${hawks}/people/${person('A').userId}`, 'Alex Ashby')
  const placed = await read<{ inHero: boolean; above: boolean }>(
    m,
    `(() => {
      const pill = document.querySelector('[data-testid="person-message"]')
      const name = [...document.querySelectorAll('[role="heading"]')].find(n => n.textContent === 'Alex Ashby')
      const hero = name?.parentElement?.parentElement
      const roles = [...document.querySelectorAll('div')].find(n => n.textContent === 'TEAM ROLES')
      return {
        inHero: pill != null && hero != null && hero.contains(pill),
        above: pill != null && roles != null && (pill.compareDocumentPosition(roles) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      }
    })()`
  )
  assert.deepEqual(
    placed,
    { inHero: true, above: true },
    'the pill is in the hero row'
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

async function row(m: Device): Promise<void> {
  const { hawks } = seedIds()
  await webSignIn(m, 'Hc')
  await open(m, `/teams/${hawks}`, 'Hawks')
  await m.tapOn({ css: '[role="tab"][aria-label="Team"]' })
  await m.assertVisible({
    css: '[aria-label="Message Alex Ashby"]',
    timeout: 30000
  })
  await shot(m, 'people-row-after.png')
  await pill(m, 'Alex Ashby')
  await chatOpened(m, 'A')
  // The row itself still opens the profile.
  await open(m, `/teams/${hawks}`, 'Hawks')
  await m.tapOn({ css: '[role="tab"][aria-label="Team"]' })
  await m.tapOn({ text: 'Alex Ashby' })
  await m.assertVisible({ text: 'TEAM ROLES', timeout: 30000 })
  assert.match(await address(m), /\/people\//, 'the row opened the profile')
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
      text: "Riley Rookie doesn't have an account",
      timeout: 20000
    })
    await m.assertVisible({ text: 'Choose a guardian to message' })
    await m.assertVisible({ text: 'Nora Nash' })
    await shot(m, 'guardian-picker.png')
    await m.tapOn({ id: `dm-proxy-${person('N').userId}` })
    await chatOpened(m, 'N')
    // From R's row on the people list, the same picker; Cancel makes nothing.
    const before = await dms(m)
    await open(m, `/teams/${hawks}`, 'Hawks')
    await m.tapOn({ css: '[role="tab"][aria-label="Team"]' })
    await pill(m, 'Riley Rookie')
    await m.assertVisible({
      text: 'Choose a guardian to message',
      timeout: 20000
    })
    await tapTestId(m, 'dm-proxy-cancel')
    await m.assertNotVisible({ id: 'dm-proxy-picker', timeout: 10000 })
    assert.equal(await dms(m), before, 'Cancel made no DM')
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

async function levels(m: Device): Promise<void> {
  const { league, season } = seedIds()
  /** The first row pill on the page: whom it names, after pressing it. */
  const firstPill = async (): Promise<string> => {
    const label = await read<string | null>(
      m,
      `document.querySelector('[data-testid="person-message"]')?.getAttribute('aria-label') ?? null`
    )
    assert(label != null, 'a people row carries a Message pill')
    await m.tapOn({ css: `[aria-label="${label}"]` })
    return label.replace(/^Message /, '')
  }
  // The league's people are its own roles and members: coach Hc, made a
  // league member for this mode, is one league admin L may message.
  const member = makeId('leagueMember')
  await database(
    async db =>
      await db.query(
        `insert into league_members (id, league_id, user_id, role, joined_at)
         values ($1, $2, $3, 'member', now())`,
        [member, league, person('Hc').userId]
      )
  )
  try {
    await webSignIn(m, 'L')
    await open(m, `/leagues/${league}`, 'QPLL')
    await m.tapOn({ css: '[role="tab"][aria-label="People"]' })
    await m.assertVisible({ text: 'Hank Coach', timeout: 30000 })
    await m.assertVisible({
      css: '[aria-label="Message Hank Coach"]',
      timeout: 30000
    })
    await read(
      m,
      `(() => { document.querySelector('[aria-label="Message Hank Coach"]').scrollIntoView({ block: 'center' }); return true })()`
    )
    await shot(m, 'league-people-row.png')
    await chatOpened(m, await firstPill())
  } finally {
    await database(
      async db =>
        await db.query('delete from league_members where id = $1', [member])
    )
  }
  // League admin L reads the season's people: its admin and scorekeeper.
  await open(m, `/seasons/${season}`, 'Spring 2027')
  await m.tapOn({ css: '[role="tab"][aria-label="People"]' })
  await m.assertVisible({ text: 'Sam Season', timeout: 30000 })
  await m.assertVisible({
    css: '[aria-label="Message Sam Season"]',
    timeout: 30000
  })
  // A season's and a league's people leave players out, so no row there is
  // a player who cannot sign in: the picker opens from team rows alone.
  assert.equal(
    await read<boolean>(
      m,
      `document.querySelector('[aria-label="Message Quilvio Veras"]') != null`
    ),
    false,
    'no player row on the season list'
  )
  await chatOpened(m, await firstPill())
}

async function game(m: Device): Promise<void> {
  const { league, season, hawksNext } = seedIds()
  const blair = person('B').userId
  const type = makeId('umpireType')
  const level = makeId('umpireLevel')
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
    await db.query(
      `insert into league_umpires (league_id, user_id, granted_by) values ($1, $2, $3)`,
      [league, blair, person('L').userId]
    )
    await db.query(
      `insert into umpire_certifications (user_id, level_id, type_id, enabled) values ($1, $2, $3, true)`,
      [blair, level, type]
    )
    await db.query(
      `insert into umpire_assignments (game_id, slot, user_id, assigned_by) values ($1, $2, $3, $3)`,
      [hawksNext, `${type}:1`, blair]
    )
  })
  step('QPLL umpires on; Blair Brooks holds the plate on the Hawks’ next game')
  try {
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
      await db.query('delete from umpire_assignments where game_id = $1', [
        hawksNext
      ])
      await db.query('delete from umpire_certifications where type_id = $1', [
        type
      ])
      await db.query('delete from league_umpires where league_id = $1', [
        league
      ])
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
        'update leagues set umpire_management = false where id = $1',
        [league]
      )
    })
    step('QPLL umpires off again')
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
  row,
  guardian,
  coach,
  levels,
  game,
  'api-log': apiLog
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
    1440,
    900,
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
