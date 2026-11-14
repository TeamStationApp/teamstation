import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import express from 'express'
import puppeteer from 'puppeteer'

import type { ScoringAction } from '../common/scoring/actions'

/**
 * Issue #223's sentences on the production field, in headless Chrome: a
 * runner who holds short of the hit, a swing on a wild pitch, a ball a
 * fielder caught where nobody said, and a loop single. Each scenario is what
 * the model sent for its sentence — the hold missing or sent before the
 * double, a pitcher's fly sent to center — played through the real reducer
 * and `completeSentence` by `dictatedDistance.fixture.tsx`. The fixture
 * reports where each ball came down and what the play stored; the runner
 * screenshots each ball as it comes down and checks the report.
 *
 *   SCORING_ARTIFACT_DIR=… SCORING_LABEL=after \
 *     node -r sucrase/register src/test/dictatedPlacement.e2e.ts
 *
 * `SCORING_LABEL=before` captures the same screenshots and reports without
 * asserting, for the game as it was before. `SCORING_INTERPRETED=<file>`
 * plays the live interpreter's actions for these names instead (a JSON
 * array of `{ name, said, bases?, actions }`). `TS_CHROME_PATH` is the
 * browser, Google Chrome's own path when unset.
 */
/** The fixture's game: the visitors bat 1–9, the home team fields 10–18. */
const F = { P: 10, C: 11, LF: 16, CF: 17 }
const RUNNER = 6
const BATTER = 1

interface Scenario {
  name: string
  /** The screenshot's name, for the scenarios a picture proves. */
  shot?: string
  /** Photographed once the play is over, not as its ball comes down. */
  atRest?: boolean
  /** Photographed only after the change: before, the same actions scored alike. */
  afterOnly?: boolean
  said: string
  bases?: { first?: number; second?: number; third?: number }
  actions: ScoringAction[]
}
interface Point {
  x: number
  z: number
}
interface Report {
  name: string
  outs: number
  runs: number
  bases: Array<number | null>
  question: string | null
  problem: unknown
  events: Array<string | null>
  count: { balls: number; strikes: number }
  hit: {
    trajectory?: string
    coordinates?: unknown
    depth?: string
  } | null
  credits: Array<{ credit: string; player: number | null }>
  ball: {
    trajectory?: string
    depth?: string
    direction?: string
    location?: Point
  } | null
  timeline: Array<{ kind: string; at: number; landsMs: number; lands?: Point }>
}

const double: ScoringAction = { type: 'result', eventType: 'double' }
const caught: ScoringAction = {
  type: 'result',
  eventType: 'field_out',
  outBy: 'catch'
}
const holdSaid =
  'Double to left center, and the runner on second holds at third'
const toLeftCenter: ScoringAction = {
  type: 'ballInPlay',
  contact: 'swing',
  direction: 'left_center'
}
const hold: ScoringAction = { type: 'runnerMovement', runner: RUNNER, to: '3B' }

const SCENARIOS: Scenario[] = [
  {
    // As the model sent it: the double, and nothing for the runner.
    name: 'H1',
    shot: 'hold-double',
    atRest: true,
    said: holdSaid,
    bases: { second: RUNNER },
    actions: [toLeftCenter, double]
  },
  {
    name: 'H2',
    said: holdSaid,
    bases: { second: RUNNER },
    actions: [hold, toLeftCenter, double]
  },
  {
    name: 'H3',
    said: holdSaid,
    bases: { second: RUNNER },
    actions: [toLeftCenter, double, hold]
  },
  {
    name: 'W1',
    shot: 'wild-pitch-swing',
    atRest: true,
    afterOnly: true,
    said: "Wild pitch, he steals third, but the batter's swinging",
    bases: { second: RUNNER },
    actions: [
      { type: 'pitch', call: 'S' },
      {
        type: 'batteryEvent',
        kind: 'wild_pitch',
        advances: [{ runner: RUNNER, to: '3B' }]
      }
    ]
  },
  {
    // As the model sent it: caught by the pitcher, and also to center.
    name: 'F1',
    said: 'Fly out to the pitcher',
    actions: [
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'fly_ball',
        fielder: F.P,
        direction: 'center'
      },
      caught
    ]
  },
  {
    name: 'F2',
    said: 'Pop fly caught by the catcher',
    actions: [
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'popup',
        fielder: F.C,
        direction: 'center'
      },
      caught
    ]
  },
  {
    name: 'F3',
    said: 'Fly out to left center',
    actions: [
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'fly_ball',
        direction: 'left_center'
      },
      caught
    ]
  },
  {
    // As the model sent it: a line drive.
    name: 'L1',
    said: 'Loop single to center field',
    actions: [
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'line_drive',
        direction: 'center'
      },
      { type: 'result', eventType: 'single' }
    ]
  },
  {
    name: 'L2',
    said: 'Single to deep right center',
    actions: [
      {
        type: 'ballInPlay',
        contact: 'swing',
        direction: 'right_center',
        depth: 'deep'
      },
      { type: 'result', eventType: 'single' }
    ]
  }
]

/** Degrees from straight away, as `dictatedGeometry`'s SPRAY measures. */
function bearing(point: Point): number {
  return (Math.atan2(point.x, -point.z) * 180) / Math.PI
}

function check(report: Report): void {
  const ball = report.timeline.find(
    entry => entry.kind === 'hit' || entry.lands != null
  )?.lands
  const putout = report.credits.find(c => c.credit === 'f_putout')?.player
  switch (report.name) {
    case 'H1':
    case 'H2':
    case 'H3':
      assert.equal(report.runs, 0, `${report.name}: nobody scores`)
      assert.deepEqual(report.bases, [null, BATTER, RUNNER])
      assert.equal(report.question, null)
      return
    case 'W1':
      assert.deepEqual(report.count, { balls: 0, strikes: 1 })
      assert.deepEqual(report.bases, [null, null, RUNNER])
      assert.equal(report.question, null)
      assert.ok(!report.events.includes('stolen_base_3b'))
      return
    case 'F1':
      assert.ok(ball != null, 'F1: the ball is drawn')
      assert.ok(
        Math.hypot(ball.x, ball.z + 18.44) < 1,
        `F1: at the mound, not ${JSON.stringify(ball)}`
      )
      assert.equal(putout, F.P)
      return
    case 'F2':
      assert.ok(ball != null, 'F2: the ball is drawn')
      assert.ok(
        Math.abs(ball.x) < 1 && ball.z < 0 && ball.z > -8,
        `F2: just in front of the plate, not ${JSON.stringify(ball)}`
      )
      assert.equal(putout, F.C)
      return
    case 'F3':
      assert.ok(ball != null, 'F3: the ball is drawn')
      assert.ok(
        Math.abs(bearing(ball) + 15) < 1,
        `F3: in left center, not ${JSON.stringify(ball)}`
      )
      assert.equal(putout, F.CF)
      return
    case 'L1':
      // Stored as Gumbo's label.
      assert.equal(report.hit?.trajectory, 'Fly Ball')
      assert.equal(report.ball?.depth, 'bloop')
      return
    case 'L2':
      assert.equal(report.hit?.trajectory, undefined)
      return
    default:
      assert.fail(`no check for ${report.name}`)
  }
}

/**
 * Every scenario's ball where it came down, from above: the bases, the
 * mound and the plate, each landing point labelled with its scenario and
 * the trajectory stored. The field's own screenshots show the ball too small
 * to see; this is the same report, drawn.
 */
async function landingMap(
  page: Awaited<
    ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>['newPage']>
  >,
  reports: readonly Report[],
  file: string,
  label: string
): Promise<void> {
  const scale = 3.2
  const x = (point: Point): number => 400 + point.x * scale
  const y = (point: Point): number => 380 + point.z * scale
  const base = 27.432 / Math.sqrt(2)
  const diamond = [
    { x: 0, z: 0 },
    { x: base, z: -base },
    { x: 0, z: -2 * base },
    { x: -base, z: -base }
  ]
  const seen = new Map<string, number>()
  const marks = reports
    // The scenarios that place a ball; the holds and the wild pitch do not.
    .filter(report => /^[FL]/.test(report.name))
    .flatMap(report => {
      const lands = report.timeline.find(entry => entry.lands != null)?.lands
      if (lands == null) return []
      const flight = report.hit?.trajectory ?? 'no trajectory'
      // Balls that came down at one spot are labelled one under another.
      const spot = `${Math.round(lands.x)},${Math.round(lands.z)}`
      const below = 16 * (seen.get(spot) ?? 0)
      seen.set(spot, (seen.get(spot) ?? 0) + 1)
      return [
        `<circle cx="${x(lands)}" cy="${y(lands)}" r="6" fill="#d33"/>`,
        `<text x="${x(lands) + 9}" y="${y(lands) + 4 + below}" font-size="13">${report.name} ${flight} (${lands.x.toFixed(1)}, ${lands.z.toFixed(1)})</text>`
      ]
    })
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="460">
    <rect width="800" height="460" fill="#2f6b34"/>
    <path d="M400 380 L${400 - 200 * scale * Math.SQRT1_2} ${380 - 200 * scale * Math.SQRT1_2} A${200 * scale * 0.5} ${200 * scale * 0.5} 0 0 1 ${400 + 200 * scale * Math.SQRT1_2} ${380 - 200 * scale * Math.SQRT1_2} Z" fill="#3b8a43"/>
    <polygon points="${diamond.map(point => `${x(point)},${y(point)}`).join(' ')}" fill="#b98b5e"/>
    <circle cx="${x({ x: 0, z: -18.44 })}" cy="${y({ x: 0, z: -18.44 })}" r="5" fill="#e7c9a0"/>
    <text x="10" y="22" font-size="16" fill="#fff">Where each dictated ball came down — ${label}</text>
    ${marks}
  </svg>`
  await page.setViewport({ width: 800, height: 460, deviceScaleFactor: 2 })
  await page.setContent(
    `<body style="margin:0;font-family:sans-serif;color:#fff">${svg}</body>`
  )
  await page.screenshot({ path: file })
}

async function main(): Promise<void> {
  const output = process.env.SCORING_ARTIFACT_DIR
  assert(output != null, 'SCORING_ARTIFACT_DIR is required')
  const label = process.env.SCORING_LABEL ?? 'after'
  const scenarios =
    process.env.SCORING_INTERPRETED == null
      ? SCENARIOS
      : (
          JSON.parse(
            await readFile(process.env.SCORING_INTERPRETED, 'utf8')
          ) as Scenario[]
        ).map(played => ({
          ...SCENARIOS.find(scenario => scenario.name === played.name),
          ...played
        }))
  await mkdir(output, { recursive: true })
  const directory = await mkdtemp(path.join(tmpdir(), 'dictated-placement-'))
  console.log('bundling the fixture')
  const { build } = await import('esbuild')
  const { webSettings } = require('../../scripts/web-build-settings.mjs')
  await build({
    ...webSettings,
    entryPoints: ['src/test/dictatedDistance.fixture.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    outfile: path.join(directory, 'app.js'),
    define: {
      __DEV__: 'true',
      global: 'globalThis',
      'process.env': '{}',
      'process.env.NODE_ENV': '"development"',
      'process.env.TS_SENTRY_DSN': '""'
    },
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
  })
  await cp('src/app/assets/fonts', path.join(directory, 'fonts'), {
    recursive: true
  })
  const html = (await readFile('src/app/web/index.html', 'utf8')).replace(
    '</head>',
    '<style>body{overflow:hidden}#root{display:block}</style></head>'
  )
  await writeFile(path.join(directory, 'index.html'), html)
  const reports = new Map<string, Report>()
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.get('/scenarios', (_req, res) => {
    res.json(scenarios)
  })
  app.post('/timeline', (req, res) => {
    reports.set((req.body as Report).name, req.body as Report)
    res.sendStatus(204)
  })
  app.use(express.static(directory))
  const server = app.listen(0, '127.0.0.1')
  const failures: string[] = []
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined
  try {
    // Inside the try: a browser that cannot launch still closes the server.
    console.log('launching headless Chrome')
    browser = await puppeteer.launch({
      executablePath: process.env.TS_CHROME_PATH ?? '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader']
    })
    // Chrome's launch can outlast the server's start.
    if (!server.listening)
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
      })
    const address = server.address()
    assert(address != null && typeof address !== 'string')
    const page = await browser.newPage()
    await page.setViewport({ width: 402, height: 874, deviceScaleFactor: 2 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.waitForSelector(`[aria-label="Play ${scenarios[0].name}"]`, {
      timeout: 60000
    })
    // Let the field finish loading before anything is timed against it.
    await new Promise(resolve => setTimeout(resolve, 3000))
    for (const scenario of scenarios) {
      const tapped = Date.now()
      await page.click(`[aria-label="Play ${scenario.name}"]`)
      const shoot = async (): Promise<void> => {
        if (scenario.shot == null) return
        if (scenario.afterOnly === true && label === 'before') return
        await page.screenshot({
          path: path.join(
            output,
            scenario.afterOnly === true
              ? `${scenario.shot}.png`
              : `${scenario.shot}-${label}.png`
          )
        })
      }
      if (scenario.shot != null && scenario.atRest !== true) {
        // The ball's own picture, then the moment it comes down.
        const remaining = await page.evaluate(async () => {
          const now = (): number => performance.timeOrigin + performance.now()
          const until = now() + 20000
          for (;;) {
            const pictures = (
              globalThis as {
                dictatedPictures?: Array<{
                  kind: string
                  at: number
                  landsMs: number
                  lands?: unknown
                }>
              }
            ).dictatedPictures
            if (pictures === undefined) {
              await new Promise(resolve => setTimeout(resolve, 20))
              continue
            }
            const ball = pictures.find(
              entry => entry.kind === 'hit' || entry.lands != null
            )
            if (ball != null) return ball.at + ball.landsMs - now()
            if (now() > until) return 0
            await new Promise(resolve => setTimeout(resolve, 20))
          }
        })
        await new Promise(resolve =>
          setTimeout(resolve, Math.max(0, remaining) + 150)
        )
        await shoot()
      }
      await page.waitForSelector(`[aria-label="${scenario.name} — Complete"]`, {
        timeout: 60000
      })
      if (scenario.atRest === true) await shoot()
      const deadline = Date.now() + 10000
      while (!reports.has(scenario.name) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 100))
      const report = reports.get(scenario.name)
      if (report == null) {
        failures.push(`${scenario.name}: no report`)
        continue
      }
      console.log(
        `$ play ${scenario.name}: ${scenario.said}\n${JSON.stringify(
          {
            sent: scenario.actions,
            runs: report.runs,
            bases: report.bases,
            count: report.count,
            question: report.question,
            problem: report.problem,
            events: report.events,
            hit: report.hit,
            credits: report.credits,
            lands: report.timeline.find(entry => entry.lands != null)?.lands,
            ms: Date.now() - tapped
          },
          null,
          2
        )}`
      )
      if (label === 'before') continue
      try {
        check(report)
        console.log(`ok ${scenario.name}`)
      } catch (error) {
        failures.push(`${scenario.name}: ${(error as Error).message}`)
        console.log(`not ok ${scenario.name}: ${(error as Error).message}`)
      }
    }
    if (errors.length > 0) failures.push(...errors)
    await landingMap(
      page,
      [...reports.values()],
      path.join(output, `landing-map-${label}.png`),
      label
    )
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  } else console.log(`${scenarios.length} scenarios ${label}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
