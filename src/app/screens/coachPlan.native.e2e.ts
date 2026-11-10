// Run with node -r sucrase/register. Coach Plan in the real phone app (a Debug
// build on an iOS simulator or a phone, its JavaScript from Metro started with
// TS_API_BASE_URL pointing at the local API by the Mac's LAN address), against
// the local stack and a game from `npm run lineup-fixture`, made afresh.
//
//   TEST_DEVICE=<udid> TEST_PLATFORM=ios TEST_PHASE=after MAESTRO_D=<daemon> \
//   MAESTRO_D_CLIENT_ROOT=~/git/maestro-d/npm/maestro-d TEST_ARTIFACT_DIR=<dir> \
//   TS_API_TEST_URL=http://<lan>:9180/api/v1 TS_LINEUP_PASSWORD=<password> \
//     node -r sucrase/register src/app/screens/coachPlan.native.e2e.ts
//
// TEST_ONLY lists the scenarios to run (default all); the run fails unless
// each of them runs to its end. `before` captures and logs without
// asserting. Never point it at a live service: the fixture writes to the
// database the local `serverConfig.json` names.
//
// A phone, which `simctl` does not know, is not recorded, and takes its deep
// links through `devicectl`, by the app's bundle id: other TeamStation builds
// on it claim `teamstation://` too, and iOS may open one of those, signed out.
//
// S1 to S3 work the coaching screen's Plan tab on one fixture game, in turn:
// S1 taps a cell, which opens the field picker (`coach-plan-phone-picker.png`),
// and taps LF on it, which the cell then reads. S2 holds a cell and drags
// onto C, which it then reads, and drags again off the picture, which
// changes nothing. S3 holds a player and drags him down two rows: his innings
// move with him and the Lineup tab bats him there too. S2 and S3 are drags of
// W3C touch actions through this daemon's WebDriverAgent, recorded by
// `xcrun simctl io recordVideo` into `coach-plan-phone-drag.mp4`.
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
// D4 and D3 drag on the coaching screen's Defense tab, one fixture game,
// recorded on a simulator by `xcrun simctl io recordVideo` into
// `defense-grip-drag.mp4`. D4: 2B cleared by a tap, SS dragged onto it; the
// empty SS box is as tall as its card, and a bench player held and dropped
// on its middle plays SS. D3, after Clear Defense puts everyone on the
// bench: a swipe that starts on a roster card's name scrolls the roster and
// lifts nothing; a quick drag from the name to CF lifts nothing either; the
// same quick drag from the card's grip (its three bars) puts him at CF; and
// a half-second hold on a name, then a drag, puts that player at LF.
//
// The microphone is drawn only when the API dictates; no scenario presses it.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  eval: (script: string) => Promise<unknown>
}
interface Daemon {
  info: { runDir: string }
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
/** Resolves once a child process has ended, by exiting or failing to start. */
const ended = async (child: ReturnType<typeof spawn>): Promise<void> => {
  if (child.exitCode != null || child.signalCode != null) return
  await new Promise(resolve => {
    child.once('exit', resolve)
    child.once('error', resolve)
  })
}

/** The scenarios TEST_ONLY asks for, and those that ran to their end. */
const requested = new Set<string>()
const finished = new Set<string>()

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
  const inventory = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], {
      encoding: 'utf8'
    })
  ) as { devices: Record<string, Array<{ udid: string }>> }
  const simulator = Object.values(inventory.devices)
    .flat()
    .some(sim => sim.udid === device)
  // The API Metro's bundle was built against, which the fixture's game is on.
  const api = required('TS_API_TEST_URL')
  assert((await fetch(`${api}/health`)).ok, `${api} answers`)
  const password = required('TS_LINEUP_PASSWORD')
  const artifacts = resolve(required('TEST_ARTIFACT_DIR'))
  const only = (process.env.TEST_ONLY ?? 'S1,S2,S3,S4,S5,D4,D3').split(',')
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
  for (const id of only) requested.add(id)
  try {
    const m = await daemon.attach({ device, platform: 'ios', appId: APP })
    const all = async (): Promise<Node[]> => flatten(await m.hierarchy())
    const link = async (path: string): Promise<void> => {
      if (!simulator) {
        execFileSync('xcrun', [
          'devicectl',
          'device',
          'process',
          'launch',
          '--device',
          device,
          '--payload-url',
          `teamstation://${path}`,
          APP
        ])
        await pause(4000)
        return
      }
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
      // A phone can drop letters typed in one burst, and the tab bar's Home
      // shows even signed out: type each field a letter at a time once the
      // keyboard has risen, and sign in again, fields cleared, until the
      // form is gone.
      const form = async (): Promise<boolean> =>
        (await all()).some(n => label(n) === 'Sign in to TeamStation')
      for (let attempt = 1; ; attempt++) {
        for (const [field, text] of [
          ['E-mail address', fixture.users[who].email],
          ['Password', password]
        ]) {
          await m.tapOn({ id: field })
          await pause(1200)
          for (const letter of text) await m.inputText({ text: letter })
        }
        await m.tapOn({ text: 'Sign in', enabled: true })
        for (let wait = 0; wait < 15 && (await form()); wait++)
          await pause(1000)
        if (!(await form())) break
        assert(attempt < 3, `${who} signs in`)
        await m.tapOn({ id: 'Clear E-mail address' })
        await m.tapOn({ id: 'Clear Password' })
      }
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

    // W3C touch actions through this daemon's own WebDriverAgent, as
    // rosterDrag.e2e.ts drives them. XCTest folds a pause after pointerDown
    // into the next move, so a hold is a two-point creep.
    let wda: { url: string; session: string } | undefined
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      const url = wda!.url + path
      const script =
        body == null
          ? `http.get(${JSON.stringify(url)})`
          : `http.post(${JSON.stringify(url)}, {body:${JSON.stringify(body)}})`
      const result = (await m.eval(script)) as { status: number; body: string }
      assert.equal(result.status, 200, result.body)
      return JSON.parse(result.body) as unknown
    }
    const touch = async (
      points: Array<{ x: number; y: number; ms: number }>
    ): Promise<void> => {
      if (wda == null) {
        const log = await readFile(
          join(daemon.info.runDir, 'daemon.log'),
          'utf8'
        )
        const line = log
          .split('\n')
          .filter(s => s.includes(`Starting WDA on device ${device} (port:`))
          .at(-1)
        const port = line?.match(/\(port: (\d+)\)/)?.[1]
        assert(port != null, 'This daemon started WebDriverAgent')
        wda = { url: `http://127.0.0.1:${port}`, session: '' }
        const status = (await request('/status')) as { sessionId: string }
        wda.session = status.sessionId
      }
      const move = (p: { x: number; y: number; ms: number }): unknown => ({
        type: 'pointerMove',
        duration: p.ms,
        x: Math.round(p.x),
        y: Math.round(p.y),
        origin: 'viewport'
      })
      await request(`/session/${wda.session}/actions`, {
        actions: [
          {
            type: 'pointer',
            id: 'finger',
            parameters: { pointerType: 'touch' },
            actions: [
              move({ ...points[0], ms: 0 }),
              { type: 'pointerDown', button: 0 },
              ...points
                .slice(1)
                .flatMap(p => [move(p), { type: 'pause', duration: 150 }]),
              { type: 'pointerUp', button: 0 }
            ]
          }
        ]
      })
      await pause(800)
    }
    /** Held 600 ms or more where it starts, then carried to `to`. */
    const holdAndDrag = async (
      from: { x: number; y: number },
      to: { x: number; y: number }
    ): Promise<void> => {
      await touch([
        { ...from, ms: 0 },
        { x: from.x, y: from.y + 2, ms: 1000 },
        { ...to, ms: 1500 },
        { ...to, ms: 400 }
      ])
    }
    const centre = (b: Bounds): { x: number; y: number } => ({
      x: b.x + b.width / 2,
      y: b.y + b.height / 2
    })
    const byId = async (id: string): Promise<Node> => {
      const found = (await all()).find(n => n.id === id && n.bounds != null)
      assert(found?.bounds != null, `${id} is on screen`)
      return found
    }
    /** A plan cell's value, which its label ends with: "Ohtani, inning 2, C". */
    const cellValue = async (row: number, inning: number): Promise<string> => {
      const text = label(await byId(`Plan cell ${row}-${inning}`))
      const match = new RegExp(`, inning ${inning}(?:, (.+))?$`).exec(text)
      return match?.[1] ?? ''
    }
    const cellPlayer = async (row: number, inning: number): Promise<string> =>
      label(await byId(`Plan cell ${row}-${inning}`)).replace(
        /, inning \d+.*$/,
        ''
      )
    /**
     * Records the screen into `file` until the returned stop is called. A
     * phone, which `simctl` cannot record, is not recorded.
     */
    const record = async (file: string): Promise<() => Promise<void>> => {
      if (!simulator) return async () => {}
      const recorder = spawn(
        'xcrun',
        [
          'simctl',
          'io',
          device,
          'recordVideo',
          '--force',
          join(artifacts, file)
        ],
        { stdio: 'ignore' }
      )
      await pause(1500)
      return async () => {
        await pause(1000)
        recorder.kill('SIGINT')
        await ended(recorder)
      }
    }

    if (only.some(id => ['S1', 'S2', 'S3'].includes(id))) {
      const fixture = lineupFixture(password)
      await coachGame(fixture)
      await m.tapOn({ text: 'Plan', timeout: 15000 })
      await byId('Plan cell 1-1')
      await m.waitForAnimationToEnd()
      await closeWarnings()

      if (only.includes('S1')) {
        await m.tapOn({ id: 'Plan cell 2-3' })
        await pause(800)
        const picker = (await all()).some(n => n.id === 'Plan field picker')
        check(picker, 'S1: a tap on a cell opens the field picker')
        await writeFile(
          join(artifacts, 'coach-plan-phone-picker.png'),
          await m.screenshot()
        )
        await m.tapOn({ id: 'Plan pick LF' })
        await pause(800)
        const value = await cellValue(2, 3)
        console.log(`S1 cell 2-3: ${value}`)
        check(value === 'LF', 'S1: a tap on LF writes LF into the cell')
        check(
          !(await all()).some(n => n.id === 'Plan field picker'),
          'S1: the picker closes'
        )
        finished.add('S1')
      }

      const recording =
        only.includes('S2') || only.includes('S3')
          ? spawn(
              'xcrun',
              [
                'simctl',
                'io',
                device,
                'recordVideo',
                '--force',
                join(artifacts, 'coach-plan-phone-drag.mp4')
              ],
              { stdio: 'ignore' }
            )
          : undefined
      try {
        if (recording != null) await pause(1500)
        if (only.includes('S2')) {
          // Where C is drawn for this cell: the picker opens at the same
          // place for it every time.
          await m.tapOn({ id: 'Plan cell 3-2' })
          await pause(800)
          const catcher = centre((await byId('Plan pick C')).bounds!)
          const toggle = centre((await byId('Plan toggle row')).bounds!)
          await m.tapOn({ id: 'Plan picker close' })
          await pause(600)
          const cell = centre((await byId('Plan cell 3-2')).bounds!)
          await holdAndDrag(cell, catcher)
          const value = await cellValue(3, 2)
          console.log(`S2 cell 3-2 after the drag onto C: ${value}`)
          check(value === 'C', 'S2: holding and dragging onto C writes C')
          // Off the picture: the toggle row above the sheet.
          await holdAndDrag(cell, toggle)
          const kept = await cellValue(3, 2)
          console.log(`S2 cell 3-2 after the drag off it: ${kept}`)
          check(kept === 'C', 'S2: letting go off the picture changes nothing')
          check(
            !(await all()).some(n => n.id === 'Plan field picker'),
            'S2: the picker closes after the drag'
          )
          finished.add('S2')
        }
        if (only.includes('S3')) {
          // The player column's names, "#3 Alonso", top to bottom.
          const players = async (): Promise<string[]> => {
            const column = (await byId('Plan player 1')).bounds!
            return [
              ...new Set(
                (await all())
                  .filter(
                    n =>
                      n.bounds != null &&
                      n.bounds.x < column.x + column.width &&
                      /^#\d+ /.test(label(n))
                  )
                  .sort((a, b) => a.bounds!.y - b.bounds!.y)
                  .map(label)
              )
            ]
          }
          const before = await players()
          console.log(`S3 order before: ${JSON.stringify(before)}`)
          const moved = await cellPlayer(3, 2)
          const third = (await byId('Plan player 3')).bounds!
          const fifth = (await byId('Plan player 5')).bounds!
          await holdAndDrag(centre(third), {
            x: third.x + third.width / 2,
            y: fifth.y + fifth.height * 0.75
          })
          await pause(800)
          const after = await players()
          console.log(`S3 order after: ${JSON.stringify(after)}`)
          check(
            JSON.stringify(after) ===
              JSON.stringify([
                before[0],
                before[1],
                before[3],
                before[4],
                before[2],
                ...before.slice(5)
              ]),
            'S3: the third player bats fifth'
          )
          check(
            (await cellPlayer(5, 2)) === moved &&
              (await cellValue(5, 2)) === 'C',
            'S3: his innings moved with him'
          )
          await m.tapOn({ text: 'Lineup', timeout: 15000 })
          await m.assertVisible({ text: 'Remove .*', timeout: 15000 })
          const order = await lineup()
          console.log(`S3 lineup: ${JSON.stringify(order)}`)
          check(
            order[4] === `Remove ${moved}`,
            'S3: the Lineup tab bats him fifth'
          )
          finished.add('S3')
        }
      } finally {
        if (recording != null) {
          await pause(1000)
          recording.kill('SIGINT')
          await new Promise(resolve => recording.once('exit', resolve))
        }
      }
    }

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
      finished.add('S4')
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
      // in the field must lie wholly inside one card, on DefensiveField's
      // 17-point line (11 × 1.25 = 13.75 points, × 1.2, rounded), and each
      // card holds two lines. iOS rounds a frame outward, so the iPhone 16
      // Pro simulator reads that line as 17 or 18 points. A phone whose Text
      // Size is set larger draws it larger too, since React Native text
      // follows Dynamic Type: the iPhone 13 Pro on the bench draws every
      // label about 12% larger, this line at 20 or 21. So a line may be up
      // to a quarter larger, and a point more, which a name wrapped onto two
      // lines never is.
      const line = Math.round(11 * 1.25 * 1.2)
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
          text.bounds!.height >= line &&
            text.bounds!.height <= Math.ceil(line * 1.25) + 1,
          `"${label(text)}" is a line ${text.bounds!.height} points tall`
        )
      }
      for (const position of POSITIONS)
        check(
          at(position).height >= 40,
          `${position}'s card (${at(position).height} points) holds two lines`
        )
      finished.add('S5')
    }

    if (only.includes('D3') || only.includes('D4')) {
      const fixture = lineupFixture(password)
      await coachDefense(fixture)
      await closeWarnings()
      const names = new Set(fixture.players.home.map(player => player.name))
      /**
       * A position's card: "Clear SS" with a fielder, "Assign SS" without.
       * A box with no height has no frame, so it is missing.
       */
      const card = async (at: string): Promise<Node | undefined> =>
        (await all()).find(
          n =>
            n.bounds != null &&
            n.bounds.height > 0 &&
            new RegExp(`^(Clear|Assign) ${at}$`).test(label(n))
        )
      const position = async (
        at: string
      ): Promise<{ held: boolean; bounds: Bounds }> => {
        const found = await card(at)
        assert(found?.bounds != null, `the ${at} card is on screen`)
        return { held: label(found).startsWith('Clear'), bounds: found.bounds }
      }
      /** Waits for a position to be held, or empty. */
      const until = async (at: string, held: boolean): Promise<boolean> => {
        for (let tries = 0; tries < 10; tries++) {
          const found = await card(at)
          if (found == null && !held) return true
          if (found != null && label(found).startsWith('Clear') === held)
            return true
          await pause(500)
        }
        return false
      }
      /**
       * The bench's roster cards in sight, top to bottom, left to right: wholly
       * between the field's lowest card and the footer bar. The hierarchy
       * also lists cards scrolled up under the field.
       */
      const bench = async (): Promise<Node[]> => {
        const nodes = await all()
        const top = Math.max(
          ...nodes
            .filter(
              n => n.bounds != null && /^(Clear|Assign) \S+$/.test(label(n))
            )
            .map(n => n.bounds!.y + n.bounds!.height)
        )
        const bottom = (await byId('Roster footer bar')).bounds!.y
        return nodes
          .filter(
            n =>
              n.bounds != null &&
              names.has(label(n)) &&
              n.bounds.y >= top &&
              n.bounds.y + n.bounds.height <= bottom
          )
          .sort((a, b) =>
            a.bounds!.y === b.bounds!.y
              ? a.bounds!.x - b.bounds!.x
              : a.bounds!.y - b.bounds!.y
          )
      }
      /** A card's grip, its three bars at its left edge, and its name. */
      const grip = (card: Bounds): { x: number; y: number } => ({
        x: card.x + 12,
        y: card.y + card.height / 2
      })
      const name = (card: Bounds): { x: number; y: number } => ({
        x: card.x + card.width * 0.7,
        y: card.y + card.height / 2
      })
      /** A touch carried from one point to another with no hold. */
      const quickDrag = async (
        from: { x: number; y: number },
        to: { x: number; y: number }
      ): Promise<void> => {
        await touch([
          { ...from, ms: 0 },
          { ...to, ms: 400 },
          { ...to, ms: 200 }
        ])
      }
      const stop = await record('defense-grip-drag.mp4')
      try {
        if (only.includes('D4')) {
          const shortstop = (await position('SS')).bounds
          await m.tapOn({ text: 'Clear 2B' })
          check(await until('2B', false), 'D4: a tap clears 2B')
          await quickDrag(
            centre(shortstop),
            centre((await position('2B')).bounds)
          )
          check(
            (await until('SS', false)) && (await position('2B')).held,
            'D4: the shortstop dragged onto the empty 2B plays there'
          )
          const vacated = (await card('SS'))?.bounds
          console.log(
            `D4 SS box before ${JSON.stringify(shortstop)}, empty ${JSON.stringify(vacated)}`
          )
          check(
            vacated != null && vacated.height >= shortstop.height - 2,
            `D4: the empty SS box is its card's height (${vacated?.height ?? 0} of ${shortstop.height})`
          )
          const player = (await bench())[0]
          console.log(`D4 dropping ${label(player)} on SS`)
          await holdAndDrag(name(player.bounds!), centre(shortstop))
          check(
            await until('SS', true),
            'D4: a bench player dropped on the empty box’s middle plays SS'
          )
          check(
            !(await bench()).some(n => label(n) === label(player)),
            `D4: ${label(player)} left the bench`
          )
          finished.add('D4')
        }
        if (only.includes('D3')) {
          await m.tapOn({ text: 'Clear Defense' })
          check(await until('CF', false), 'D3: Clear Defense empties CF')
          await m.waitForAnimationToEnd()
          const first = (await bench())[0]
          const from = name(first.bounds!)
          await touch([
            { ...from, ms: 0 },
            { x: from.x, y: from.y - 160, ms: 300 },
            { x: from.x, y: from.y - 160, ms: 100 }
          ])
          await pause(800)
          const scrolled = (await all()).find(
            n => n.bounds != null && label(n) === label(first)
          )
          console.log(
            `D3 swipe: ${label(first)} at ${first.bounds!.y}, now at ${scrolled?.bounds?.y}`
          )
          check(
            scrolled?.bounds == null ||
              scrolled.bounds.y < first.bounds!.y - 20,
            'D3: a swipe from a card’s name scrolls the roster'
          )
          const fielded = async (): Promise<string[]> => {
            const held: string[] = []
            for (const at of POSITIONS)
              if ((await position(at)).held) held.push(at)
            return held
          }
          check((await fielded()).length === 0, 'D3: the swipe lifted nobody')
          const centreField = centre((await position('CF')).bounds)
          await quickDrag(name((await bench())[0].bounds!), centreField)
          await pause(500)
          check(
            !(await position('CF')).held,
            'D3: a quick drag from a card’s name lifts nothing'
          )
          const gripped = (await bench())[0]
          await quickDrag(grip(gripped.bounds!), centreField)
          check(
            await until('CF', true),
            `D3: the same quick drag from ${label(gripped)}’s grip puts him at CF`
          )
          const held = (await bench())[0]
          await holdAndDrag(
            name(held.bounds!),
            centre((await position('LF')).bounds)
          )
          check(
            await until('LF', true),
            `D3: a half-second hold on ${label(held)}’s name, then a drag, puts him at LF`
          )
          finished.add('D3')
        }
      } finally {
        await stop()
      }
    }
  } finally {
    daemon.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
// An await that never settles, such as one on a child process whose end was
// missed, lets node run out of work and exit 0 part way through: a run that
// would end well fails unless every scenario asked for ran to its end.
process.on('exit', code => {
  const missing = [...requested].filter(id => !finished.has(id))
  if (code !== 0 || missing.length === 0) return
  console.error(`FAIL: ${missing.join(', ')} did not run to the end`)
  process.exitCode = 1
})
