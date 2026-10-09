// Run with node -r sucrase/register. Drives the phone app's team screen
// against the team-schedule fixture, which this script serves over HTTP, and
// checks that the section pills pin under the header and that the schedule
// opens at the next game.
//
// Required env: TEST_PLATFORM (ios or android), TEST_DEVICE, MAESTRO_D (the
// daemon's name; start it first with `maestro-d start --daemon <name>`),
// MAESTRO_D_CLIENT_ROOT (the maestro-d npm package), TEST_ARTIFACT_DIR,
// TEST_PHASE (before or after), and TS_FIXTURE_HOST, the address the app's
// JavaScript was bundled to call: Metro runs with
// TS_API_BASE_URL=http://<TS_FIXTURE_HOST>:<TS_FIXTURE_PORT>/api/v1.
// TS_FIXTURE_PORT defaults to 9317. TS_FIXTURE_SEASON (normal, the default,
// or over) picks the fixture's season; run E13 alone with over as well.
// TEST_ONLY is a comma list of scenario ids
// (default all). `before` captures and logs without asserting.
//
// The header is read with tesseract, so it must be on PATH, and screenshots
// are cropped with ffmpeg.
//
// The app is a Debug build loading its JavaScript from Metro with dev mode
// off, so no development banner or warning toast covers what is measured:
// on an iOS simulator the app's defaults RCT_jsLocation (host:port) and
// RCT_enableDev (NO); on Android the app's shared preferences
// debug_http_host and js_dev_mode_debug (false).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import {
  FIRST_ROW,
  type FixtureSeason,
  LAST_ROW,
  NEXT_ROW,
  PREVIOUS_ROW,
  TEAM_ID,
  TEAM_NAME,
  teamScheduleAnswer
} from '../../test/teamScheduleFixture'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Element {
  id?: string
  text?: string
  accessibilityText?: string
  bounds?: Bounds
  children?: Element[]
}
interface Device {
  hierarchy: () => Promise<Element>
  tapOnPoint: (options: { point: string }) => Promise<unknown>
  assertVisible: (selector: {
    text: string
    timeout?: number
  }) => Promise<unknown>
  stopApp: (options: { appId: string }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  eval: (script: string) => Promise<unknown>
  swipe: (options: {
    startX: number
    startY: number
    endX: number
    endY: number
    duration: number
  }) => Promise<unknown>
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
/** The card's own line under the team's name; nothing else draws it. */
const CARD_LINE = '5–3 · 8 played'

function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const flatten = (node: Element): Element[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]
const label = (node: Element): string =>
  node.accessibilityText ?? node.text ?? ''
async function serveFixture(
  host: string,
  port: number,
  season: FixtureSeason
): Promise<Server> {
  const now = Date.now()
  const server = createServer((request, response) => {
    const answer = teamScheduleAnswer(
      request.method ?? 'GET',
      request.url ?? '/',
      now,
      (method, path) => {
        console.log(`fixture: unanswered ${method} ${path}`)
      },
      season
    )
    response.writeHead(answer.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(answer.body))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return server
}

async function main(): Promise<void> {
  const platform = required('TEST_PLATFORM')
  assert(platform === 'ios' || platform === 'android', 'TEST_PLATFORM')
  const phase = required('TEST_PHASE')
  assert(phase === 'before' || phase === 'after', 'TEST_PHASE')
  const asserting = phase === 'after'
  const device = required('TEST_DEVICE')
  const artifacts = resolve(required('TEST_ARTIFACT_DIR'))
  const only = (process.env.TEST_ONLY ?? '').split(',').filter(id => id !== '')
  const wanted = (id: string): boolean => only.length === 0 || only.includes(id)
  await mkdir(artifacts, { recursive: true })
  const season = (process.env.TS_FIXTURE_SEASON ?? 'normal') as FixtureSeason
  const server = await serveFixture(
    required('TS_FIXTURE_HOST'),
    Number(process.env.TS_FIXTURE_PORT ?? 9317),
    season
  )

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
  // Hierarchy bounds are points on iOS and pixels on Android; screenshots are
  // pixels on both.
  const scale =
    platform === 'ios'
      ? 1
      : Number(
          /(\d+)\s*$/.exec(
            execFileSync('adb', ['-s', device, 'shell', 'wm', 'density'], {
              encoding: 'utf8'
            })
          )![1]
        ) / 160
  /** Two points either way: iOS rounds accessibility frames outward. */
  const tolerance = 2 * scale
  const lines: string[] = []
  const log = (line: string): void => {
    lines.push(line)
    console.log(line)
  }
  const check = (ok: boolean, message: string): void => {
    log(`${ok ? 'ok' : asserting ? 'FAIL' : 'observed'}: ${message}`)
    if (asserting) assert(ok, message)
  }
  const near = (a: number | undefined, b: number | undefined): boolean =>
    a != null && b != null && Math.abs(a - b) <= tolerance

  try {
    const m = await daemon.attach({ device, platform, appId: APP })
    const all = async (): Promise<Element[]> => flatten(await m.hierarchy())
    /**
     * The screen, in hierarchy units: the root's box on iOS; Android's root
     * has none, and a scrolled content box is taller than the screen, so
     * there it is the display's own size.
     */
    const screen = async (): Promise<Bounds> => {
      if (platform === 'ios') return (await all())[0].bounds!
      const size = /(\d+)x(\d+)\s*$/.exec(
        execFileSync('adb', ['-s', device, 'shell', 'wm', 'size'], {
          encoding: 'utf8'
        })
      )!
      return { x: 0, y: 0, width: Number(size[1]), height: Number(size[2]) }
    }

    /** Where everything that matters is, in one read. */
    interface Layout {
      card?: Bounds
      /** The card's own title, the lower of the two drawings of the name. */
      title?: Bounds
      pill: Bounds
      content?: Bounds
      rows: Record<string, Bounds>
      /** Everything written in each `scheduleGame` row on screen. */
      rowTexts: string[]
    }
    const read = async (): Promise<Layout> => {
      const nodes = await all()
      // The pills are the strip with Stats in it. Videos and Schedule are
      // also the names of two of the nav bar's destinations, at the bottom.
      const stats = nodes
        .filter(n => label(n) === 'Stats' && n.bounds != null)
        .sort((a, b) => a.bounds!.y - b.bounds!.y)
      // Android leaves out what is off screen. Before this change the pills
      // scrolled away with the page, so a missing strip is "above the top".
      const pill = stats[0]?.bounds ?? { x: 0, y: -10000, width: 0, height: 0 }
      const rows: Record<string, Bounds> = {}
      const rowTexts: string[] = []
      const games = nodes.filter(
        n => n.id === 'scheduleGame' && n.bounds != null
      )
      // A row's words are not always inside its node: iOS hands the
      // pressable's label up as a sibling. What lies within the row's box is
      // the row's.
      const inside = (outer: Bounds, inner: Bounds): boolean =>
        inner.x >= outer.x - 1 &&
        inner.y >= outer.y - 1 &&
        inner.x + inner.width <= outer.x + outer.width + 1 &&
        inner.y + inner.height <= outer.y + outer.height + 1
      for (const game of games) {
        const words = nodes
          .filter(n => n.bounds != null && inside(game.bounds!, n.bounds))
          .map(label)
          .filter(text => text !== '')
        // Only rows in view below the pills: the held card lies over the
        // rows scrolled up under it, and its title is the team's name.
        if (game.bounds!.y >= pill.y + pill.height)
          rowTexts.push(words.join(' '))
        const line = words.find(text => /^(@|vs) /.test(text))
        if (line != null) rows[line.split(',')[0]] = game.bounds!
      }
      if (games.length === 0) {
        // Before this change the rows had no wrapper of their own: read the
        // line itself.
        for (const n of nodes) {
          const text = label(n)
          if (n.bounds != null && /^(@|vs) /.test(text)) rows[text] = n.bounds
        }
      }
      const card = nodes.find(n => label(n) === CARD_LINE)?.bounds
      const title =
        card == null
          ? undefined
          : nodes
              .filter(
                n =>
                  label(n) === TEAM_NAME &&
                  n.bounds != null &&
                  n.bounds.y < card.y
              )
              .sort((a, b) => b.bounds!.y - a.bounds!.y)[0]?.bounds
      return {
        card,
        title,
        pill,
        content: nodes.find(n => n.id === 'teamTabContent')?.bounds,
        rows,
        rowTexts
      }
    }
    /** Waits until two reads 500 ms apart agree, so a fling has stopped. */
    const settled = async (): Promise<Layout> => {
      let last = JSON.stringify(await read())
      for (let i = 0; i < 12; i++) {
        await pause(500)
        const now = JSON.stringify(await read())
        if (now === last) return JSON.parse(now) as Layout
        last = now
      }
      throw new Error('The screen never settled')
    }
    const tapPill = async (name: string): Promise<Layout> => {
      let strip = (await read()).pill
      if (strip.y < 0) {
        // Only before this change: the pills scrolled away with the page,
        // and the only way back to them is the top of the page.
        check(false, `the ${name} pill is on screen to tap`)
        for (let i = 0; i < 10 && strip.y < 0; i++)
          strip = (await drag(400)).pill
      }
      const nodes = await all()
      const target = nodes
        .filter(n => label(n) === name && n.bounds != null)
        .sort(
          (a, b) =>
            Math.abs(a.bounds!.y - strip.y) - Math.abs(b.bounds!.y - strip.y)
        )[0]?.bounds
      assert(target != null, `the ${name} pill is on screen`)
      await m.tapOnPoint({
        point: `${Math.round(target.x + target.width / 2)},${Math.round(
          target.y + target.height / 2
        )}`
      })
      await pause(800)
      return await settled()
    }

    // iOS: W3C touch actions through this daemon's own WebDriverAgent, as in
    // rosterDrag.e2e.ts, so a drag is a drag and not a fling.
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
    if (platform === 'ios') {
      const daemonLog = await readFile(
        join(daemon.info.runDir, 'daemon.log'),
        'utf8'
      )
      const line = daemonLog
        .split('\n')
        .filter(s => s.includes(`Starting WDA on device ${device} (port:`))
        .at(-1)
      const port = line?.match(/\(port: (\d+)\)/)?.[1]
      assert(port != null, 'This daemon started WebDriverAgent')
      wda = { url: `http://127.0.0.1:${port}`, session: '' }
      const status = (await request('/status')) as { sessionId: string }
      wda.session = status.sessionId
    }
    /**
     * A slow drag of `dy` points: positive moves the content down (toward
     * the top of the list), negative moves it up. Held at the end so it does
     * not fling.
     */
    const drag = async (dy: number): Promise<Layout> => {
      const { width, height } = await screen()
      const x = Math.round(width / 2)
      const travel = dy * scale
      const from = Math.round(travel > 0 ? height * 0.4 : height * 0.8)
      const to = Math.round(from + travel)
      if (platform === 'ios') {
        const move = (y: number, ms: number): unknown => ({
          type: 'pointerMove',
          duration: ms,
          x,
          y,
          origin: 'viewport'
        })
        await request(`/session/${wda!.session}/actions`, {
          actions: [
            {
              type: 'pointer',
              id: 'finger',
              parameters: { pointerType: 'touch' },
              actions: [
                move(from, 0),
                { type: 'pointerDown', button: 0 },
                move(Math.round(from + travel / 2), 400),
                move(to, 400),
                { type: 'pause', duration: 300 },
                { type: 'pointerUp', button: 0 }
              ]
            }
          ]
        })
      } else {
        await m.swipe({
          startX: x,
          startY: from,
          endX: x,
          endY: to,
          duration: 1500
        })
      }
      return await settled()
    }
    const dragToEnd = async (dy: number): Promise<Layout> => {
      let last = JSON.stringify(await read())
      for (let i = 0; i < 20; i++) {
        const now = await drag(dy)
        if (JSON.stringify(now) === last) return now
        last = JSON.stringify(now)
      }
      throw new Error('The screen kept scrolling')
    }

    const shots = join(tmpdir(), `teamPinnedHead-${process.pid}`)
    await mkdir(shots, { recursive: true })
    let shotCount = 0
    /** A screenshot on disk: kept in the artifacts when it has a name. */
    const capture = async (name?: string): Promise<string> => {
      const png = await m.screenshot()
      const file =
        name == null
          ? join(shots, `shot-${++shotCount}.png`)
          : join(artifacts, `${platform}-${name}-${phase}.png`)
      await writeFile(file, png)
      if (name != null) log(`captured ${platform}-${name}-${phase}.png`)
      return file
    }
    /**
     * Whether the header reads the team's name. The strip runs from the top
     * of the screen to just above the card's own title as the screen first
     * drew it, so the title itself is never in it.
     */
    let stripBottom = 0
    /**
     * Once pinned, only the header's own row is read: the 48 points above
     * the pills. The status bar above it is left out, because the card's
     * title can sit behind it, and iOS's glass refracts rather than blurs.
     */
    let headerRow: { top: number; bottom: number } | undefined
    const headerReadsName = async (
      file: string,
      row?: { top: number; bottom: number }
    ): Promise<boolean> => {
      const top = Math.round((row?.top ?? 0) * pixelScale)
      const pixels = Math.round(
        ((row?.bottom ?? stripBottom) - (row?.top ?? 0)) * pixelScale
      )
      const crop = join(shots, `${basename(file)}.header.png`)
      execFileSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-i',
        file,
        '-vf',
        `crop=iw:${pixels}:0:${top},scale=2*iw:-1`,
        crop
      ])
      const text = execFileSync('tesseract', [crop, '-', '--psm', '6'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return text.includes(TEAM_NAME)
    }
    /** Screenshot pixels per hierarchy unit. */
    let pixelScale = 1

    const open = async (path = ''): Promise<Layout> => {
      await m.stopApp({ appId: APP })
      await m.openLink({ link: `teamstation:///teams/${TEAM_ID}${path}` })
      await m.assertVisible({ text: CARD_LINE, timeout: 30000 })
      await pause(1500)
      return await settled()
    }

    // E1 — the card in full, the pills under it, no name in the header.
    const rest = await open()
    const first = await capture('arrive')
    const sizeOut = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', first],
      { encoding: 'utf8' }
    )
    pixelScale = Number(sizeOut.trim()) / (await screen()).width
    stripBottom = (rest.title?.y ?? rest.card?.y ?? 0) - 4 * scale
    /** How far below the pills a tab's content starts. */
    const lead =
      (rest.content?.y ?? rest.pill.y + rest.pill.height) - rest.pill.y
    const start = (layout: Layout): number => layout.pill.y + lead
    check(
      rest.card != null && rest.card.y + rest.card.height <= rest.pill.y,
      'E1: the card is above the pills'
    )
    check(!(await headerReadsName(first)), 'E1: the header shows no name')

    if (['E2', 'E3', 'E4', 'E5', 'E6'].some(wanted)) {
      // E2 — Schedule opens at the next game.
      const anchored = await tapPill('Schedule')
      const names = Object.keys(anchored.rows)
      log(`rows: ${names.join(', ')}`)
      check(
        anchored.rowTexts.length > 0 &&
          anchored.rowTexts.every(text => !text.includes(TEAM_NAME)),
        'E2: no row repeats the team’s own name'
      )
      check(
        near(anchored.rows[NEXT_ROW]?.y, start(anchored)),
        `E2: ${NEXT_ROW} starts right under the pills`
      )
      const previous = anchored.rows[PREVIOUS_ROW]
      check(
        previous == null || previous.y < anchored.pill.y + anchored.pill.height,
        `E2: ${PREVIOUS_ROW} is under the head`
      )
      check(
        near(anchored.card?.y, rest.card?.y) &&
          near(anchored.pill.y, rest.pill.y),
        'E2: the card and pills have not moved'
      )
      check(
        !(await headerReadsName(await capture('schedule'))),
        'E2: the header shows no name'
      )

      // E3 — dragging down shows the earlier games, the card held still.
      const down = await drag(300)
      check(
        (down.rows[PREVIOUS_ROW]?.y ?? -1) >= down.pill.y + down.pill.height,
        `E3: ${PREVIOUS_ROW} is below the pills`
      )
      check(
        near(down.card?.y, rest.card?.y) && near(down.pill.y, rest.pill.y),
        'E3: the card and pills have not moved'
      )
      check(
        !(await headerReadsName(await capture('drag-down'))),
        'E3: the header shows no name'
      )

      // E4 — all the way to the top of the list.
      const top = await dragToEnd(400)
      check(
        near(top.content?.y, start(top)),
        'E4: the schedule’s heading is back under the pills'
      )
      check(
        (top.rows[FIRST_ROW]?.y ?? -1) > (top.content?.y ?? Infinity),
        `E4: ${FIRST_ROW} is directly below the heading`
      )
      check(
        near(top.card?.y, rest.card?.y) && near(top.pill.y, rest.pill.y),
        'E4: the card and pills have still not moved'
      )
      check(
        !(await headerReadsName(await capture())),
        'E4: the header shows no name'
      )

      // E5 — drag up: everything rises together, then the pills pin.
      let before = top
      let pinned: Layout | undefined
      for (let step = 1; step <= 12; step++) {
        const now = await drag(-250)
        const rowsMoved = Object.entries(now.rows).some(
          ([name, b]) =>
            before.rows[name] != null && b.y < before.rows[name].y - tolerance
        )
        if (now.pill.y >= 0 && near(now.pill.y, before.pill.y) && rowsMoved) {
          pinned = now
          break
        }
        check(
          now.pill.y < before.pill.y - tolerance,
          `E5: step ${step}, the pills rise with the rows`
        )
        before = now
      }
      check(pinned != null, 'E5: the pills pin and the rows go on')
      check(
        pinned != null &&
          (pinned.card == null ||
            pinned.card.y + pinned.card.height <= pinned.pill.y),
        'E5: the card has gone under the header'
      )
      if (pinned != null)
        headerRow = { top: pinned.pill.y - 48 * scale, bottom: pinned.pill.y }
      check(
        await headerReadsName(await capture('pinned'), headerRow),
        'E5: the name is in the header'
      )

      // E6 — drag down while pinned: the list returns to its top before the
      // card comes back.
      let topBack = false
      for (let i = 0; i < 20; i++) {
        const last = JSON.stringify(await read())
        const now = await drag(300)
        if (near(now.content?.y, start(now))) topBack = true
        const cardShowing =
          now.card != null && now.card.y > (pinned?.pill.y ?? 0)
        if (cardShowing && !topBack)
          check(false, 'E6: the card came back before the list’s top')
        if (JSON.stringify(now) === last) break
      }
      const back = await settled()
      check(topBack, 'E6: the list came back to its top first')
      check(
        near(back.card?.y, rest.card?.y) && near(back.pill.y, rest.pill.y),
        'E6: at rest the card and pills are where they started'
      )
    }

    if (wanted('E7')) {
      // E7 — every tab pins, and each tap starts that tab under the pills.
      await open()
      await tapPill('Team')
      let pinned = await read()
      for (let i = 0; i < 8; i++) {
        const now = await drag(-250)
        if (now.pill.y >= 0 && near(now.pill.y, pinned.pill.y)) break
        pinned = now
      }
      pinned = await settled()
      headerRow = { top: pinned.pill.y - 48 * scale, bottom: pinned.pill.y }
      check(
        pinned.pill.y >= 0 &&
          pinned.pill.y < rest.pill.y - tolerance &&
          (await headerReadsName(await capture(), headerRow)),
        'E7: the pills pin on Team, the name in the header'
      )
      for (const name of ['Stats', 'Videos', 'Schedule']) {
        const now = await tapPill(name)
        check(
          near(now.pill.y, pinned.pill.y),
          `E7: ${name} leaves the pills pinned where they were`
        )
        const file = await capture(name === 'Videos' ? 'tabs' : undefined)
        check(
          await headerReadsName(file, headerRow),
          `E7: ${name} keeps the name in the header`
        )
        const top = name === 'Schedule' ? now.rows[NEXT_ROW]?.y : now.content?.y
        check(
          near(top, start(now)),
          `E7: ${name} starts directly under the pills`
        )
      }
    }

    if (wanted('E8')) {
      // E8 — opened on the schedule by its address.
      const now = await open('?tab=schedule')
      check(
        near(now.rows[NEXT_ROW]?.y, start(now)),
        `E8: ${NEXT_ROW} starts right under the pills`
      )
      check(near(now.card?.y, rest.card?.y), 'E8: the card is showing')
    }

    if (wanted('E13')) {
      // E13 — from the anchor, a drag up still pins the pills, with the
      // anchored game right under them. Run with TS_FIXTURE_SEASON=over as
      // well: a finished season opens at its last game, and its page must
      // stop there rather than scroll that game away under the pills.
      let before = await open('?tab=schedule')
      let pinned: Layout | undefined
      for (let step = 0; step < 12 && pinned == null; step++) {
        const now = await drag(-100)
        if (now.pill.y >= 0 && near(now.pill.y, before.pill.y)) pinned = before
        before = now
      }
      check(
        pinned != null && pinned.pill.y < rest.pill.y - tolerance,
        'E13: dragging up from the anchor pins the pills'
      )
      const anchor = season === 'over' ? LAST_ROW : NEXT_ROW
      const row = pinned?.rows[anchor]?.y
      check(
        row != null &&
          pinned != null &&
          row <= start(pinned) + tolerance &&
          row >= start(pinned) - 100 * scale - tolerance,
        `E13: ${anchor} is at the content start under the pinned pills`
      )
      // The header's own row, from these pinned pills when E5 has not run.
      if (headerRow == null && pinned != null)
        headerRow = { top: pinned.pill.y - 48 * scale, bottom: pinned.pill.y }
      if (headerRow != null)
        check(
          await headerReadsName(await capture(), headerRow),
          'E13: the name is in the header'
        )
      // A season too short to fill the screen stops with its anchored game
      // still right under the pinned pills. A full one goes on scrolling, so
      // its last games can be reached.
      const end = await dragToEnd(-200)
      if (season === 'over') {
        check(
          near(end.rows[anchor]?.y, start(end)),
          `E13: the page stops with ${anchor} under the pinned pills`
        )
      } else {
        const last = end.rows[LAST_ROW]
        check(
          last != null &&
            last.y >= end.pill.y + end.pill.height &&
            last.y + last.height <= (await screen()).height,
          `E13: a full season scrolls on to its last game, ${LAST_ROW}`
        )
      }
    }

    if (wanted('E10') && platform === 'ios') {
      // E10 — the nav bar's schedule still writes two lines a row.
      await open()
      const nodes = await all()
      const nav = nodes
        .filter(n => label(n) === 'Schedule' && n.bounds != null)
        .sort((a, b) => b.bounds!.y - a.bounds!.y)[0].bounds!
      await m.tapOnPoint({
        point: `${Math.round(nav.x + nav.width / 2)},${Math.round(
          nav.y + nav.height / 2
        )}`
      })
      await m.assertVisible({ text: `.*@ ${TEAM_NAME}.*`, timeout: 15000 })
      const feed = (await all()).map(label).join('\n')
      check(
        /Falcons[\s\S]{0,4}@ Mudcats/.test(feed) ||
          feed.includes(`Falcons @ ${TEAM_NAME}`),
        'E10: Falcons / @ Mudcats'
      )
      check(
        /Mudcats[\s\S]{0,4}@ Pelicans/.test(feed) ||
          feed.includes(`${TEAM_NAME} @ Pelicans`),
        'E10: Mudcats / @ Pelicans'
      )
    }
  } finally {
    await writeFile(
      join(artifacts, `${platform}-e2e-${phase}.txt`),
      lines.join('\n') + '\n'
    )
    daemon.close()
    server.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
