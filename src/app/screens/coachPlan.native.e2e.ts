// Run with node -r sucrase/register. Coach Plan in the real phone app (a Debug
// build on an iOS simulator, its JavaScript from Metro started with
// TS_API_BASE_URL pointing at the local API by the Mac's LAN address), against
// the local stack and a game from `npm run lineup-fixture`, made afresh.
//
//   TEST_DEVICE=<udid> TEST_PLATFORM=ios TEST_PHASE=after MAESTRO_D=<daemon> \
//   MAESTRO_D_CLIENT_ROOT=~/git/maestro-d/npm/maestro-d TEST_ARTIFACT_DIR=<dir> \
//   TS_API_TEST_URL=http://<lan>:9180/api/v1 TS_LINEUP_PASSWORD=<password> \
//     node -r sucrase/register src/app/screens/coachPlan.native.e2e.ts
//
// TEST_ONLY lists the scenarios to run (default all). `before` captures and
// logs without asserting. Never point it at a live service: the fixture
// writes to the database the local `serverConfig.json` names.
//
// S4: the roster footer bar lowers ten points into the 34-point bottom inset
// of an iPhone 16 Pro, on the coaching screen (whose root pads the inset and
// eight points more) and on the scorekeeper's Set Team Rosters sheet; and on
// the coaching screen, Cancel, left of the microphone, restores a lineup a
// player was taken out of. It saves `coach-footer-phone.png`.
//
// S5: the coaching screen's Defense field on a phone. The nine position cards
// sit on six rows, no three sharing a vertical band; CF is above LF and RF,
// P below 3B and 1B; and each card holds its name, on two lines.
//
// The microphone is drawn only when the API dictates; no scenario presses it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import type { LineupFixture } from '../../server/dev/lineupFixture'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Node {
  type?: string
  id?: string
  text?: string
  accessibilityText?: string
  bounds?: Bounds
  children?: Node[]
}
interface Device {
  hierarchy: () => Promise<Node>
  tapOn: (selector: {
    text?: string
    id?: string
    enabled?: boolean
    timeout?: number
  }) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  assertVisible: (selector: {
    text: string
    timeout?: number
  }) => Promise<unknown>
  launchApp: (options: {
    appId: string
    clearState?: boolean
    clearKeychain?: boolean
  }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  acceptAlert: () => Promise<unknown>
  waitForAnimationToEnd: () => Promise<unknown>
  screenshot: () => Promise<Buffer>
  tapOnPoint: (point: { x: number; y: number }) => Promise<unknown>
}
interface Daemon {
  attach: (options: {
    device: string
    platform: string
    appId: string
  }) => Promise<Device>
  close: () => void
}

const APP = 'app.teamstation.app'
const POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']
/** The iPhone 16 Pro's home indicator inset, in points. */
const BOTTOM_INSET = 34
/** How far the footer bar lowers into it. */
const FOOTER_DROP = 10
/** The iPhone 16 Pro's width, in points. */
const WINDOW_WIDTH = 402
function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]
const label = (node: Node): string => node.accessibilityText ?? node.text ?? ''
const inside = (inner: Bounds, outer: Bounds): boolean =>
  inner.x >= outer.x - 1 &&
  inner.y >= outer.y - 1 &&
  inner.x + inner.width <= outer.x + outer.width + 1 &&
  inner.y + inner.height <= outer.y + outer.height + 1

/** A new game, its rosters and the people who use it. */
function lineupFixture(password: string): LineupFixture {
  const out = execFileSync(
    'npm',
    ['run', '--silent', 'lineup-fixture', '--', '--password', password],
    { encoding: 'utf8' }
  )
  return JSON.parse(out) as LineupFixture
}

/** The positions whose cards share a vertical band, top to bottom. */
function cardRows(cards: Map<string, Bounds>): string[][] {
  const rows: Array<{ bottom: number; positions: string[] }> = []
  for (const [position, card] of [...cards].sort(([, a], [, b]) => a.y - b.y)) {
    const row = rows.at(-1)
    // iOS rounds accessibility frames outward, so cards a point apart can
    // read as touching; only a real overlap shares a band.
    if (row != null && card.y < row.bottom - 1) {
      row.positions.push(position)
      row.bottom = Math.max(row.bottom, card.y + card.height)
    } else rows.push({ bottom: card.y + card.height, positions: [position] })
  }
  return rows.map(row => row.positions.sort())
}

async function main(): Promise<void> {
  assert.equal(required('TEST_PLATFORM'), 'ios', 'TEST_PLATFORM')
  const phase = required('TEST_PHASE')
  assert(phase === 'before' || phase === 'after', 'TEST_PHASE')
  const asserting = phase === 'after'
  const device = required('TEST_DEVICE')
  // The API Metro's bundle was built against, which the fixture's game is on.
  const api = required('TS_API_TEST_URL')
  assert((await fetch(`${api}/health`)).ok, `${api} answers`)
  const password = required('TS_LINEUP_PASSWORD')
  const artifacts = resolve(required('TEST_ARTIFACT_DIR'))
  const only = (process.env.TEST_ONLY ?? 'S4,S5').split(',')
  await mkdir(artifacts, { recursive: true })
  const requireClient = createRequire(
    join(resolve(required('MAESTRO_D_CLIENT_ROOT')), 'package.json')
  )
  const { MaestroD } = requireClient('maestro-d') as {
    MaestroD: {
      connect: (options: { name: string; spawn: boolean }) => Promise<Daemon>
    }
  }
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  const check = (ok: boolean, message: string): void => {
    console.log(`${ok ? 'ok' : asserting ? 'FAIL' : 'observed'}: ${message}`)
    if (asserting) assert(ok, message)
  }
  try {
    const m = await daemon.attach({ device, platform: 'ios', appId: APP })
    const all = async (): Promise<Node[]> => flatten(await m.hierarchy())
    const link = async (path: string): Promise<void> => {
      await m.openLink({ link: `teamstation://${path}` })
      if ((await all()).some(n => n.type === 'Alert' || n.text === 'Open'))
        await m.acceptAlert()
    }
    /**
     * The app started with its data cleared, signed in as `who` through the
     * password form: a deep link signs in only with a mailed link's token.
     */
    const signIn = async (
      fixture: LineupFixture,
      who: keyof LineupFixture['users']
    ): Promise<void> => {
      await m.launchApp({ appId: APP, clearState: true, clearKeychain: true })
      // A tap before the fresh app settles is lost, so tap until the form
      // has its password field.
      for (let i = 0; i < 5; i++) {
        await m.tapOn({ text: 'Use a password instead', timeout: 60000 })
        await pause(1000)
        if ((await all()).some(n => n.id === 'Password')) break
      }
      await m.tapOn({ id: 'E-mail address' })
      await m.inputText({ text: fixture.users[who].email })
      await m.tapOn({ id: 'Password' })
      await m.inputText({ text: password })
      await m.tapOn({ text: 'Sign in', enabled: true })
      await m.assertVisible({ text: 'Home', timeout: 30000 })
      await pause(2000)
    }
    /** Coach Game for the head coach's team. */
    const coachGame = async (fixture: LineupFixture): Promise<void> => {
      await signIn(fixture, 'headCoach')
      await link(`/games/${fixture.gameId}/coach/${fixture.teams.home}`)
      await m.assertVisible({ text: 'Save Rosters', timeout: 60000 })
    }
    /** Coach Game for the head coach's team, on its Defense tab. */
    const coachDefense = async (fixture: LineupFixture): Promise<void> => {
      await coachGame(fixture)
      await m.tapOn({ text: 'Defense', timeout: 15000 })
      await m.assertVisible({ text: '(Clear|Assign) CF', timeout: 15000 })
      await m.waitForAnimationToEnd()
    }

    /**
     * A Debug build's warning toast sits over the footer bar, where it takes
     * a tap meant for Cancel: close it by the cross at its right end, level
     * with its line of text.
     */
    const closeWarnings = async (): Promise<void> => {
      const toast = (await all()).find(
        n =>
          n.bounds != null &&
          label(n).includes('Open debugger to view warnings')
      )
      if (toast?.bounds == null) return
      await m.tapOnPoint({
        x: WINDOW_WIDTH - 32,
        y: Math.round(toast.bounds.y + toast.bounds.height / 2)
      })
      await pause(1000)
    }
    /** The window's height and the footer bar's bounds, once settled. */
    const footer = async (): Promise<{ height: number; bar: Bounds }> => {
      await m.waitForAnimationToEnd()
      await pause(500)
      const root = await m.hierarchy()
      const nodes = flatten(root)
      // The application's own frame: the window, not content scrolled past it.
      const height = root.bounds?.height ?? 0
      assert(height > 0, 'the window has a height')
      const bar = nodes.find(
        n => n.id === 'Roster footer bar' && n.bounds != null
      )
      assert(bar?.bounds != null, 'the footer bar is in the hierarchy')
      return { height, bar: bar.bounds }
    }
    /** The lineup's Remove buttons, top to bottom: its batting order. */
    const lineup = async (): Promise<string[]> =>
      (await all())
        .filter(n => n.bounds != null && label(n).startsWith('Remove '))
        .sort((a, b) => a.bounds!.y - b.bounds!.y)
        .map(label)

    if (only.includes('S4')) {
      const fixture = lineupFixture(password)
      await coachGame(fixture)
      await m.tapOn({ text: 'Lineup', timeout: 15000 })
      await m.assertVisible({ text: 'Remove .*', timeout: 15000 })
      const coaching = await footer()
      const bottom = coaching.bar.y + coaching.bar.height
      console.log(
        `S4 coaching: window ${coaching.height}, bar bottom ${bottom}`
      )
      check(
        Math.abs(bottom - (coaching.height - BOTTOM_INSET - 8 + FOOTER_DROP)) <=
          1,
        `the coaching bar ends ${FOOTER_DROP} points into the bottom inset`
      )
      const nodes = await all()
      const at = (text: string): Bounds | undefined =>
        nodes.find(n => label(n) === text && n.bounds != null)?.bounds
      const cancel = at('Cancel')
      const save = at('Save Rosters')
      const mic = nodes.find(n => n.id === 'Roster mic' && n.bounds != null)
      check(cancel != null && save != null, 'Cancel and Save Rosters are shown')
      check(mic?.bounds != null, 'the microphone is shown')
      if (cancel != null && save != null && mic?.bounds != null) {
        check(
          cancel.x + cancel.width <= mic.bounds.x + 1 &&
            mic.bounds.x + mic.bounds.width <= save.x + 1,
          'Cancel is left of the microphone, Save right of it'
        )
        check(
          Math.abs(cancel.y + cancel.height / 2 - (save.y + save.height / 2)) <=
            4,
          'Cancel is on Save Rosters’ row'
        )
      }
      await closeWarnings()
      await writeFile(
        join(artifacts, 'coach-footer-phone.png'),
        await m.screenshot()
      )
      // Taking the leadoff batter out moves his card off the lineup;
      // Cancel puts it back.
      const order = await lineup()
      console.log(`S4 lineup: ${JSON.stringify(order)}`)
      check(order.length > 1, 'the lineup lists its batters')
      await m.tapOn({ text: order[0] })
      await pause(1000)
      const moved = await lineup()
      check(
        JSON.stringify(moved) !== JSON.stringify(order),
        'the lineup changed'
      )
      // A tap while the lineup still settles is lost: let it come to rest.
      await m.waitForAnimationToEnd()
      await pause(1500)
      await closeWarnings()
      await m.tapOn({ text: 'Cancel' })
      // Cancel reads the game again; wait for its lineup.
      let restored = await lineup()
      for (
        let tries = 0;
        tries < 20 && JSON.stringify(restored) !== JSON.stringify(order);
        tries++
      ) {
        await pause(500)
        restored = await lineup()
      }
      console.log(`S4 restored: ${JSON.stringify(restored)}`)

      await signIn(fixture, 'scorekeeper')
      await link(`/games/${fixture.gameId}/score`)
      await m.assertVisible({ text: 'Open scoring menu', timeout: 60000 })
      await pause(2000)
      for (const close of ['OK', 'Close'])
        if ((await all()).some(n => label(n) === close))
          await m.tapOn({ text: close })
      await m.tapOn({ text: 'Open scoring menu' })
      await m.tapOn({ text: 'Set Team Rosters', timeout: 15000 })
      await m.assertVisible({ text: 'Save Rosters', timeout: 30000 })
      const sheet = await footer()
      const sheetBottom = sheet.bar.y + sheet.bar.height
      console.log(
        `S4 scorekeeper: window ${sheet.height}, bar bottom ${sheetBottom}`
      )
      check(
        Math.abs(sheetBottom - (sheet.height - BOTTOM_INSET + FOOTER_DROP)) <=
          1,
        `the scorekeeper's bar ends ${FOOTER_DROP} points into the bottom inset`
      )
      // Checked last, so the scorekeeper's bar is read whatever Cancel did.
      check(
        JSON.stringify(restored) === JSON.stringify(order),
        'Cancel restored the lineup'
      )
    }

    if (only.includes('S5')) {
      const fixture = lineupFixture(password)
      await coachDefense(fixture)
      const nodes = await all()
      const cards = new Map<string, Bounds>()
      for (const position of POSITIONS) {
        const card = nodes.find(
          n =>
            n.bounds != null &&
            new RegExp(`^(Clear|Assign) ${position}$`).test(label(n))
        )
        assert(card?.bounds != null, `the ${position} card is on screen`)
        cards.set(position, card.bounds)
      }
      const rows = cardRows(cards)
      console.log(`S5 rows: ${JSON.stringify(rows)}`)
      check(
        Math.max(...rows.map(row => row.length)) < 3,
        'no three cards share a vertical band'
      )
      check(
        JSON.stringify(rows) ===
          JSON.stringify([
            ['CF'],
            ['LF', 'RF'],
            ['2B', 'SS'],
            ['1B', '3B'],
            ['P'],
            ['C']
          ]),
        'six rows: CF; LF RF; SS 2B; 3B 1B; P; C'
      )
      const at = (position: string): Bounds => cards.get(position)!
      check(
        at('CF').y + at('CF').height <= Math.min(at('LF').y, at('RF').y) + 1,
        'CF is above LF and RF'
      )
      check(
        at('P').y + 1 >=
          Math.max(at('3B').y + at('3B').height, at('1B').y + at('1B').height),
        'P is below 3B and 1B'
      )
      // XCUITest exposes only some cards' text, so every name it does show
      // in the field must lie wholly inside one card, on a 17-point line
      // (13.75 × 1.2, framed a point larger), and each card holds two lines.
      const fieldBottom = Math.max(
        ...[...cards.values()].map(card => card.y + card.height)
      )
      const shown = nodes.filter(
        n =>
          n.type === 'StaticText' &&
          n.bounds != null &&
          n.bounds.y < fieldBottom &&
          /^#\d+ /.test(label(n))
      )
      check(shown.length > 0, 'the hierarchy shows a fielder’s name')
      for (const text of shown) {
        const holder = POSITIONS.filter(position =>
          inside(text.bounds!, at(position))
        )
        check(
          holder.length === 1,
          `"${label(text)}" lies inside the ${holder.join(', ')} card`
        )
        check(
          Math.abs(text.bounds!.height - 18) <= 1,
          `"${label(text)}" is a line ${text.bounds!.height} points tall`
        )
      }
      for (const position of POSITIONS)
        check(
          at(position).height >= 40,
          `${position}'s card (${at(position).height} points) holds two lines`
        )
    }
  } finally {
    daemon.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
