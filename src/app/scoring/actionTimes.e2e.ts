import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { signInTestAccount } from '../../test/passwordFixtures'

/**
 * E1: every scoring action carries the time it was taken, on the server's
 * clock, and keeps it through an Undo and a later correction. The web scorer
 * in Chrome, through maestro-d, scores into a running server; the times are
 * read back from the server.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> \
 *     npx mocha -r sucrase/register --extension ts --timeout 900000 \
 *     src/app/scoring/actionTimes.e2e.ts
 *
 * Needs the API (`npm start`), the web app built against it (`npm run
 * start.web` with `TS_API_BASE_URL` naming the API), both on this machine.
 * It makes its own scorer (`npm run seed`) and game (`npm run scoring-game`)
 * in the development database, with passwords it draws and never prints.
 * `TS_E2E_ARTIFACT_DIR`, when set, receives screenshots.
 */
const APP = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8090'
const API = process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9140/api/v1'
for (const url of [APP, API])
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
    throw new Error(`${url} is not on this machine`)
const artifacts = process.env.TS_E2E_ARTIFACT_DIR
const stamp = Date.now().toString(36)
const SCORER = {
  email: `scorer.${stamp}@example.test`,
  password: randomBytes(18).toString('base64url')
}
const VIEWER = {
  email: `viewer.${stamp}@example.test`,
  password: randomBytes(18).toString('base64url')
}

const requireClient =
  process.env.MAESTRO_D_CLIENT_ROOT == null
    ? createRequire(__filename)
    : createRequire(join(process.env.MAESTRO_D_CLIENT_ROOT, 'package.json'))
const { MaestroD } = requireClient('maestro-d')
let daemon: Awaited<ReturnType<typeof MaestroD.connect>>
type Browser = Awaited<ReturnType<typeof daemon.attach>>

/** Runs a development script and returns what it printed. */
function npm(...args: string[]): string {
  return execFileSync('npm', ['run', '--silent', ...args], {
    encoding: 'utf8'
  })
}

/** One action as the scorer took it: what was tapped, and between when. */
interface Tap {
  label: string
  from: number
  to: number
}

interface StoredRecord {
  actions: Array<{ type: string; call?: string; kind?: string }>
  actionTimes?: string[]
}
interface StoredPlay {
  about: { atBatIndex: number }
  teamStation?: StoredRecord
}
interface StoredGame {
  plays: Array<{ gumbo: StoredPlay }>
  currentPlay: StoredPlay | null
}
/** A stored action, named as `pitch C` or `gameFlow closePlay`, and its time. */
interface Stored {
  what: string
  time: string
}

/**
 * Every stored action and its time, in the order the game was scored: the
 * stored plays, then the at-bat in progress. A play an Undo reopened is read
 * from the at-bat in progress only.
 */
async function storedActions(token: string, gameId: string): Promise<Stored[]> {
  const response = await fetch(`${API}/games/${gameId}/events`, {
    headers: { authorization: `Bearer ${token}` }
  })
  expect(response.status).equals(200)
  const game = (await response.json()) as StoredGame
  const current = game.currentPlay?.about.atBatIndex
  const records = [
    ...game.plays
      .map(row => row.gumbo)
      .filter(play => play.about.atBatIndex !== current)
      .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex),
    ...(game.currentPlay == null ? [] : [game.currentPlay])
  ].map(play => play.teamStation)
  return records.flatMap((record, i) => {
    if (record == null || record.actions.length === 0) return []
    expect(record.actionTimes, `record ${i} has a time per action`).length(
      record.actions.length
    )
    return record.actions.map((action, k) => ({
      what: `${action.type} ${action.call ?? action.kind ?? ''}`.trim(),
      time: record.actionTimes![k]
    }))
  })
}

async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('E1: the time each scoring action was taken', function () {
  let browser: Browser
  let token = ''
  let gameId = ''

  /** Reads a value out of the page. */
  async function probe<T>(script: string): Promise<T> {
    await browser.evalBrowserScript({
      script: `return JSON.stringify(${script})`,
      output: 'probe'
    })
    return JSON.parse((await browser.vars()).probe) as T
  }
  async function tap(label: string): Promise<Tap> {
    const css = `[aria-label="${label}"]`
    await browser.assertVisible({ css, timeout: 15000 })
    const from = Date.now()
    await browser.tapOn({ css, timeout: 15000 })
    return { label, from, to: Date.now() }
  }
  async function undo(): Promise<Tap> {
    const label = await probe<string>(
      `document.querySelector('[aria-label^="Undo "]')?.getAttribute('aria-label') ?? ''`
    )
    expect(label).not.equals('')
    return await tap(label)
  }
  /** Taps each, a second or so apart, as a scorer at the field does. */
  async function score(labels: string[]): Promise<Tap[]> {
    const taps: Tap[] = []
    for (const label of labels) {
      taps.push(await tap(label))
      await pause(1000)
    }
    return taps
  }
  /** Every change has been sent and acknowledged; what the server holds. */
  async function saved(): Promise<Stored[]> {
    const until = Date.now() + 30000
    let last = ''
    for (;;) {
      await pause(1500)
      const pending = await probe<boolean>(
        `document.querySelector('[aria-label="Save status"]') != null`
      )
      const held = await storedActions(token, gameId)
      const now = JSON.stringify(held)
      if (!pending && now === last) return held
      if (Date.now() > until) throw new Error('The game was never saved')
      last = now
    }
  }
  /** The game is back where it started: no pitch, no out. */
  async function atStart(): Promise<boolean> {
    return await probe<boolean>(
      `/Top 1st · 0 balls 0 strikes 0 outs/.test(document.body.textContent)`
    )
  }
  function print(heading: string, held: Stored[]): void {
    console.log(heading)
    for (const [i, action] of held.entries())
      console.log(`  ${String(i).padStart(2)}  ${action.time}  ${action.what}`)
  }
  async function picture(name: string): Promise<void> {
    if (artifacts == null) return
    await writeFile(join(artifacts, `${name}.png`), await browser.screenshot())
  }
  function within(time: string, taken: Tap, what: string): void {
    const at = Date.parse(time)
    expect(at, `${what} at ${time}`).within(taken.from - 1000, taken.to + 1000)
  }

  before(async function () {
    const name = process.env.MAESTRO_D
    if (name == null || name === '') throw new Error('MAESTRO_D is required')
    if (artifacts != null) await mkdir(artifacts, { recursive: true })
    npm('seed', '--', SCORER.email, SCORER.password)
    const made = npm('scoring-game', '--', VIEWER.email, VIEWER.password)
    gameId = /^GAME_ID=(.+)$/m.exec(made)![1]
    token = await signInTestAccount(API, SCORER)
    daemon = await MaestroD.connect({ name })
    const url = `${APP}/games/${gameId}/score`
    browser = await daemon.attach({
      device: `action-times-${stamp}`,
      platform: 'web',
      appId: url,
      stepDelay: 200,
      artifacts: 'on-failure',
      extra: { browser: 'chrome', windowSize: '1280x720' }
    })
    await browser.blockNetwork({
      patterns: ['*fonts.googleapis.com*', '*fonts.gstatic.com*']
    })
    await browser.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: encodeURIComponent(token),
          domain: new URL(API).hostname,
          path: '/'
        }
      ]
    })
    await browser.openBrowser({ url })
    await browser.assertVisible({
      css: 'canvas[data-field-ready="true"]',
      timeout: 60000
    })
    if (
      await probe<boolean>(
        `document.querySelector('[aria-label="OK"]') != null`
      )
    )
      await tap('OK')
  })

  // Runs after a failure too, and stops the daemon however the browser went.
  after(async function () {
    try {
      await browser?.detach()
    } finally {
      await daemon?.shutdown()
    }
  })

  it('stamps every action on the server clock and keeps the times through an Undo and a later correction', async function () {
    console.log(`game ${gameId}`)
    // The lineups are the first action.
    await tap('Open scoring menu')
    await tap('Set Team Rosters')
    const rosters = await tap('Save Rosters')
    await pause(1000)

    // 1. Three at-bats, each a strikeout, a second or so per pitch. The
    // first has fouls in it, so a strike for its first ball still strikes
    // the batter out on the same pitch.
    const first = ['Ball', 'Foul Ball', 'Ball', 'Foul Ball', 'Swing and Miss']
    const second = [
      'Called Strike',
      'Called Strike',
      'Foul Ball',
      'Swing and Miss'
    ]
    const third = ['Ball', 'Called Strike', 'Swing and Miss', 'Called Strike']
    const taps = [rosters, ...(await score([...first, ...second, ...third]))]
    const scored = await saved()
    print('After three at-bats:', scored)
    // Each action the scorer took, at its tap; the screen closes a play
    // itself, between them.
    const taken = scored.filter(action => action.what !== 'gameFlow closePlay')
    expect(taken.map(action => action.what)).deep.equals([
      'lineup roster',
      ...[...first, ...second, ...third].map(
        label =>
          `pitch ${{ Ball: 'B', 'Called Strike': 'C', 'Foul Ball': 'F', 'Swing and Miss': 'S' }[label]}`
      )
    ])
    taken.forEach((action, i) => {
      within(action.time, taps[i], `${i}: ${taps[i].label}`)
    })
    const times = scored.map(action => Date.parse(action.time))
    expect(times).deep.equals([...times].sort((a, b) => a - b))
    await picture('action-times-scored')

    // 2. The last pitch was wrong: undo it and score a ball at once.
    const undone = await undo()
    const [replacement] = await score(['Ball'])
    const replaced = await saved()
    print(`After ${undone.label} and a ball at once:`, replaced)
    const kept = scored.findLastIndex(action => action.what === 'pitch C')
    expect(replaced.slice(0, kept)).deep.equals(scored.slice(0, kept))
    expect(replaced).length(kept + 1)
    expect(replaced[kept].what).equals('pitch B')
    within(replaced[kept].time, replacement, 'the replacement ball')
    expect(Date.parse(replaced[kept].time)).greaterThan(
      Date.parse(scored[kept].time)
    )

    // 3. A minute and a half later, the scorer finds the first at-bat's
    // first ball was a strike: back to it, change it, and enter the rest
    // again exactly as before.
    await pause(90_000)
    for (let undos = 0; !(await atStart()); undos++) {
      expect(undos).lessThan(30)
      await undo()
    }
    const rest = [...first, ...second, ...third].slice(1)
    rest[rest.length - 1] = 'Ball'
    await score(['Called Strike', ...rest])
    const corrected = await saved()
    print('After the correction:', corrected)
    expect(corrected.map(action => action.what)).deep.equals(
      replaced.map((action, i) => (i === 1 ? 'pitch C' : action.what))
    )
    // The corrected pitch keeps the ball's time, and every later action its
    // own, though each was entered again ninety seconds later.
    expect(corrected.map(action => action.time)).deep.equals(
      replaced.map(action => action.time)
    )
    await picture('action-times-corrected')
  })
})
