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
// S5: the coaching screen's Defense field on a phone. The nine position cards
// sit on six rows, no three sharing a vertical band; CF is above LF and RF,
// P below 3B and 1B; and each card holds its name, on two lines.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
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
  const only = (process.env.TEST_ONLY ?? 'S5').split(',')
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
    /** Coach Game for the head coach's team, on its Defense tab. */
    const coachDefense = async (fixture: LineupFixture): Promise<void> => {
      await signIn(fixture, 'headCoach')
      await link(`/games/${fixture.gameId}/coach/${fixture.teams.home}`)
      await m.assertVisible({ text: 'Save Rosters', timeout: 60000 })
      await m.tapOn({ text: 'Defense', timeout: 15000 })
      await m.assertVisible({ text: '(Clear|Assign) CF', timeout: 15000 })
      await m.waitForAnimationToEnd()
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
