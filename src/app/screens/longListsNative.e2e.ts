import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  LONG_LISTS_SHAPE,
  type LongListsSeed,
  longListsSupport
} from '../../test/longListsSeed'
import { log, maestro } from '../../test/refinementsMaestro.e2e'

/**
 * The long lists scenarios on a phone, through maestro-d's JavaScript library,
 * against `src/test/longListsFixture.e2e.ts`.
 *
 *   TS_LONG_LISTS_ARTIFACTS=… TS_LONG_LISTS_DEVICE=<id> \
 *   TS_LONG_LISTS_PLATFORM=ios|android TS_LONG_LISTS_CASES=E5,E6 \
 *   TS_MAESTRO_D_CLIENT=… MAESTRO_D_BIN=… \
 *     node -r sucrase/register src/app/screens/longListsNative.e2e.ts
 *
 * `TS_LONG_LISTS_DEVICE` is looked up when the run starts, never written here.
 * The manifest is the fixture's, and the app was built against its
 * `apiBaseUrl`.
 *
 * E5 starts from a fresh sign-in, so run it on an app with no session: a
 * simulator cannot lose its network, so the fixture stops answering it.
 */
interface Device {
  launchApp: (options?: unknown) => Promise<unknown>
  stopApp: (options?: unknown) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (selector: unknown) => Promise<unknown>
  assertVisible: (selector: unknown) => Promise<unknown>
  swipe: (options: unknown) => Promise<unknown>
  hierarchy: () => Promise<ViewNode>
  tapOnPoint: (options: { point: string }) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  setOrientation: (options: { orientation: string }) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  detach: () => Promise<unknown>
}

/** A node of `hierarchy()`. */
interface ViewNode {
  id?: string
  text?: string
  type?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: ViewNode[]
}

/** A schedule row in a hierarchy. */
interface ScreenRow {
  y: number
  /** The game's own, for a row with replies, as a date may be two games'. */
  name: string | undefined
  /** What its counts say, in words. */
  replies: string
  ids: string[]
  words: string
}

interface Manifest extends LongListsSeed {
  origin: string
  apiBaseUrl: string
  controlOrigin: string
  email: string
  signInLinkRoute: string
  phoneNetworkRoute: string
}

const APP_ID = 'app.teamstation.app'
/** The read that stores Schedule's first page, as a phone's prefetch asks. */
const UPCOMING_PAGE = '/api/v1/events?paged=1&when=upcoming'
/** A row of the upcoming list, whichever day the run is. */
const ROW_TEXT = 'Demo Hawks'
/** How far the pills may stand from where they pinned, in points. */
const PINNED_SLACK = 2
/** Swipes that pass the end of a first page of 50 rows. */
const SWIPES_PAST_A_PAGE = 24
/** A drag that leaves no fling, and what a drag's start takes from it. */
const DRAG_POINTS = 350
const DRAG_SLACK = 24
/** More than a row or two settling: a page of rows. */
const ROWS_LANDED = 2000
const FLING_POINTS = 420
const FLING_MS = 90
/** A fling over a read goes this share of a plain one, or to the list's top. */
const MOMENTUM_KEPT = 0.7
/** The section title and its space, from the pills to the first row. */
const MOST_BELOW_PILLS = 110
/** The screen's width, and where a row is clear of the tab bar. */
const PHONE_WIDTH = 402
const LOWEST_ROW = 700
const ALL_CASES = 'E1,E2,E3,E4,E5,E6,E7,E8,E9,E10,E11,E12'

function required(name: string): string {
  const value = process.env[name]
  if (value == null || value === '') throw new Error(`Supply ${name}`)
  return value
}

async function main(): Promise<void> {
  const artifacts = required('TS_LONG_LISTS_ARTIFACTS')
  const device = required('TS_LONG_LISTS_DEVICE')
  const platform = required('TS_LONG_LISTS_PLATFORM')
  assert.ok(platform === 'ios' || platform === 'android', platform)
  const support = longListsSupport()
  await mkdir(artifacts, { recursive: true })
  const manifest = JSON.parse(
    await readFile(join(support, 'native-manifest.json'), 'utf8')
  ) as Manifest
  const chosen = (process.env.TS_LONG_LISTS_CASES ?? ALL_CASES)
    .split(',')
    .map(name => name.trim())
  const daemon = await maestro(
    process.env.MAESTRO_D ?? `longListsNative-${platform}`
  )
  const teamId = process.env.MAESTRO_D_TEAM_ID
  const m = (await daemon.attach({
    device,
    platform,
    appId: APP_ID,
    artifacts: 'on-failure',
    ...(teamId != null && teamId !== '' ? { teamId } : {})
  })) as unknown as Device
  /** A hierarchy's unit in points: an Android phone's is the pixel. */
  const scale =
    platform === 'android'
      ? Number(
          /(\d+)\s*$/.exec(
            execFileSync('adb', ['-s', device, 'shell', 'wm', 'density'], {
              encoding: 'utf8'
            })
          )?.[1]
        ) / 160
      : 1
  const phone = platform === 'android'
  const note = async (line: string): Promise<void> => {
    await log(support, `longLists-${platform}.log`, line)
  }
  const visible = async (text: string, timeout = 15000): Promise<void> => {
    await m.assertVisible({ text, timeout })
  }
  const shown = async (text: string, timeout = 3000): Promise<boolean> =>
    await m
      .assertVisible({ text, timeout })
      .then(() => true)
      .catch(() => false)
  const tap = async (text: string): Promise<void> => {
    await m.tapOn({ text, timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 700))
  }
  const scrollDown = async (times: number): Promise<void> => {
    for (let swipe = 0; swipe < times; swipe++)
      await m.swipe({ start: '50%, 75%', end: '50%, 25%', duration: 300 })
  }
  const pause = async (ms: number): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
  const recorded = async (
    name: string,
    run: () => Promise<void>
  ): Promise<void> => {
    // maestro-d's iOS driver does not record, and a simulator can itself.
    if (platform === 'ios') {
      const video = spawn('xcrun', [
        'simctl',
        'io',
        device,
        'recordVideo',
        '--codec=h264',
        '--force',
        join(artifacts, name)
      ])
      await pause(1000)
      try {
        await run()
      } finally {
        const stopped = new Promise(resolve => video.once('exit', resolve))
        video.kill('SIGINT')
        await stopped
      }
      return
    }
    const shell = (...command: string[]): string[] => [
      '-s',
      device,
      'shell',
      ...command
    ]
    const onPhone = '/sdcard/longLists.mp4'
    const video = spawn('adb', shell('screenrecord', onPhone))
    await pause(1000)
    try {
      await run()
    } finally {
      const stopped = new Promise(resolve => video.once('exit', resolve))
      execFileSync('adb', shell('pkill', '-INT', 'screenrecord'))
      await stopped
      await pause(1000)
      execFileSync('adb', [
        '-s',
        device,
        'pull',
        onPhone,
        join(artifacts, name)
      ])
    }
  }
  const shot = async (name: string): Promise<void> => {
    await writeFile(join(artifacts, name), await m.screenshot())
  }
  const signIn = async (): Promise<void> => {
    await m.launchApp({ appId: APP_ID, stopApp: true })
    if (!(await shown('Sign in to TeamStation', 15000))) return
    const asked = await fetch(`${manifest.apiBaseUrl}/auth/email-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: manifest.email })
    })
    assert.equal(asked.status, 202)
    const answer = await fetch(
      `${manifest.origin}${manifest.signInLinkRoute}?email=${encodeURIComponent(manifest.email)}`
    )
    assert.ok(answer.ok, 'No sign-in mail')
    const { link } = (await answer.json()) as { link?: string }
    const token = link?.split('/signin/')[1]
    assert.ok(token != null && token !== '', `No sign-in link in ${link}`)
    await m.openLink({ link: `teamstation://signin/${token}` })
    await visible('Your Home', 30000)
  }
  const onSchedule = async (): Promise<void> => {
    await m.openLink({ link: 'teamstation://schedule' })
    await visible('Upcoming')
  }
  /** Tells the fixture how the phone stands, and hears what it has read. */
  const phoneNetwork = async (offline?: boolean): Promise<string[]> => {
    const asked = offline == null ? '' : `?offline=${offline ? 1 : 0}`
    const answer = await fetch(
      `${manifest.controlOrigin}${manifest.phoneNetworkRoute}${asked}`
    )
    return ((await answer.json()) as { seen: string[] }).seen
  }
  /** The top of the pills on the screen. */
  const pillsTop = async (): Promise<number> => {
    const find = (node: ViewNode): ViewNode | undefined =>
      node.text === 'Past' && node.bounds != null
        ? node
        : (node.children ?? []).map(find).find(found => found != null)
    const past = find(await m.hierarchy())
    assert.ok(past?.bounds != null, 'No Past pill on the screen')
    return past.bounds.y
  }

  const all = async (): Promise<ViewNode[]> => {
    const flat: ViewNode[] = []
    const walk = (node: ViewNode): void => {
      flat.push(node)
      for (const child of node.children ?? []) walk(child)
    }
    // A busy phone can miss the daemon's deadline for reading the tree.
    let tree: ViewNode | undefined
    for (let read = 0; tree == null; read++) {
      tree = await m.hierarchy().catch((error: unknown) => {
        if (read === 7) throw error
        return undefined
      })
    }
    walk(tree)
    return flat
  }
  /** Reads until two agree half a second apart: a fling has stopped. */
  const settled = async (): Promise<ViewNode[]> => {
    let last = JSON.stringify(await all())
    for (let read = 0; read < 16; read++) {
      await pause(500)
      const now = await all()
      if (JSON.stringify(now) === last) return now
      last = JSON.stringify(now)
    }
    throw new Error('The screen never settled')
  }
  /** The team's or the season's section pills, by the strip's Stats pill. */
  const statsPill = (nodes: ViewNode[]): ViewNode => {
    const stats = nodes.find(
      node => node.text === 'Stats' && node.type !== 'StaticText'
    )
    const found =
      stats ?? nodes.find(node => node.text === 'Stats' && node.bounds != null)
    assert.ok(found?.bounds != null, 'No section pills on the screen')
    return found
  }
  const pillsBottom = (nodes: ViewNode[]): number => {
    const { y, height } = statsPill(nodes).bounds!
    return y + height
  }
  const tapPill = async (name: string): Promise<void> => {
    const nodes = await all()
    const strip = statsPill(nodes).bounds!
    const pill = nodes
      .filter(node => node.text === name && node.bounds != null)
      .sort(
        (a, b) =>
          Math.abs(a.bounds!.y - strip.y) - Math.abs(b.bounds!.y - strip.y)
      )[0]
    assert.ok(pill?.bounds != null, `No ${name} pill`)
    const { x, y, width, height } = pill.bounds
    await m.tapOnPoint({
      point: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
    })
    await pause(700)
  }
  /** Each schedule row drawn: its top, and what lies within it. */
  const rowsOf = (nodes: ViewNode[]): ScreenRow[] =>
    nodes
      .filter(node => node.id === 'scheduleGame' && node.bounds != null)
      .map(({ bounds }) => {
        const { x, y, width, height } = bounds!
        const inside = nodes.filter(({ bounds: at }) => {
          return (
            at != null &&
            at.x >= x - 1 &&
            at.y >= y - 1 &&
            at.x + at.width <= x + width + 1 &&
            at.y + at.height <= y + height + 1
          )
        })
        return {
          y,
          name: inside.find(
            node => node.id?.startsWith('schedule-rsvps-') === true
          )?.id,
          replies: inside
            .filter(node => node.id?.startsWith('player-rsvp-count-') === true)
            .map(node => node.text)
            .join(', '),
          ids: inside.flatMap(node => (node.id == null ? [] : [node.id])),
          // In no order: the same row can be read in another.
          words: [
            ...new Set(
              inside.flatMap(node =>
                (phone || node.type === 'StaticText') && node.text != null
                  ? [node.text]
                  : []
              )
            )
          ]
            .sort()
            .join(' ')
        }
      })
      .sort((a, b) => a.y - b.y)
  const contentOf = (nodes: ViewNode[]): ViewNode['bounds'] & object => {
    const content = nodes.find(node => node.id === 'teamTabContent')
    assert.ok(content?.bounds != null, 'No tab content')
    return content.bounds
  }
  /** The first game drawn, by its place in the seed. */
  const gameAt = (nodes: ViewNode[]): number => {
    const places = rowsOf(nodes).map(({ name }) =>
      Number(/gam_long_(\d+)/.exec(name ?? '')?.[1])
    )
    return places.find(place => !Number.isNaN(place)) ?? Number.NaN
  }
  /**
   * How far down the list the second reading stands from the first, in
   * points. Measured at the list's foot, which rows landing above it leave
   * where the reader's rows are. An Android tree stops at the screen, so
   * there it is in games passed.
   */
  const travel = (from: ViewNode[], to: ViewNode[]): number => {
    if (phone) return Math.abs(gameAt(from) - gameAt(to))
    const a = contentOf(from)
    const b = contentOf(to)
    return Math.abs(a.y + a.height - (b.y + b.height))
  }
  const olderReads = (seen: string[]): number =>
    seen.filter(
      path =>
        path.startsWith(`/api/v1/teams/${manifest.teamId}/games?`) &&
        path.includes('cursor=')
    ).length
  /**
   * A finger on the page through this daemon's WebDriverAgent: `dy` points
   * in `ms`, then held for `hold`. With no hold it flings, which maestro-d's
   * `swipe` never does.
   */
  const gesture = async (
    dy: number,
    ms: number,
    hold: number
  ): Promise<void> => {
    const x = 200
    const from = dy > 0 ? 300 : 700
    if (platform === 'android') {
      const place = (points: number): string =>
        String(Math.round(points * scale))
      if (hold > 0) {
        // `input swipe` has no last move: its time-sliced samples stop where
        // the clock did, so a busy phone drags the page short of the finger.
        // These reach the end of the drag however long they take. A scroll
        // view takes the page on the first move past its slop and spends that
        // move doing so, so that one is on top of the drag.
        const slop = Math.sign(dy) * 10
        const steps = Array.from({ length: 16 }, (_, step) => (step + 1) / 16)
        const touch = (action: string, y: number): string =>
          `input motionevent ${action} ${place(x)} ${place(y)}`
        execFileSync('adb', [
          '-s',
          device,
          'shell',
          [
            touch('DOWN', from),
            touch('MOVE', from + slop),
            ...steps.flatMap(part => [
              touch('MOVE', from + slop + dy * part),
              'sleep 0.03'
            ]),
            `sleep ${hold / 1000}`,
            // Still, as the phone's measure of a finger's speed hears it.
            touch('MOVE', from + slop + dy),
            'sleep 0.05',
            touch('MOVE', from + slop + dy),
            'sleep 0.05',
            touch('MOVE', from + slop + dy),
            touch('UP', from + slop + dy)
          ].join(' && ')
        ])
        return
      }
      execFileSync('adb', [
        '-s',
        device,
        'shell',
        'input',
        'swipe',
        place(x),
        place(from),
        place(x),
        place(from + dy),
        String(ms + hold)
      ])
      return
    }
    const move = (y: number, duration: number): unknown => ({
      type: 'pointerMove',
      duration,
      x,
      y,
      origin: 'viewport'
    })
    const { url, session } = await webDriver()
    const body = JSON.stringify({
      actions: [
        {
          type: 'pointer',
          id: 'finger',
          parameters: { pointerType: 'touch' },
          actions: [
            move(from, 0),
            { type: 'pointerDown', button: 0 },
            move(from + dy, ms),
            ...(hold > 0 ? [{ type: 'pause', duration: hold }] : []),
            { type: 'pointerUp', button: 0 }
          ]
        }
      ]
    })
    const answer = await fetch(`${url}/session/${session}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    })
    assert.equal(answer.status, 200, await answer.text())
  }
  let driver: { url: string; session: string } | undefined
  const webDriver = async (): Promise<{ url: string; session: string }> => {
    if (driver != null) return driver
    const { info } = daemon as unknown as { info: { runDir: string } }
    const log = await readFile(join(info.runDir, 'daemon.log'), 'utf8')
    const port = log
      .split('\n')
      .filter(line => line.includes(`Starting WDA on device ${device} (port:`))
      .at(-1)
      ?.match(/\(port: (\d+)\)/)?.[1]
    assert.ok(port != null, 'This daemon started WebDriverAgent')
    const url = `http://127.0.0.1:${port}`
    const status = (await (await fetch(`${url}/status`)).json()) as {
      sessionId: string
    }
    driver = { url, session: status.sessionId }
    return driver
  }

  const webOnly = (name: string) => async () => {
    await note(`${name}: a browser scenario, in src/test/longLists.e2e.ts`)
  }
  const cases: Record<string, () => Promise<void>> = {
    E1: webOnly('E1'),
    E2: webOnly('E2'),
    E3: webOnly('E3'),
    E4: webOnly('E4'),
    E5: async () => {
      // Home's prefetch stores the first page, and Schedule was never opened.
      for (let wait = 0; wait < 60; wait++) {
        if ((await phoneNetwork()).includes(UPCOMING_PAGE)) break
        await pause(500)
      }
      assert.ok(
        (await phoneNetwork()).includes(UPCOMING_PAGE),
        'E5: Home did not store the first page'
      )
      const stored = (await phoneNetwork()).length
      await pause(2000)
      await phoneNetwork(true)
      await onSchedule()
      await visible(ROW_TEXT)
      await note('E5: Schedule painted offline, from the prefetch alone')
      await phoneNetwork(false)
      assert.ok((await phoneNetwork()).length >= stored)

      await recorded(`${platform}-schedule-pills.mp4`, async () => {
        await tap('Past')
        await visible('Demo Owls')
        const atRest = await pillsTop()
        await scrollDown(1)
        const pinned = await pillsTop()
        assert.ok(pinned < atRest, 'E5: the pills went up with the page')
        await scrollDown(5)
        assert.ok(
          Math.abs((await pillsTop()) - pinned) <= PINNED_SLACK,
          'E5: the pills stay pinned at depth'
        )
        await visible(ROW_TEXT)
        for (const pill of ['All', 'Past', 'All', 'Upcoming', 'Past']) {
          await tap(pill)
          await pause(500)
          assert.ok(
            Math.abs((await pillsTop()) - pinned) <= PINNED_SLACK,
            `E5: ${pill} holds the pills`
          )
          await visible(ROW_TEXT)
          await visible('games')
        }
        // The page dragged back, and the head comes down with it.
        await m.swipe({ start: '50%, 30%', end: '50%, 80%', duration: 300 })
        await m.swipe({ start: '50%, 30%', end: '50%, 80%', duration: 300 })
        await pause(800)
        assert.ok(
          Math.abs((await pillsTop()) - atRest) <= PINNED_SLACK,
          'E5: the pills come back down at the top'
        )
      })

      await phoneNetwork(true)
      await m.stopApp({ appId: APP_ID })
      await m.launchApp({ appId: APP_ID, stopApp: true })
      await visible('Your Home', 30000)
      await onSchedule()
      await visible(ROW_TEXT, 30000)
      await pause(1500)
      await shot(`${platform}-offline-paint.png`)
      await note('E5: relaunched offline, the stored first page painted')
      await scrollDown(SWIPES_PAST_A_PAGE)
      await visible('Could not load more', 30000)
      await visible('Retry')
      await shot(`${platform}-offline-retry.png`)
      await phoneNetwork(false)
      await tap('Retry')
      await pause(2000)
      assert.ok(
        !(await shown('Could not load more', 1000)),
        'E5: Retry reads the next page'
      )
    },
    E6: async () => {
      const openTeam = async (): Promise<void> => {
        await m.openLink({
          link: `teamstation://teams/${manifest.teamId}?tab=schedule`
        })
        await visible('Stats')
        await pause(2500)
      }
      const nextControl = `schedule-rsvp-control-${manifest.nextGameId}`
      const drawn = (nodes: ViewNode[]): boolean =>
        rowsOf(nodes).some(({ ids }) => ids.includes(nextControl))
      /**
       * The next item's row starts right under the pills. That is the next
       * game, or the week's practice when one falls just before it.
       */
      const onNextGame = async (step: string): Promise<void> => {
        // Rows may yet be on their way, on a machine with much else to do.
        let nodes = await settled()
        for (let wait = 0; wait < 30 && !drawn(nodes); wait++) {
          await pause(1000)
          nodes = await settled()
        }
        assert.ok(drawn(nodes), `E6: ${step}: the next game's row is drawn`)
        const rows = rowsOf(nodes)
        const game = rows.findIndex(({ ids }) => ids.includes(nextControl))
        // The list opens on the first thing not over: a practice under way,
        // and a game played this morning after it, are no longer asking.
        const standing = (row: ScreenRow): number => row.y - pillsBottom(nodes)
        const opensOn = (at: number): boolean =>
          at > 0 &&
          standing(rows[at - 1]) >= -PINNED_SLACK * scale &&
          (rows[at - 1].words.includes('Practice') ||
            !rows[at - 1].ids.some(id =>
              id.startsWith('schedule-rsvp-control-')
            ))
        let top = game
        while (game - top < 2 && opensOn(top)) top--
        const row = rows[top]
        const under = standing(row)
        assert.ok(
          under >= -PINNED_SLACK * scale && under <= MOST_BELOW_PILLS * scale,
          `E6: ${step}: the row stands ${under} under the pills`
        )
        await note(`E6: ${step}: the row stands ${under} under the pills`)
      }
      await openTeam()
      await onNextGame('opens at the next game')
      await tapPill('Videos')
      await pause(800)
      await tapPill('Schedule')
      await pause(800)
      await onNextGame('anchors again from Videos')

      await recorded(`${platform}-team-older-rows.mp4`, async () => {
        // Drags that leave no fling, so that where a row should be is known:
        // up the page until older rows have landed above it.
        let landed = 0
        const readsAtFirst = olderReads(await phoneNetwork())
        // An Android tree holds only what is on the screen, so that a row can
        // be followed only over a shorter drag.
        const dragPoints = phone ? DRAG_POINTS / 2 : DRAG_POINTS
        for (let drag = 0; drag < 40 && landed === 0; drag++) {
          const start = await settled()
          const row = rowsOf(start).find(
            ({ y, name }) => y >= pillsBottom(start) && name != null
          )
          assert.ok(row != null, 'E6: a row under the pills')
          await gesture(dragPoints, 1200, 400)
          const end = await settled()
          const after = rowsOf(end).find(({ name }) => name === row.name)
          // An emulator now and then flings an injected drag, which says
          // nothing of a row that no read could have moved.
          const reading = olderReads(await phoneNetwork()) > readsAtFirst
          const past = dragPoints * scale + DRAG_SLACK * scale
          if (phone && !reading && (after == null || after.y - row.y > past)) {
            await note(`E6: drag ${drag}: flung, not counted`)
            continue
          }
          assert.ok(after != null, `E6: ${row.name} is still drawn`)
          const moved = after.y - row.y
          assert.ok(
            Math.abs(moved - dragPoints * scale) <= DRAG_SLACK * scale,
            `E6: ${row.name} moved ${moved} on a drag of ${dragPoints * scale}`
          )
          if (phone) landed = olderReads(await phoneNetwork()) - readsAtFirst
          else
            landed =
              contentOf(end).height - contentOf(start).height > ROWS_LANDED
                ? contentOf(end).height - contentOf(start).height
                : 0
          await note(
            `E6: drag ${drag}: the row moved ${moved}, ${landed} landed above`
          )
        }
        assert.ok(landed > 0, 'E6: older rows arrived above the reader')

        // A fling over rows already there, then one up through the place
        // where the next older page is read.
        const before = await settled()
        await gesture(-FLING_POINTS, FLING_MS, 0)
        const plain = travel(before, await settled())
        await note(`E6: a plain fling went ${plain}`)
        const reads = olderReads(await phoneNetwork())
        for (let fling = 0; fling < 12; fling++) {
          const from = await settled()
          const room = phone ? Infinity : pillsBottom(from) - contentOf(from).y
          const read = olderReads(await phoneNetwork())
          await gesture(FLING_POINTS, FLING_MS, 0)
          const to = await settled()
          const went = travel(to, from)
          const during = olderReads(await phoneNetwork()) - read
          await note(
            `E6: fling ${fling}: went ${went} of ${Math.round(room)} to the list's top, ${during} older reads`
          )
          if (during > 0) {
            assert.ok(
              went >= MOMENTUM_KEPT * Math.min(plain, room),
              `E6: a fling kept its momentum over a read: ${went} of ${plain}`
            )
            break
          }
          assert.ok(fling < 11, 'E6: no read came during a fling')
        }
        assert.ok(olderReads(await phoneNetwork()) > reads)
      })

      await recorded(`${platform}-rsvp-row-state.mp4`, async () => {
        await m.stopApp({ appId: APP_ID })
        await m.launchApp({ appId: APP_ID, stopApp: true })
        await visible('Your Home', 30000)
        await openTeam()
        // Past the rows kept drawn around the next game, so that it can leave.
        await gesture(-FLING_POINTS, FLING_MS, 0)
        const nodes = await settled()
        const control = nodes.find(
          node =>
            node.id?.startsWith('schedule-rsvp-control-') === true &&
            node.bounds != null &&
            node.bounds.y > pillsBottom(nodes) + 40 * scale &&
            node.bounds.y < 600 * scale
        )
        assert.ok(control?.bounds != null, 'E6: an RSVP on the screen')
        const { x, y, width, height } = control.bounds
        await m.tapOnPoint({
          point: `${x + Math.round(width / 2)},${y + Math.round(height / 2)}`
        })
        await pause(1200)
        await m.tapOn({ text: 'Yes for .*', index: 0, timeout: 10000 })
        await pause(800)
        await m.tapOn({ text: 'Done', timeout: 10000 })
        await pause(800)
        const rowId = control.id!
        const answer = rowsOf(await settled()).find(({ ids }) =>
          ids.includes(rowId)
        )
        assert.ok(
          answer?.ids.includes('schedule-rsvp-avatars') === true,
          'E6: the answer shows on the row'
        )
        await note(`E6: answered: ${answer.replies}`)
        await gesture(-FLING_POINTS, FLING_MS, 0)
        await gesture(-FLING_POINTS, FLING_MS, 0)
        assert.ok(
          !(await settled()).some(node => node.id === rowId),
          'E6: the answered row has left the list'
        )
        let back: ScreenRow | undefined
        // An Android fling goes further than the rows `back` looks at, so that
        // it can pass the row between one look and the next.
        for (let fling = 0; fling < 40 && back == null; fling++) {
          if (phone) await gesture(DRAG_POINTS, 1200, 400)
          else await gesture(FLING_POINTS / 2, FLING_MS, 0)
          const shown = await settled()
          back = rowsOf(shown).find(
            ({ ids, y }) => ids.includes(rowId) && y > 0 && y < 700 * scale
          )
        }
        assert.ok(back != null, 'E6: the answered row came back')
        await pause(1500)
        const again = rowsOf(await settled()).find(({ ids }) =>
          ids.includes(rowId)
        )
        assert.ok(
          again?.ids.includes('schedule-rsvp-avatars') === true,
          'E6: the answer stays'
        )
        assert.equal(again.replies, answer.replies, 'E6: the counts stay')
        await note(`E6: back again: ${again.replies}`)
      })
    },
    E7: async () => {
      await m.openLink({ link: `teamstation://seasons/${manifest.seasonId}` })
      await visible('Stats')
      await pause(1500)
      /** What the hero says, whatever is on the screen. */
      const hero = async (): Promise<string> => {
        const nodes = await all()
        const figure = (label: string): string | undefined => {
          const name = nodes.find(
            node => node.text?.toUpperCase() === label && node.bounds != null
          )?.bounds
          if (name == null) return undefined
          // The figure stands under its name, in the same column.
          return nodes.find(
            ({ text, bounds }) =>
              /^\d+$/.test(text ?? '') &&
              bounds != null &&
              bounds.y > name.y &&
              bounds.y - name.y < 60 &&
              Math.abs(bounds.x - name.x) < 60
          )?.text
        }
        return `${figure('GAMES')} games, ${figure('VIDEOS')} videos`
      }
      const counts = await hero()
      await note(`E7: the hero says ${counts}`)
      await tapPill('Schedule')
      await tap('Past')
      await pause(1000)
      for (let fling = 0; fling < 3; fling++)
        await gesture(-FLING_POINTS, FLING_MS, 0)
      await settled()
      assert.equal(await hero(), counts, 'E7: at depth')
      const rowsOnScreen = async (): Promise<number> =>
        (await all()).filter(
          node =>
            node.id === 'schedule-date' &&
            node.bounds != null &&
            node.bounds.y > 0 &&
            node.bounds.y < 800 &&
            node.bounds.x >= 0 &&
            node.bounds.x < 402
        ).length
      // The pills are in the page's flow, and scroll away with it.
      const toPills = async (): Promise<void> => {
        for (let fling = 0; fling < 12; fling++) {
          const nodes = await settled()
          const pill = nodes.find(node => node.text === 'Upcoming')?.bounds
          if (pill != null && pill.y > 120 && pill.y < 700) return
          await gesture(FLING_POINTS, FLING_MS, 0)
        }
        throw new Error('E7: the pills never came back')
      }
      await toPills()
      for (const [pill, kept] of [
        ['Upcoming', false],
        ['Past', true],
        ['All', false],
        ['Past', true],
        ['Upcoming', true]
      ] as const) {
        await toPills()
        await tap(pill)
        await pause(kept ? 100 : 1500)
        const rows = await rowsOnScreen()
        await note(`E7: ${pill}: ${rows} rows on the screen as it lands`)
        if (kept) assert.ok(rows > 0, `E7: ${pill} comes back with rows`)
        await settled()
        assert.equal(await hero(), counts, `E7: on ${pill}`)
      }
      await tapPill('Videos')
      await pause(1500)
      assert.equal(await hero(), counts, 'E7: on Videos')
      await tapPill('Schedule')
      await pause(600)
      assert.ok((await rowsOnScreen()) > 0, 'E7: Schedule comes back with rows')
      await shot(`${platform}-season-kept.png`)
    },
    E8: webOnly('E8'),
    E9: async () => {
      const ROW = 'notification-row-'
      const rowsOnShow = async (): Promise<string[]> =>
        (await all())
          .map(node => node.id ?? '')
          .filter(id => id.startsWith(ROW))
      /** Up until the mode pills stand on the screen, not just in the tree. */
      const toPills = async (): Promise<void> => {
        for (let swipe = 0; swipe < 80; swipe++) {
          const pill = (await all()).find(
            node => node.text === 'Pending' && node.bounds != null
          )?.bounds
          if (pill != null && pill.y > 90 && pill.y < 700) return
          await m.swipe({ start: '50%, 25%', end: '50%, 85%', duration: 200 })
        }
        throw new Error('E9: the mode pills never came back')
      }
      /** Down the list to its end, from the top. */
      const readDown = async (): Promise<Set<string>> => {
        await toPills()
        await pause(800)
        const seen = new Set<string>()
        for (let still = 0; still < 3;) {
          const before = seen.size
          for (const row of await rowsOnShow()) seen.add(row)
          assert.ok(!(await shown('Load more', 300)), 'E9: no Load more')
          await m.swipe({ start: '50%, 70%', end: '50%, 30%', duration: 800 })
          await pause(800)
          still = seen.size === before ? still + 1 : 0
        }
        return seen
      }
      const pagesRead = async (mode: string): Promise<number> =>
        new Set(
          (await phoneNetwork()).filter(
            url =>
              url.includes('/me/notifications?') &&
              url.includes(mode) &&
              url.includes('cursor=')
          )
        ).size

      await m.openLink({ link: 'teamstation://notifications' })
      await visible('Pending')
      await pause(1500)
      const { pendingNotices, sentNotices, reminders } = LONG_LISTS_SHAPE
      const opening = await rowsOnShow()
      assert.equal(
        opening[0],
        `${ROW}nev_long_reminder_1`,
        `E9: reminders come first, in ${opening.join(' ')}`
      )
      await tap('Dismiss')
      await pause(1200)
      assert.ok(
        !(await rowsOnShow()).includes(opening[0]),
        'E9: the dismissed row leaves'
      )
      await shot(`${platform}-notifications.png`)
      const pending = await readDown()
      assert.equal(pending.size, pendingNotices + reminders - 1, 'E9: Pending')
      assert.ok(!pending.has(opening[0]), 'E9: it stays gone')
      assert.ok((await pagesRead('')) >= 1, 'E9: Pending reads its next page')
      await note(`E9: Pending showed ${pending.size} rows by page`)

      await toPills()
      await tap('Sent')
      await pause(1200)
      const sent = await readDown()
      assert.equal(sent.size, sentNotices, 'E9: Sent')
      await note(`E9: Sent showed ${sent.size} rows`)

      await toPills()
      await tap('History')
      await pause(1200)
      const history = await readDown()
      assert.ok(history.has(opening[0]), 'E9: dismissed, it is in History')
      assert.ok(
        (await pagesRead('history=1')) >= 1,
        'E9: History reads its next page'
      )
      await shot(`${platform}-notifications-history.png`)
      await note(`E9: History showed ${history.size} rows by page`)
    },
    E10: async () => {
      const ROW = 'player-highlight-'
      await m.openLink({ link: `teamstation://players/${manifest.playerId}` })
      await visible('Player sections')
      await pause(1500)
      const seen = new Set<string>()
      for (let still = 0; still < 3;) {
        const before = seen.size
        for (const node of await settled())
          if (node.id?.startsWith(ROW) === true) seen.add(node.id)
        assert.ok(!(await shown('Show more', 300)), 'E10: no Show more')
        await m.swipe({ start: '50%, 70%', end: '50%, 30%', duration: 800 })
        await pause(800)
        still = seen.size === before ? still + 1 : 0
      }
      assert.equal(seen.size, manifest.playerHighlights, 'E10: the last one')
      const pages = new Set(
        (await phoneNetwork()).filter(
          url =>
            url.includes(`/players/${manifest.playerId}/highlights`) &&
            url.includes('before=')
        )
      )
      assert.ok(pages.size > 0, 'E10: pages read with no button')
      await shot(`${platform}-player-videos.png`)
      await note(`E10: ${seen.size} highlights over ${pages.size + 1} pages`)
    },
    E11: async () => {
      const ROW = 'game-highlight-'
      const picture = (nodes: ViewNode[]): number => {
        const found = nodes.find(node => node.id === 'event-pegged-video')
        assert.ok(found?.bounds != null, 'E11: no picture on the screen')
        return found.bounds.y
      }
      /** To the list's end from `from`, holding the picture where it pins. */
      const readDown = async (
        layout: string,
        from: string,
        to: string
      ): Promise<void> => {
        await m.swipe({ start: from, end: to, duration: 800 })
        await pause(800)
        const pinned = picture(await settled())
        const seen = new Set<string>()
        let most = 0
        for (let still = 0; still < 3;) {
          const before = seen.size
          const nodes = await settled()
          const rows = nodes.filter(node => node.id?.startsWith(ROW) === true)
          most = Math.max(most, rows.length)
          for (const row of rows) seen.add(row.id!)
          assert.ok(
            Math.abs(picture(nodes) - pinned) <= PINNED_SLACK,
            `E11: ${layout}: the picture moved from ${pinned}`
          )
          await m.swipe({ start: from, end: to, duration: 800 })
          await pause(600)
          still = seen.size === before ? still + 1 : 0
        }
        assert.equal(seen.size, LONG_LISTS_SHAPE.highlights, `E11: ${layout}`)
        await note(`E11: ${layout}: ${seen.size} rows, ${most} at once`)
      }
      /** A tap opens the full-screen player; closing it leaves the row marked. */
      const playRow = async (layout: string): Promise<void> => {
        const nodes = await settled()
        // On the screen and clear of the picture, the first in the tree being
        // any row the list holds.
        const frame = nodes.find(
          node => node.id === 'event-pegged-video'
        )!.bounds!
        const row = nodes.find(
          ({ id, bounds }) =>
            id?.startsWith(ROW) === true &&
            bounds != null &&
            bounds.y > 60 &&
            bounds.y + bounds.height < nodes[0].bounds!.height - 60 &&
            (bounds.y >= frame.y + frame.height ||
              bounds.x >= frame.x + frame.width)
        )
        assert.ok(row?.bounds != null, `E11: ${layout}: no row to tap`)
        const place = picture(nodes)
        const { x, y, width, height } = row.bounds
        await m.tapOnPoint({
          point: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
        })
        await visible('Close')
        // Pressed with the player's controls faded, it only brings them back.
        for (let press = 0; await shown('Close', 1500); press++) {
          assert.ok(press < 5, `E11: ${layout}: the player will not close`)
          await tap('Close')
          await pause(800)
        }
        assert.ok(
          Math.abs(picture(await settled()) - place) <= PINNED_SLACK,
          `E11: ${layout}: the picture stays`
        )
        await shot(`${platform}-game-highlight-${layout}.png`)
      }
      await m.openLink({
        link: `teamstation://games/${manifest.highlightsGameId}`
      })
      await visible('Game sections')
      // The section pill, in Box score's row, not the tab bar's Videos.
      const sections = await all()
      const row = sections.find(node => node.text === 'Box score')?.bounds?.y
      const pill = sections.find(
        ({ text, bounds }) =>
          text === 'Videos' &&
          bounds != null &&
          row != null &&
          Math.abs(bounds.y - row) < 20
      )
      assert.ok(pill?.bounds != null, 'E11: no Videos pill')
      await m.tapOnPoint({
        point: `${Math.round(pill.bounds.x + pill.bounds.width / 2)},${Math.round(pill.bounds.y + pill.bounds.height / 2)}`
      })
      await pause(1500)
      await readDown('page', '50%, 75%', '50%, 45%')
      await playRow('page')
      // An iPhone stands upright on every screen but the camera and the
      // full-screen sheet, so side by side is an iPad's or an Android phone's.
      if (platform === 'ios' && (await all())[0].bounds!.width < 700) {
        await note('E11: an iPhone stays upright, with no side by side')
        return
      }
      await m.setOrientation({ orientation: 'LANDSCAPE_LEFT' })
      await pause(1500)
      await readDown('beside', '85%, 75%', '85%, 25%')
      await playRow('beside')
      await m.setOrientation({ orientation: 'PORTRAIT' })
      await pause(1000)
    },
    E12: async () => {
      const ROW = 'umpire-game-'
      const STACK = 'umpire-sticky-stack'
      const gameId = manifest.umpireSignupGameId
      const noteId = `umpire-note-${gameId}-unt_long_uniform`
      const leftOf = (nodes: ViewNode[], text: string): number => {
        const heading = nodes.find(node => node.text === text)
        assert.ok(heading?.bounds != null, `E12: no heading ${text}`)
        return heading.bounds.x
      }
      const byId = (nodes: ViewNode[], id: string): ViewNode | undefined =>
        nodes.find(node => node.id === id && node.bounds != null)
      const stackBottom = (nodes: ViewNode[]): number => {
        const { y, height } = byId(nodes, STACK)!.bounds!
        return y + height
      }
      /** A pill by its name, above the tab bar's item of the same name. */
      const tapHighest = async (text: string): Promise<void> => {
        const found = (await all())
          .filter(node => node.text === text && node.bounds != null)
          .sort((one, other) => one.bounds!.y - other.bounds!.y)[0]?.bounds
        assert.ok(found != null, `E12: no ${text}`)
        await m.tapOnPoint({
          point: `${Math.round(found.x + found.width / 2)},${Math.round(found.y + found.height / 2)}`
        })
        await pause(700)
      }
      /** Whether a cell's middle lies within the game's row. */
      const onRow = (nodes: ViewNode[], node: ViewNode): boolean => {
        const row = byId(nodes, `${ROW}${gameId}`)?.bounds
        const cell = node.bounds
        if (row == null || cell == null) return false
        const middle = cell.y + cell.height / 2
        return middle > row.y && middle < row.y + row.height
      }
      /** All of a cell in the phone's width, the table scrolling sideways. */
      const onScreen = ({ x, width }: { x: number; width: number }): boolean =>
        x >= 0 && x + width <= PHONE_WIDTH
      /** The first row at or below the sticky header. */
      const readerRow = (nodes: ViewNode[]): ViewNode => {
        const bottom = stackBottom(nodes)
        const row = nodes
          .filter(node => node.id?.startsWith(ROW) === true)
          .filter(node => node.bounds != null && node.bounds.y >= bottom)
          .sort((a, b) => a.bounds!.y - b.bounds!.y)[0]
        assert.ok(row != null, 'E12: no row under the sticky header')
        return row
      }
      /** Up or down until `id` is on the screen, under the sticky header. */
      const scrollTo = async (id: string, up = false): Promise<ViewNode[]> => {
        for (let swipe = 0; swipe < SWIPES_PAST_A_PAGE * 3; swipe++) {
          const nodes = await settled()
          const found = byId(nodes, id)
          if (
            found != null &&
            found.bounds!.y >= stackBottom(nodes) &&
            found.bounds!.y < LOWEST_ROW
          )
            return nodes
          await m.swipe(
            up
              ? { start: '50%, 40%', end: '50%, 75%', duration: 600 }
              : { start: '50%, 75%', end: '50%, 40%', duration: 600 }
          )
        }
        throw new Error(`E12: never reached ${id}`)
      }
      const pagesRead = async (): Promise<string[]> =>
        (await phoneNetwork()).filter(
          url => url.includes('/umpire-schedule?') && url.includes('cursor=')
        )

      await m.openLink({
        link: `teamstation://umpires/${manifest.leagueId}`
      })
      await visible('Umpire')
      await pause(1500)
      const opened = await settled()
      const anchor = byId(opened, `${ROW}${manifest.nextGameId}`)
      assert.ok(anchor != null, "E12: opens on the rule's game")
      assert.ok(
        Math.abs(anchor.bounds!.y - stackBottom(opened)) <= PINNED_SLACK,
        `E12: the row is at ${anchor.bounds!.y}, the header ends at ${stackBottom(opened)}`
      )
      const older = (await pagesRead()).length
      await shot(`${platform}-umpire-table.png`)

      // Up past the rows the first page holds; the reader's rows stay put.
      for (let swipe = 0; swipe < SWIPES_PAST_A_PAGE; swipe++) {
        if ((await pagesRead()).length > older) break
        await m.swipe({ start: '50%, 40%', end: '50%, 75%', duration: 600 })
      }
      assert.ok((await pagesRead()).length > older, 'E12: older rows are read')
      const moving = await settled()
      const reader = readerRow(moving)
      await pause(1500)
      const landed = byId(await settled(), reader.id!)
      assert.ok(landed != null, 'E12: the reader kept their row')
      assert.ok(
        Math.abs(landed.bounds!.y - reader.bounds!.y) <= PINNED_SLACK,
        `E12: the reader's row moved from ${reader.bounds!.y} to ${landed.bounds!.y}`
      )

      // Down past the first page's end, then sideways, header and all.
      const atSignup = await scrollTo(`${ROW}${gameId}`)
      const headed = leftOf(atSignup, 'Away team')
      await m.swipe({ start: '80%, 60%', end: '30%, 60%', duration: 600 })
      const across = await settled()
      assert.ok(
        leftOf(across, 'Away team') < headed,
        'E12: the header goes with the table'
      )
      await shot(`${platform}-umpire-sideways.png`)

      // Typed, and dragged away from: the drag takes the keyboard, which saves.
      for (let swipe = 0; swipe < 6; swipe++) {
        const cell = byId(await settled(), noteId)?.bounds
        if (cell != null && onScreen(cell)) break
        await m.swipe({ start: '80%, 60%', end: '30%, 60%', duration: 600 })
      }
      await m.tapOn({ id: noteId, timeout: 15000 })
      await m.inputText({ text: 'Demo stripes' })
      await pause(600)
      await scrollDown(4)
      // The open editor's field has its own id, so go by the row.
      await scrollTo(`${ROW}${gameId}`, true)
      await visible('Demo stripes')
      await note('E12: the typed note stayed')

      // A sign-up on that row, which leaves the page where it is.
      for (let swipe = 0; swipe < 12; swipe++) {
        const nodes = await settled()
        const button = nodes.find(
          node =>
            node.text === 'Sign Up' &&
            node.bounds != null &&
            onRow(nodes, node) &&
            onScreen(node.bounds)
        )
        if (button != null) {
          const before = byId(nodes, `${ROW}${gameId}`)!.bounds!.y
          const { x, y, width, height } = button.bounds!
          await m.tapOnPoint({
            point: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
          })
          await tap('Confirm')
          await pause(1000)
          const after = byId(await settled(), `${ROW}${gameId}`)
          assert.ok(
            after != null && Math.abs(after.bounds!.y - before) <= PINNED_SLACK,
            'E12: the page stays where it is'
          )
          break
        }
        await m.swipe({ start: '30%, 60%', end: '80%, 60%', duration: 600 })
        assert.notEqual(swipe, 11, 'E12: no Sign Up on the row')
      }
      await tapHighest('Leaderboard')
      if (!(await shown('SCHEDULED AND COMPLETED GAMES', 5000))) {
        await note('E12: the Leaderboard pill took a second press')
        await tapHighest('Leaderboard')
        await visible('SCHEDULED AND COMPLETED GAMES')
      }
      await shot(`${platform}-umpire-leaderboard.png`)
      await tapHighest('Schedule')
      await scrollTo(`${ROW}${gameId}`)
      await note('E12: signed up, and the Leaderboard followed')

      // And taken off again, the same way.
      const signedUp = async (): Promise<ViewNode | undefined> => {
        const nodes = await settled()
        return nodes.find(
          node =>
            node.text?.includes(', uty_') === true &&
            node.text.startsWith('Babe R') &&
            onRow(nodes, node)
        )
      }
      let named = await signedUp()
      for (
        let swipe = 0;
        swipe < 12 && named?.bounds != null && !onScreen(named.bounds);
        swipe++
      ) {
        await m.swipe(
          named.bounds.x > 0
            ? { start: '80%, 60%', end: '45%, 60%', duration: 600 }
            : { start: '45%, 60%', end: '80%, 60%', duration: 600 }
        )
        named = await signedUp()
      }
      assert.ok(named?.bounds != null, 'E12: the sign-up shows on its row')
      assert.ok(onScreen(named.bounds), 'E12: the sign-up is on the screen')
      const { x, y, width, height } = named.bounds
      await m.tapOnPoint({
        point: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
      })
      await tap('Remove assignment')
      await pause(1000)
      const removed = await settled()
      assert.ok(
        byId(removed, `${ROW}${gameId}`) != null,
        'E12: the page stays where it is'
      )
      assert.ok(
        removed.some(node => node.text === 'Sign Up' && onRow(removed, node)),
        'E12: Sign Up is back'
      )
      await note('E12: removed')
    }
  }

  try {
    await note(
      `$ TS_LONG_LISTS_PLATFORM=${platform} TS_LONG_LISTS_CASES=${chosen.join(',')} node -r sucrase/register src/app/screens/longListsNative.e2e.ts`
    )
    await signIn()
    for (const name of chosen) {
      const run = cases[name]
      if (run == null) throw new Error(`No case ${name}`)
      await note(`${name}: start`)
      await run()
      await note(`${name}: done`)
    }
  } finally {
    await m.detach().catch(() => undefined)
    await daemon.shutdown()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
