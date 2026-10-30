// The stats tables on a reserved iPhone, in the app and in Safari:
// every table wide enough to scroll sideways keeps its names while the
// figures scroll, the box score totals its batting and pitching, the replay's
// line score scrolls under its team names, and a player's stats are tables.
//
// Run against `statsTablesSeed.ts`'s fixture, whose printed JSON is
// TEST_SEED, and the worktree's server and web build:
//
//   MAESTRO_D=statsTablesTotals MAESTRO_D_CLIENT_ROOT=~/git/maestro-d \
//   TEST_DEVICE=<udid> TEST_APP_ID=app.teamstation.app|com.apple.mobilesafari \
//   TEST_URL=http://<lan>:8170 TEST_SEED=<seed.json> TEST_TOKEN=<token> \
//   TEST_ARTIFACT_DIR=<dir> [TEST_SECTION=team|season|box|coach|replay|player|filter|empty] \
//   [TEST_TEAM_ID=<the Apple team that signs WebDriverAgent on a real iPhone>] \
//   [TEST_CAPTURE_ONLY=1] [TEST_SHOT_SUFFIX=before|after] \
//   node -r sucrase/register src/app/screens/statsTables.e2e.ts
//
// TEST_CAPTURE_ONLY=1 walks the same routes and swipes and takes the same
// screenshots, and checks nothing: the before pictures, on a build that does
// not have the tables yet.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Node {
  text?: string
  type?: string
  bounds?: Bounds
  children?: Node[]
}
interface Device {
  openLink: (args: { link: string }) => Promise<unknown>
  acceptAlert: () => Promise<unknown>
  assertVisible: (args: { text: string; timeout: number }) => Promise<unknown>
  tapOn: (args: { text: string; index?: string }) => Promise<unknown>
  swipe: (args: {
    startX: number
    startY: number
    endX: number
    endY: number
    duration: number
  }) => Promise<unknown>
  hierarchy: () => Promise<Node>
  screenshot: () => Promise<Buffer>
  stopApp: (args: { appId: string }) => Promise<unknown>
  launchApp: (args: { appId: string }) => Promise<unknown>
}
interface Daemon {
  attach: (args: {
    device: string
    platform: string
    appId: string
    teamId?: string
  }) => Promise<Device>
  close: () => void
}
interface Seed {
  playerId: string
  teams: { hawksSpring: string }
  boxScoreGame: string
  coachTeam: string
  nineInnings: string
}

const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
const load = createRequire(
  join(resolve(required('MAESTRO_D_CLIENT_ROOT')), 'package.json')
)
const { MaestroD } = load('maestro-d') as {
  MaestroD: {
    connect: (args: { name: string; spawn: boolean }) => Promise<Daemon>
  }
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

/** The replay seed's teams and season, which the box score and team use. */
const PINES = 'tem_replayPines'
const REPLAY_SEASON = 'sea_replaySeedSeason'

async function main(): Promise<void> {
  const device = required('TEST_DEVICE')
  const appId = required('TEST_APP_ID')
  const native = appId !== 'com.apple.mobilesafari'
  const surface = native ? 'native' : 'safari'
  const captureOnly = process.env.TEST_CAPTURE_ONLY === '1'
  const suffix = process.env.TEST_SHOT_SUFFIX ?? 'after'
  const section = process.env.TEST_SECTION
  const seed = JSON.parse(readFileSync(required('TEST_SEED'), 'utf8')) as Seed
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  })
  try {
    const m = await daemon.attach({
      device,
      platform: 'ios',
      appId,
      teamId: process.env.TEST_TEAM_ID
    })
    const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
    const screen = (await nodes()).find(n => n.type === 'Application')?.bounds
    const width = screen?.width ?? 390
    const height = screen?.height ?? 844

    /** Checks, unless this run only takes the before pictures. */
    const check = (ok: boolean, message: string): void => {
      if (!captureOnly) assert(ok, message)
    }
    const find = async (
      text: string,
      last = false
    ): Promise<Node | undefined> =>
      (await nodes())[last ? 'findLast' : 'find'](
        n =>
          n.text === text &&
          n.bounds != null &&
          n.bounds.x >= 0 &&
          n.bounds.x + n.bounds.width <= width &&
          n.bounds.y > 80 &&
          n.bounds.y + n.bounds.height < height - 40
      )
    const shot = async (name: string): Promise<void> => {
      writeFileSync(
        join(required('TEST_ARTIFACT_DIR'), `${surface}-${name}-${suffix}.png`),
        await m.screenshot()
      )
      console.log(`${surface}: captured ${name}-${suffix}`)
    }
    const open = async (route: string, text: string): Promise<void> => {
      await m.openLink({
        link: (native ? 'teamstation://' : required('TEST_URL')) + route
      })
      if (
        native &&
        (await nodes()).some(n => n.type === 'Alert' || n.text === 'Open')
      )
        await m.acceptAlert()
      await m.assertVisible({ text, timeout: 20000 })
    }
    /** Scrolls the page down, then back up, until `text` is on screen. */
    const reach = async (text: string, last = false): Promise<Node> => {
      for (const down of [true, false])
        for (let i = 0; i < 8; i++) {
          const node = await find(text, last)
          if (node != null) return node
          await m.swipe({
            startX: Math.round(width * 0.1),
            startY: down ? height - 240 : 220,
            endX: Math.round(width * 0.1),
            endY: down ? 220 : height - 240,
            duration: 450
          })
        }
      throw new Error(`Could not scroll to ${text}`)
    }
    /**
     * Swipes the table whose rows include `name` right to left, along that
     * row, until `last` is on screen; then the name must still be at the
     * left of the screen.
     */
    const sideways = async (
      name: string,
      last: string,
      lastRow = false
    ): Promise<void> => {
      const row = await reach(name, lastRow)
      const y = row.bounds!.y + row.bounds!.height / 2
      for (let i = 0; i < 10 && (await find(last, lastRow)) == null; i++)
        await m.swipe({
          startX: Math.round(width * 0.8),
          startY: y,
          endX: Math.round(width * 0.4),
          endY: y,
          duration: 400
        })
      const after = await find(name, lastRow)
      check((await find(last, lastRow)) != null, `${last} scrolled into view`)
      check(
        after?.bounds != null && after.bounds.x < width * 0.3,
        `${name} stays at the left while ${last} shows`
      )
    }

    // Signed in as the seed's reader, on this surface's own token.
    if (native) {
      await m.stopApp({ appId })
      await m.launchApp({ appId })
      // A link that arrives before the app is ready to take it is dropped.
      await new Promise(resolve => setTimeout(resolve, 6000))
    }
    await m.openLink({
      link:
        (native ? 'teamstation://' : required('TEST_URL')) +
        `/signin/${required('TEST_TOKEN')}`
    })
    if (
      native &&
      (await nodes()).some(n => n.type === 'Alert' || n.text === 'Open')
    )
      await m.acceptAlert()
    await new Promise(resolve => setTimeout(resolve, 4000))

    const run = (name: string): boolean => section == null || section === name

    if (run('team')) {
      await open(`/teams/${PINES}?tab=stats`, 'Batting')
      await sideways('Open Mookie B', 'PIK')
      await shot('team-batting-scrolled')
      // He bats as well: on a short phone his batting row is on screen here.
      await reach('IP')
      // Clear of the browser's bars, so the row below the head is the pitcher's.
      await m.swipe({
        startX: Math.round(width * 0.1),
        startY: height - 240,
        endX: Math.round(width * 0.1),
        endY: 220,
        duration: 450
      })
      await sideways('Open Tyler G', 'BAA', true)
      // A name opens the player.
      const name = await reach('Open Tyler G', true)
      await m.tapOn({ text: name.text! })
      if (!captureOnly)
        await m.assertVisible({ text: '.*Filter.*', timeout: 10000 })
      console.log(`${surface}: team tables passed`)
    }

    if (run('season')) {
      await open(`/seasons/${REPLAY_SEASON}?tab=stats`, '.*BATTING.*')
      await sideways('Open Juan S', 'PIK')
      await shot('season-batting-scrolled')
      console.log(`${surface}: season tables passed`)
    }

    if (run('box')) {
      await open(`/games/${seed.boxScoreGame}?tab=boxScore`, '.*Batting.*')
      await shot('box-score')
      await sideways('Juan S', 'AVG')
      await shot('box-score-scrolled')
      const totals = (await nodes()).filter(n => n.text === 'Totals')
      check(totals.length >= 2, 'Totals rows under batting and pitching')
      // Every table's own Totals, on screen, clear of the bars, read by the
      // figure only that table's row has: down the page a step at a time.
      await open(`/games/${seed.boxScoreGame}?tab=boxScore`, '.*Batting.*')
      const bottom = native ? height - 110 : height - 190
      const tables = new Map([
        ['.333', 'box-valley-pines-batting-totals'],
        ['3.0', 'box-valley-pines-pitching-totals'],
        ['.200', 'box-harbor-hawks-batting-totals'],
        ['2.0', 'box-harbor-hawks-pitching-totals']
      ])
      const captured = new Set<string>()
      for (let i = 0; i < 16 && captured.size < tables.size; i++) {
        await new Promise(resolve => setTimeout(resolve, 900))
        const all = await nodes()
        for (const row of all) {
          if (row.text !== 'Totals' || row.bounds == null) continue
          if (row.bounds.y < 200) continue
          if (row.bounds.y + row.bounds.height >= bottom) continue
          const middle = row.bounds.y + row.bounds.height / 2
          // The row's figures, labelled for a screen reader in the app and
          // plain in a browser.
          const figures = all.flatMap(cell =>
            cell.bounds != null &&
            cell.text != null &&
            Math.abs(cell.bounds.y + cell.bounds.height / 2 - middle) < 8
              ? [cell.text.split(', ').at(-1) ?? '']
              : []
          )
          for (const [figure, name] of tables)
            if (figures.includes(figure) && !captured.has(name)) {
              captured.add(name)
              await shot(name)
            }
        }
        await m.swipe({
          startX: Math.round(width * 0.1),
          startY: Math.round(height * 0.7),
          endX: Math.round(width * 0.1),
          endY: Math.round(height * 0.45),
          // Slower than this, Safari takes it for a press and selects text.
          duration: native ? 900 : 400
        })
      }
      check(
        captured.size === tables.size,
        `Each table's Totals on screen: ${[...captured].join(', ')}`
      )
      // Its own frozen name opens the player, clear of the pinned pills.
      const name = await reach('Mookie B')
      if (name.bounds!.y < 240)
        await m.swipe({
          startX: Math.round(width * 0.1),
          startY: 300,
          endX: Math.round(width * 0.1),
          endY: 520,
          // Slower than this, Safari takes it for a press and selects text.
          duration: native ? 900 : 400
        })
      await new Promise(resolve => setTimeout(resolve, 900))
      await m.tapOn({ text: 'Mookie B' })
      if (!captureOnly)
        await m.assertVisible({ text: '.*Filter.*', timeout: 10000 })
      console.log(`${surface}: box score passed`)
    }

    if (run('coach') && native) {
      await open(
        `/games/${seed.boxScoreGame}/coach/${seed.coachTeam}`,
        '.*Box.*'
      )
      await m.tapOn({ text: 'Box' })
      await m.assertVisible({ text: '.*Batting.*', timeout: 20000 })
      await sideways('Mookie B', 'AVG')
      await shot('coach-box-score-scrolled')
      console.log(`${surface}: coach game passed`)
    }

    if (run('replay')) {
      await open(`/games/${seed.nineInnings}/replay`, 'R')
      // The field draws after the deck, and moves the line score as it does.
      await new Promise(resolve => setTimeout(resolve, 8000))
      // It opens on the inning being played and R, H and E.
      check((await find('E')) != null, 'the line score opens at its end')
      // The deck moves as the play card under the field changes, so the
      // line score's row is found again before every swipe.
      for (let i = 0; i < 6 && (await find('E')) == null; i++) {
        const head = await find('Harbor Hawks')
        assert(head?.bounds != null, 'line score on screen')
        const y = head.bounds.y + head.bounds.height / 2
        await m.swipe({
          startX: Math.round(width * 0.8),
          startY: y,
          endX: Math.round(width * 0.4),
          endY: y,
          duration: 400
        })
      }
      await shot('replay-line-score')
      // Under the head row, not a row high beside it.
      const headRow = await find('E')
      const firstName = await find('Harbor Hawks')
      check(
        (firstName?.bounds?.y ?? 0) >=
          (headRow?.bounds?.y ?? 0) + (headRow?.bounds?.height ?? 0) - 2,
        'team names level with their figures'
      )
      check((await find('E')) != null, 'R/H/E scrolled into view')
      check(
        ((await find('Harbor Hawks'))?.bounds?.x ?? width) < width * 0.3,
        'team names stay at the left'
      )
      // Down the deck to the batting's Totals, and back.
      const deckBottom = height - (native ? 70 : 150)
      const deckSwipe = async (up: boolean): Promise<void> => {
        await m.swipe({
          startX: Math.round(width * 0.5),
          startY: up ? deckBottom : deckBottom - 130,
          endX: Math.round(width * 0.5),
          endY: up ? deckBottom - 130 : deckBottom,
          duration: 400
        })
        await new Promise(resolve => setTimeout(resolve, 700))
      }
      let steps = 0
      while (steps < 10 && (await find('Totals')) == null) {
        await deckSwipe(true)
        steps++
      }
      check(
        (await find('Totals')) != null,
        'the replay ends batting with Totals'
      )
      await shot('replay-batting-totals')
      for (; steps > 0; steps--) await deckSwipe(false)
      // A name in the deck opens the player.
      await reach('Open Juan S')
      await m.tapOn({ text: 'Open Juan S' })
      if (!captureOnly)
        await m.assertVisible({ text: '.*Filter.*', timeout: 10000 })
      console.log(`${surface}: replay line score passed`)
    }

    if (run('player')) {
      await open(`/players/${seed.playerId}?tab=stats`, '.*Career.*')
      await shot('player-career')
      check((await find('Total')) != null, 'Total row')
      const labels = ['Hawks · Spring 2026', 'Ravens', 'Hawks · Fall 2025']
      const found = await Promise.all(
        labels.map(async label => await find(label))
      )
      check(
        found.every(node => node != null) &&
          found.every(
            (node, index) =>
              index === 0 || node.bounds!.y > found[index - 1].bounds!.y
          ),
        'team rows newest first'
      )
      await sideways('Ravens', 'PIK')
      console.log(`${surface}: player career passed`)
    }

    if (run('filter')) {
      await open(
        `/players/${seed.playerId}?tab=stats&team=${seed.teams.hawksSpring}`,
        '.*Hawks.*'
      )
      check(
        (await nodes()).some(n =>
          /^May 23 (vs Ravens|@ Owls)$/.test(n.text ?? '')
        ),
        'game rows with vs and @'
      )
      for (const choice of ['Fall 2025', '2025']) {
        await m.tapOn({ text: 'Filter stats' })
        await m.tapOn({ text: choice })
        await m.tapOn({ text: 'Show these' })
        await new Promise(resolve => setTimeout(resolve, 1500))
        await shot(`player-filter-${choice.replace(' ', '-').toLowerCase()}`)
        check(
          (await nodes()).some(n => / · (Hawks|Ravens)$/.test(n.text ?? '')),
          `${choice}: game rows name their team`
        )
      }
      console.log(`${surface}: player filters passed`)
    }

    if (run('empty')) {
      await open(`/players/${seed.playerId}?tab=stats`, '.*Career.*')
      await m.tapOn({ text: 'Filter stats' })
      await m.tapOn({ text: 'Summer 2024' })
      await m.tapOn({ text: 'Show these' })
      await m.assertVisible({ text: '.*Show every game.*', timeout: 10000 })
      check((await find('Total')) == null, 'no table under an empty filter')
      console.log(`${surface}: empty filter passed`)
    }
  } finally {
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
