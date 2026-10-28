import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  ChromePage,
  framesOver,
  statusBarBottom,
  type VideoFrames
} from './chrome'
import {
  type CounterReading,
  judgeCounter,
  namesAngle,
  readCounter,
  readLabel
} from './counter'
import {
  centre,
  chipFor,
  clockSeconds,
  type DeviceDriver,
  dragAlong,
  findExact,
  flatten,
  type Found,
  type HierarchyNode,
  knobFraction,
  passwordField,
  pngWidth,
  sampleScreens,
  scrollToFit,
  type Shot,
  toPixels
} from './device'
import {
  analyzeMotion,
  CAMERA_MOTION_RULES,
  diffSeries,
  MOTION_RULES,
  type Rect,
  samplesOf
} from './motion'
import { judgeReadout, parseReadout, type Readout } from './readout'
import { type RunReport, writeReport } from './report'
import { accountFrom, passwordOf } from './session'
import { settingsFrom } from './targets'
import { contentRect, counterBox, labelBox, PATTERN_FPS } from './testPattern'
import {
  type Content,
  judgeStep,
  STEP_RULES,
  type StepVerdict,
  type TileEvidence
} from './verdict'
import {
  calibrateCamera,
  type CameraCalibration,
  captureStep,
  type Recording,
  recordWebcam
} from './webcam'

/**
 * Playback reliability on a phone, through its real UI: real taps and real
 * drags, nothing driving the player from behind. One target a run:
 *
 *   TS_TARGET=iphone-safari|iphone-brave|pixel8-chrome|pixel10-chrome \
 *   TS_DEVICE=<UDID or serial> TS_APP=https://<server> \
 *   TS_CONTENT=tp|tp+|real [TS_GAME=<gameId, for real content>] \
 *   TS_ACCOUNT_EMAIL=<e-mail> TS_ACCOUNT_ITEM=<1Password item> \
 *   [MAESTRO_D_TEAM_ID=<team, iOS>] [TS_WEBCAM_URL=<bench camera>] \
 *   [TS_ARTIFACTS=<dir>] [TS_ANGLES=1,2,3,4] [TS_LIVE=1] \
 *   MAESTRO_D_BIN=~/.maestro-d/bin/maestro-d \
 *   MAESTRO_D_CLIENT_ROOT=~/git/maestro-d/npm/maestro-d \
 *     npx mocha -r sucrase/register --extension ts --timeout 3600000 \
 *     scripts/e2e/playbackReliability/playbackReliability.e2e.ts
 *
 * Every start — the home card, Watch, each angle, full screen and each scrub
 * landing — must move within 4 s and then play 10 s clean (`verdict.ts`).
 * A failing step is reported, not thrown, so one hang does not hide the rest:
 * the scenario fails at its end if any step did.
 *
 * TS_LIVE=1 watches a game that is live: home's "Live now" card, and only the
 * cameras sending to it, which must be TS_ANGLES of them (one count a run),
 * labelled as `testPatternGame.ts live-game` labels them.
 */
const ENV = process.env
const SKIP = ENV.TS_TARGET == null || ENV.TS_TARGET === ''
const CONTENT = (ENV.TS_CONTENT ?? 'tp') as Content
const ANGLES = (ENV.TS_ANGLES ?? '1,2,3,4').split(',').map(Number)
const LIVE = ENV.TS_LIVE === '1'
/**
 * TS_SAMPLE=webcam films the phone with the bench camera for every step,
 * instead of screenshots: a screenshot makes the phone stop and copy its own
 * screen, which on a Pixel 10 knocked a tile of a four-angle grid behind for
 * good. Android only; the camera is placed on the glass through Chrome.
 */
const WEBCAM_SAMPLING = ENV.TS_SAMPLE === 'webcam'
const PLAY_MS = 10_000
const SAMPLE_MS = 400
/** How often Chrome's page is asked for the readout while a step plays. */
const READOUT_POLL_MS = 250
/**
 * Screen fractions of the scrub track: three forward moves, three back.
 * TS_SCRUBS replaces them, as for the take's very end and start
 * (`TS_SCRUBS=0.997,0,0.997,0`).
 */
const SCRUBS =
  ENV.TS_SCRUBS == null || ENV.TS_SCRUBS === ''
    ? [0.25, 0.7, 0.4, 0.9, 0.1, 0.55]
    : ENV.TS_SCRUBS.split(',').map(Number)
const LABELS = ['Primary', 'Home', '1st', '3rd']

interface Daemon {
  attach: (
    args: Record<string, unknown>
  ) => Promise<DeviceDriver & { detach: () => Promise<void> }>
}

/** Chrome's web content in the system tree. */
function findWebView(node: HierarchyNode): HierarchyNode['bounds'] | null {
  if (node.type === 'WebView' && node.bounds != null) return node.bounds
  for (const child of node.children ?? []) {
    const found = findWebView(child)
    if (found != null) return found
  }
  return null
}

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('playback reliability on a phone', function () {
  this.timeout(3_600_000)
  const settings = SKIP ? undefined : settingsFrom(ENV)
  const artifacts =
    settings?.artifacts ?? join(process.cwd(), 'reports', 'playbackReliability')
  const steps: Array<StepVerdict & { evidence?: unknown }> = []
  const startedAt = new Date().toISOString()
  let device: (DeviceDriver & { detach: () => Promise<void> }) | undefined
  let webcam: Recording | undefined
  let screenWidth = 0
  let screenHeight = 0

  /** Chrome's own page on Android, which the accessibility tree cannot be trusted for. */
  let page: ChromePage | undefined
  /** Where Chrome's page ends on the screen with its toolbar showing. */
  let contentBottom = 0
  /** The bottom of the status bar: the highest Chrome's page can start. */
  let pageTop = 0
  /**
   * Where the phone's glass is in the bench camera, and how late it is: the
   * camera box measured against `screen`, a rectangle of the phone's own
   * pixels (Chrome's page when it was measured).
   */
  let camera: { calibration: CameraCalibration; screen: Rect } | undefined
  /** A rectangle of the phone's pixels, in the camera's. */
  const cameraRect = (rect: Rect): Rect => {
    const { box } = camera!.calibration
    const { screen } = camera!
    return {
      x: box.x + ((rect.x - screen.x) / screen.w) * box.w,
      y: box.y + ((rect.y - screen.y) / screen.h) * box.h,
      w: (rect.w / screen.w) * box.w,
      h: (rect.h / screen.h) * box.h
    }
  }
  /** Chrome's media log for the whole run, saved beside the report. */
  let mediaLog: { stop: () => Promise<unknown[]> } | undefined

  const tree = async (): Promise<Found[]> => {
    if (page != null) return await page.nodes(contentBottom, pageTop)
    const root = await device!.hierarchy()
    if (screenWidth === 0) {
      screenWidth = root.bounds?.width ?? 0
      screenHeight = root.bounds?.height ?? 0
    }
    return flatten(root)
  }

  const tapNode = async (node: Found): Promise<void> => {
    const at = centre(
      node.rect,
      screenWidth > 0 ? { width: screenWidth, height: screenHeight } : undefined
    )
    await device!.tapOn({ point: `${at.x},${at.y}` })
  }

  /** The one node whose text is exactly this, waiting for it to appear. */
  const waitFor = async (
    text: string | RegExp,
    type?: string,
    timeoutMs = 15_000
  ): Promise<Found> => {
    const until = Date.now() + timeoutMs
    for (;;) {
      const nodes = await tree()
      const found = findExact(nodes, text, type)
      if (found.length > 0) return found[0]
      if (Date.now() > until) {
        // What the screen was, for whoever reads the failure.
        const base = join(artifacts, `missing-${Date.now()}`)
        writeFileSync(`${base}.png`, await device!.screenshot())
        writeFileSync(
          `${base}.txt`,
          nodes
            .map(
              node =>
                `${node.type} ${JSON.stringify(node.text)} ${JSON.stringify(node.rect)}`
            )
            .join('\n')
        )
        throw new Error(`no ${String(text)} on screen (see ${base}.png)`)
      }
      await pause(500)
    }
  }

  const open = async (path: string): Promise<void> => {
    if (settings!.target.surface === 'app') {
      // The app has no addresses to open; home is where it starts.
      if (path !== '/') throw new Error(`the app cannot open ${path}`)
      await device!.stopApp({ appId: settings!.target.appId })
      await device!.launchApp({ appId: settings!.target.appId })
      await pause(5000)
      return
    }
    // The readout is remembered per tab, and a link can land in a new one.
    const url = `${settings!.app}${path}${path.includes('?') ? '&' : '?'}debug=1`
    if (settings!.target.typesAddress) {
      const bar = (await tree()).find(
        node =>
          /address|search or enter|url/i.test(node.text) &&
          node.type.includes('TextField')
      )
      if (bar == null) throw new Error('no address bar')
      await tapNode(bar)
      await device!.inputText({ text: `${url}\n` })
    } else if (page != null) {
      await page.navigate(url)
    } else {
      await device!.openLink({
        link: url,
        browser: settings!.target.platform === 'android'
      })
    }
    await pause(4000)
  }

  /**
   * The field under a form label. iOS names a field for its placeholder;
   * Android's Chrome leaves it unnamed. Both show the label above it, so the
   * tap goes just below the label, which is inside the field on both.
   */
  const fieldUnder = async (label: RegExp): Promise<void> => {
    const above = await waitFor(label)
    await device!.tapOn({
      point: `${Math.round(above.rect.x + above.rect.h * 2)},${Math.round(above.rect.y + above.rect.h * 3)}`
    })
  }

  const signIn = async (): Promise<void> => {
    if (findExact(await tree(), /^E-MAIL ADDRESS$/i).length === 0) return
    const account = accountFrom(ENV)
    if (account.file == null) {
      // A phone's driver can keep what is typed in its own log, so only a
      // test account made for the run (TS_ACCOUNT_FILE) is ever typed; any
      // other is signed in by hand, once, before the suite runs.
      throw new Error(
        "sign the phone in first, or use a test account (TS_ACCOUNT_FILE); the suite types no one else's password"
      )
    }
    // To the password form first, while nothing covers its button: once a
    // field has the keyboard, the keyboard covers it, and on an iPhone
    // "hiding" the keyboard is its Return key, which sends the e-mail off for
    // a code instead.
    const hide = async (): Promise<void> => {
      if (settings!.target.platform === 'android')
        await device!.hideKeyboard().catch(() => undefined)
    }
    await tapNode(await waitFor('Use a password instead', 'Button'))
    await waitFor(/^PASSWORD$/i)
    await fieldUnder(/^E-MAIL ADDRESS$/i)
    await device!.inputText({ text: account.email })
    await hide()
    await fieldUnder(/^PASSWORD$/i)
    // Only into the password field, and with the daemon's artifacts off, so
    // no screenshot or log holds it.
    const label = await waitFor(/^PASSWORD$/i)
    // Focus follows the tap a moment later; give it three seconds to arrive.
    let ready = false
    for (let tries = 0; tries < 6 && !ready; tries++) {
      ready = passwordField(await device!.hierarchy(), label.rect) != null
      if (!ready) await pause(500)
    }
    if (!ready) {
      throw new Error(
        'the password field does not have the keyboard; not typing the password'
      )
    }
    await device!.inputText({ text: await passwordOf(account) })
    await hide()
    await tapNode(await waitFor('Sign in', 'Button'))
    await waitFor(/^RECENT GAME$/i, undefined, 30_000)
  }

  /** The debug readout's lines, as the screen's text shows them. */
  const readoutLines = (texts: string[]): string[] =>
    texts.filter(
      text =>
        / buf -?[0-9.]+s {2}ready /.test(text) ||
        /^clock -?[0-9.]+s /.test(text)
    )

  /**
   * Does `action`, then watches `regions` (screen points) for the start
   * budget and a play window, and records the step's verdict.
   */
  const watch = async (
    name: string,
    regions: () => Promise<
      Array<{
        tile: string
        rect: Rect
        counter: boolean
        /**
         * The picture is the one player on the page, its burned-in name
         * clear to read (a grid tile's name sits under the app's own), and it
         * must show this tile's angle.
         */
        named?: boolean
      }>
    >,
    action: () => Promise<void>,
    /** For a scrub: where on the bar's clock it should land, in seconds. */
    landing?: { wantSec: number; toleranceSec: number },
    /** The action is a touch, whose lifting the page will report. */
    expectsPointer = true
  ): Promise<StepVerdict> => {
    const dir = join(
      artifacts,
      'shots',
      `${steps.length + 1}-${name.replace(/[^A-Za-z0-9]+/g, '-')}`
    )
    rmSync(dir, { recursive: true, force: true })
    // The camera films the whole phone from before the action to the end of
    // the play window; it takes a moment to connect, so it starts first.
    const phone =
      camera == null
        ? null
        : cameraRect({ x: 0, y: 0, w: screenWidth, h: screenHeight })
    if (phone != null) {
      phone.x = Math.max(0, phone.x)
      phone.y = Math.max(0, phone.y)
      mkdirSync(dir, { recursive: true })
    }
    const filming =
      phone == null
        ? null
        : captureStep(
            settings!.webcamUrl!,
            phone,
            dir,
            Math.ceil((STEP_RULES.startBudgetMs + PLAY_MS) / 1000) + 12,
            camera!.calibration.latencyMs
          )
    if (filming != null) await pause(1500)
    // Empties (and on first use installs) the page's pointer log.
    if (page != null) await page.pointers()
    await action()
    // maestro-d's swipe on Android returns before the finger has lifted on
    // the phone: the release is when the page says so, not when the call
    // came back.
    const pointers: unknown[] = []
    if (page != null && expectsPointer) {
      const until = Date.now() + 3000
      while (Date.now() < until) {
        const seen = (await page.pointers()) as Array<[string, ...number[]]>
        pointers.push(...seen)
        if (
          seen.some(
            ([type]) => type === 'pointerup' || type === 'pointercancel'
          )
        ) {
          break
        }
        await pause(50)
      }
    }
    const releaseAtMs = Date.now()
    // The browser's own frame counts, from the release to the window's end.
    const framesBefore =
      page != null ? ((await page.videos()) as VideoFrames[]) : null
    // What each player held and could reach a moment after the release: a
    // slow start is the wait between this and the play.
    const early = page != null ? await page.videos() : undefined
    const deadline = releaseAtMs + STEP_RULES.startBudgetMs + PLAY_MS
    const snapshots: Readout[] = []
    // Stamped at the middle of the read: an iPhone's tree takes a second or
    // two to come back, and the end of that is not when it was seen.
    const readReadout = async (): Promise<void> => {
      const asked = Date.now()
      const lines = readoutLines(
        page != null ? await page.readout() : (await tree()).map(n => n.text)
      )
      const seenAt = Math.round((asked + Date.now()) / 2)
      if (lines.length > 0) snapshots.push(parseReadout(lines, seenAt))
    }
    // Where reading the page is cheap (Chrome's DevTools) the readout is read
    // alongside the screenshots, four times a second, so a start is seen
    // where it happens and not at the next picture; where it is the system
    // tree, between batches of pictures.
    const polling =
      page == null
        ? null
        : (async () => {
            while (Date.now() < deadline) {
              await readReadout()
              await pause(READOUT_POLL_MS)
            }
          })()
    // Screenshots throughout, numbered on across batches — or the camera's
    // frames, when it is filming.
    let shots: Shot[] = []
    let rounds = 0
    if (filming != null) {
      while (Date.now() < deadline) {
        await pause(200)
        rounds++
      }
    } else {
      while (Date.now() < deadline) {
        shots.push(
          ...(await sampleScreens(
            device!,
            dir,
            Math.min(deadline, Date.now() + (page != null ? PLAY_MS : 1600)),
            SAMPLE_MS,
            shots.length + 1
          ))
        )
        rounds++
        if (polling == null) await readReadout()
      }
    }
    await polling
    if (filming != null) {
      await filming.stop()
      // Every frame, as the motion series runs over every file in the
      // folder; each is timed, and the start is measured from the release.
      shots = await filming.frames()
    }
    const frames =
      page != null && framesBefore != null
        ? framesOver(framesBefore, (await page.videos()) as VideoFrames[])
        : undefined
    if (shots.length === 0) throw new Error(`${name}: no screenshots`)
    const scale = pngWidth(readFileSync(shots[0].file)) / screenWidth
    /** A region of the phone's pixels, in the pictures' own. */
    const inShot = (rect: Rect): Rect => {
      if (phone == null) return toPixels(rect, scale)
      const at = cameraRect(rect)
      return { x: at.x - phone.x, y: at.y - phone.y, w: at.w, h: at.h }
    }
    const tiles: TileEvidence[] = []
    const watched = await regions()
    if (watched.length === 0) {
      // Nothing to judge is a failure, never a pass.
      const verdict: StepVerdict = {
        step: name,
        pass: false,
        startMs: null,
        reasons: ['no picture on screen to watch'],
        notes: []
      }
      writeFileSync(join(dir, 'nothing.png'), await device!.screenshot())
      steps.push(verdict)
      console.log(`FAIL  ${name}  —  no picture on screen to watch`)
      return verdict
    }
    // The camera sees the glass at a few hundred pixels across: too few for
    // the counter's digits or the angle's name. Its frames judge motion; the
    // browser's own frame counts and the readout judge the playing.
    if (filming != null) {
      for (const region of watched) {
        region.counter = false
        region.named = false
      }
    }
    for (const region of watched) {
      const rect = inShot(region.rect)
      const diffs = await diffSeries({ pattern: join(dir, '%06d.png') }, rect)
      const motion = analyzeMotion(
        samplesOf(
          shots.map(shot => shot.atMs),
          diffs
        ),
        releaseAtMs,
        filming != null ? CAMERA_MOTION_RULES : MOTION_RULES
      )
      let counter: TileEvidence['counter']
      const readings: CounterReading[] = []
      if (region.counter && motion.startMs != null) {
        const from = releaseAtMs + motion.startMs
        const box = counterBox(contentRect(rect))
        // Each tile's crop kept beside the picture, named for the tile.
        const crop = region.tile.replace(/[^A-Za-z0-9]+/g, '-')
        for (const shot of shots.filter(
          one => one.atMs >= from && one.atMs <= from + PLAY_MS
        )) {
          readings.push({
            atMs: shot.atMs,
            frame: await readCounter(
              shot.file,
              box,
              `${shot.file}.${crop}.counter.png`
            )
          })
        }
        counter = judgeCounter(readings)
      }
      // Which angle the last pictures of the window show, by the name the
      // pattern draws on it: the tile's own name is the one it should.
      let angle: TileEvidence['angle']
      if (region.named === true && motion.startMs != null) {
        const seen: Array<string | null> = []
        for (const shot of shots.slice(-3)) {
          const text = await readLabel(
            shot.file,
            labelBox(contentRect(rect)),
            `${shot.file}.${region.tile.replace(/[^A-Za-z0-9]+/g, '-')}.label.png`
          )
          seen.push(namesAngle(text, LABELS))
        }
        angle = { want: region.tile, seen }
      }
      tiles.push({
        tile: region.tile,
        motion,
        counter,
        ...(readings.length > 0 ? { readings } : {}),
        ...(angle == null ? {} : { angle })
      })
    }
    // When the player itself first said it was playing, not held: between
    // the last read that said it was not and the first that said it was.
    const isPlaying = (snapshot: Readout): boolean =>
      snapshot.clock?.held !== true &&
      snapshot.tiles.length > 0 &&
      snapshot.tiles.every(tile => tile.playing)
    // The first reads after a release can still show the old place playing,
    // before the grid holds for the new one: the start is the first playing
    // read after the last one, early in the window, that was not.
    let lastNot = -1
    snapshots.forEach((snapshot, index) => {
      if (
        !isPlaying(snapshot) &&
        snapshot.atMs <= releaseAtMs + STEP_RULES.startBudgetMs + 2000
      ) {
        lastNot = index
      }
    })
    const firstPlaying = snapshots.findIndex(
      (snapshot, index) => index > lastNot && isPlaying(snapshot)
    )
    // The start lies between the last read that said held and the first
    // that said playing. Judged by the earlier: on an iPhone the tree takes
    // three seconds a read, and anything between would blame the player for
    // the probe's own pace. The span goes into the notes when it is wide.
    const heldUntilMs =
      firstPlaying <= 0 ? 0 : snapshots[firstPlaying - 1].atMs - releaseAtMs
    const playingByMs =
      firstPlaying < 0 ? null : snapshots[firstPlaying].atMs - releaseAtMs
    const readoutStartMs =
      snapshots.length === 0
        ? undefined
        : firstPlaying < 0
          ? null
          : Math.max(0, Math.round(heldUntilMs))
    const startMs = Math.max(
      ...tiles.map(tile => tile.motion.startMs ?? 0),
      readoutStartMs ?? 0
    )
    // Where it landed: the bar's clock at the end of the play window, less
    // the time it has played since it started. A read near the start can
    // still be the readout from before the seek — it redraws once a second,
    // and a fast seek is never seen holding — while the last one cannot, and
    // the play window has already been held to real speed.
    const last = snapshots.findLast(snapshot => snapshot.clock != null)
    // Without a readout (the app has none), the pattern's own frame number
    // says where the pictures are: its frames count the game's seconds.
    const counted = tiles
      .map(tile => tile.readings?.findLast(reading => reading.frame != null))
      .filter(
        (reading): reading is { atMs: number; frame: number } =>
          reading?.frame != null
      )
      .map(
        reading =>
          reading.frame / PATTERN_FPS -
          (reading.atMs - (releaseAtMs + startMs)) / 1000
      )
    const gotSec =
      last?.clock != null
        ? last.clock.clockSec - (last.atMs - (releaseAtMs + startMs)) / 1000
        : counted.length > 0
          ? counted.sort((a, b) => a - b)[Math.floor(counted.length / 2)]
          : null
    const windowed = snapshots.filter(
      s =>
        s.atMs >= releaseAtMs + startMs &&
        s.atMs <= releaseAtMs + startMs + PLAY_MS
    )
    const verdict = judgeStep({
      step: name,
      content: CONTENT,
      tiles,
      readout: windowed.length >= 2 ? judgeReadout(windowed) : undefined,
      readoutStartMs,
      frames,
      // Filmed by the camera with no readout (the app), nothing can say where
      // a scrub landed: the counter is too small to read there. Not judged,
      // and said so, rather than failed.
      landing:
        landing == null || (filming != null && gotSec == null)
          ? undefined
          : { ...landing, gotSec }
    })
    if (landing != null && filming != null && gotSec == null) {
      verdict.notes.push(
        'where the scrub landed was not measured (camera, no readout)'
      )
    }
    if (playingByMs != null && playingByMs - heldUntilMs > 1000) {
      verdict.notes.push(
        `the player said it was playing between ${Math.round(heldUntilMs)} and ${Math.round(playingByMs)} ms`
      )
    }
    steps.push({
      ...verdict,
      evidence: {
        tiles,
        // Every read from the release, the wait before the start with it.
        readout: snapshots,
        rounds,
        shots: shots.length,
        // What the browser's own elements held, and the pointer events it
        // was given, when a step failed.
        videos: !verdict.pass && page != null ? await page.videos() : undefined,
        early: !verdict.pass ? early : undefined,
        pointers:
          page != null
            ? [...pointers, ...((await page.pointers()) as unknown[])]
            : undefined
      }
    })
    console.log(
      `${verdict.pass ? 'pass' : 'FAIL'}  ${name}  ${verdict.startMs ?? '—'} ms  ${verdict.reasons.join('; ')}`
    )
    return verdict
  }

  /** The full-screen tiles, by their accessible names. */
  const tileRegions = async (): Promise<
    Array<{ tile: string; rect: Rect; counter: boolean }>
  > =>
    findExact(await tree(), / angle$/).map(node => ({
      tile: node.text.replace(/ angle$/, ''),
      rect: node.rect,
      counter: CONTENT !== 'real'
    }))

  /**
   * The press grid lies on the block of videos: from the top of the topmost
   * angle to the bottom of the bottommost. `row` is its row, 0 to 3, and the
   * point is that row's middle, across the screen's middle.
   */
  const gridRow = async (row: number): Promise<string> => {
    const rects = (await tileRegions()).map(region => region.rect)
    const top = Math.min(...rects.map(rect => rect.y))
    const bottom = Math.max(...rects.map(rect => rect.y + rect.h))
    const y = top + ((row + 0.5) * (bottom - top)) / 4
    return `${Math.round(screenWidth / 2)},${Math.round(y)}`
  }

  /**
   * The bottom row of the grid is the scrub line's: a tap there calls the
   * line up — on its own — and seeks to where it lands on it.
   */
  const callBar = async (): Promise<void> => {
    await device!.tapOn({ point: await gridRow(3) })
  }

  /** A top-centre square calls the controls above the line up, the ✕ among them, and does nothing else. */
  const callControls = async (): Promise<void> => {
    await device!.tapOn({ point: await gridRow(0) })
  }

  const showBar = async (): Promise<Found> => {
    await callBar()
    // The browser names the slider; Android's app tree gives a SeekBar its
    // value as text instead, so there it is found by what it is.
    const until = Date.now() + 5000
    for (;;) {
      const nodes = await tree()
      const bar =
        findExact(nodes, 'Position in the game')[0] ??
        nodes.find(node => node.type === 'SeekBar' && node.rect.w > 0)
      if (bar != null) return bar
      if (Date.now() > until)
        return await waitFor('Position in the game', undefined, 1)
      await pause(300)
    }
  }

  /** Android's own "Viewing full screen" card, which sits over the grid until dismissed. */
  const dismissSystemCards = async (): Promise<void> => {
    const card = findExact(await tree(), 'Got it')
    if (card.length > 0) await tapNode(card[0])
  }

  /** The game page's player and its angle chips, scrolled to where both show. */
  const revealPlayer = async (): Promise<Found> => {
    for (let tries = 0; tries < 5; tries++) {
      const nodes = await tree()
      const player = findExact(nodes, 'Watch full screen')[0]
      const primary = chipFor(nodes, 'Primary')
      if (player != null && primary != null) {
        const swipe = scrollToFit(
          player.rect.y,
          primary.rect.y + primary.rect.h,
          screenHeight,
          player.rect.y + player.rect.h
        )
        if (swipe == null) return player
        await device!.swipe(swipe)
        await pause(1200)
      } else {
        // Scrolled past it — the browser keeps a page's scroll across a
        // reload — the player sticks to the top and drops out of Android's
        // tree; scroll back towards the top and look again.
        await device!.swipe({ start: '50%,30%', end: '50%,75%', duration: 600 })
        await pause(1000)
      }
    }
    return await waitFor('Watch full screen')
  }

  const chip = async (label: string): Promise<Found> => {
    await revealPlayer()
    const found = chipFor(await tree(), label)
    if (found == null) throw new Error(`no ${label} chip beside Primary`)
    return found
  }

  before(async function () {
    if (SKIP) this.skip()
    mkdirSync(artifacts, { recursive: true })
    const bin = ENV.MAESTRO_D_BIN
    if (bin == null) throw new Error('MAESTRO_D_BIN is required')
    console.log(execFileSync(bin, ['ps'], { encoding: 'utf8' }))
    const require = createRequire(
      join(ENV.MAESTRO_D_CLIENT_ROOT ?? '.', 'package.json')
    )
    const { MaestroD } = require('maestro-d') as {
      MaestroD: {
        connect: (options: Record<string, unknown>) => Promise<Daemon>
      }
    }
    const daemon = await MaestroD.connect({ name: settings!.daemon, bin })
    device = await daemon.attach({
      device: settings!.device,
      platform: settings!.target.platform,
      appId: settings!.target.appId,
      artifacts: 'none',
      ...(settings!.teamId == null ? {} : { teamId: settings!.teamId })
    })
    if (settings!.webcamUrl != null) {
      webcam = recordWebcam(
        settings!.webcamUrl,
        join(artifacts, `webcam-${settings!.target.name}-${CONTENT}.mp4`),
        3600
      )
    }
    if (settings!.target.platform === 'android') {
      // A notification shade left down covers the browser, and nothing on the
      // page can then be found or tapped.
      execFileSync('adb', [
        '-s',
        settings!.device,
        'shell',
        'cmd',
        'statusbar',
        'collapse'
      ])
    }
    await open('/')
    if (
      settings!.target.platform === 'android' &&
      settings!.target.surface === 'app'
    ) {
      // An app's root has no bounds on Android: the screen is the display.
      const size = /(\d+)x(\d+)/.exec(
        execFileSync('adb', ['-s', settings!.device, 'shell', 'wm', 'size'], {
          encoding: 'utf8'
        })
      )
      if (size == null) throw new Error('no display size from adb')
      screenWidth = Number(size[1])
      screenHeight = Number(size[2])
    }
    if (
      settings!.target.platform === 'android' &&
      settings!.target.surface === 'browser'
    ) {
      // Read the page from here on. Where Chrome's page ends comes from the
      // system tree, once; its root has no bounds on Android, so the screen's
      // size comes from the display.
      const root = await device.hierarchy()
      const size = /(\d+)x(\d+)/.exec(
        execFileSync('adb', ['-s', settings!.device, 'shell', 'wm', 'size'], {
          encoding: 'utf8'
        })
      )
      if (size == null) throw new Error('no display size from adb')
      screenWidth = Number(size[1])
      screenHeight = Number(size[2])
      const web = findWebView(root)
      if (web == null) throw new Error('no Chrome page on screen')
      contentBottom = web.y + web.height
      pageTop = statusBarBottom(
        execFileSync(
          'adb',
          ['-s', settings!.device, 'shell', 'dumpsys', 'window'],
          { encoding: 'utf8', maxBuffer: 1 << 26 }
        )
      )
      page = await ChromePage.open(
        settings!.device,
        Number(ENV.TS_CDP_PORT ?? 9333)
      )
      mediaLog = await page.recordMedia()
    }
    if (WEBCAM_SAMPLING) {
      if (settings!.webcamUrl == null)
        throw new Error('TS_SAMPLE=webcam needs TS_WEBCAM_URL')
      if (settings!.target.platform !== 'android')
        throw new Error('TS_SAMPLE=webcam is Android only')
      const saved = ENV.TS_WEBCAM_CALIBRATION
      if (saved != null && existsSync(saved)) {
        camera = JSON.parse(readFileSync(saved, 'utf8')) as typeof camera
      } else if (page != null) {
        // The phone's page white and black in front of the camera: Chrome's
        // page, as many device pixels as its viewport, from its top.
        const view = await page.viewport()
        const height = view.innerHeight * view.dpr
        const top = Math.max(pageTop, contentBottom - height)
        const calibration = await calibrateCamera(
          settings!.webcamUrl,
          join(artifacts, 'calibration'),
          async color => {
            await page!.cover(color)
          }
        )
        camera = {
          calibration,
          screen: { x: 0, y: top, w: view.innerWidth * view.dpr, h: height }
        }
        if (saved != null) writeFileSync(saved, JSON.stringify(camera, null, 1))
      } else {
        throw new Error(
          'the app has no page to place the camera by: run a browser target with TS_WEBCAM_CALIBRATION first'
        )
      }
      console.log(`camera: ${JSON.stringify(camera)}`)
    }
    await signIn()
  })

  after(async function () {
    if (SKIP) return
    await webcam?.stop()
    if (mediaLog != null) {
      writeFileSync(
        join(artifacts, `media-${settings!.target.name}-${CONTENT}.json`),
        JSON.stringify(await mediaLog.stop(), null, 1)
      )
    }
    const report: RunReport = {
      target: settings!.target.name,
      content: CONTENT,
      command: `TS_TARGET=${settings!.target.name} TS_CONTENT=${CONTENT} TS_ANGLES=${ANGLES.join(',')} npx mocha … scripts/e2e/playbackReliability/playbackReliability.e2e.ts`,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps
    }
    console.log(`report: ${writeReport(artifacts, report)}`)
    await device?.detach()
  })

  for (const count of ANGLES) {
    it(`plays a ${LIVE ? 'live' : 'recorded'} game with ${count} angle${count === 1 ? '' : 's'}, through every start and six scrubs`, async function () {
      const first = steps.length
      /** Every step of this scenario passed, or the scenario fails with their reasons. */
      const expectAllPassed = (): void => {
        const failed = steps.slice(first).filter(step => !step.pass)
        expect(
          failed.map(step => `${step.step}: ${step.reasons.join('; ')}`)
        ).deep.equals([])
      }
      const cardLabel = LIVE ? /^live now$/i : /^RECENT GAME$/i
      const cardButton = LIVE ? /(^|\s)Watch live$/ : /(^|\s)Watch$/
      // The home card, then Watch, from home every time.
      await open('/')
      if (CONTENT !== 'real') {
        // The browser can bring a page back where it was last scrolled to:
        // the card and its Watch button, on screen first.
        for (let tries = 0; tries < 4; tries++) {
          const label = await waitFor(cardLabel)
          const button = await waitFor(cardButton)
          const swipe = scrollToFit(
            label.rect.y,
            button.rect.y + button.rect.h,
            screenHeight
          )
          if (swipe == null) break
          await device!.swipe(swipe)
          await pause(1000)
        }
        const card = await waitFor(cardLabel)
        const watchButton = await waitFor(cardButton)
        await watch(
          `${count}: home card`,
          async () => [
            {
              tile: 'card',
              rect: {
                x: 0,
                y: card.rect.y + card.rect.h,
                w: screenWidth,
                h: watchButton.rect.y - card.rect.y - card.rect.h
              },
              counter: false
            }
          ],
          async () => undefined,
          undefined,
          false
        )
        await watch(
          `${count}: Watch`,
          async () => [
            {
              tile: 'Primary',
              rect: (await waitFor('Watch full screen')).rect,
              counter: true,
              named: true
            }
          ],
          async () => {
            await tapNode(watchButton)
          }
        )
      } else {
        // A moment in the address opens it playing, as Watch on the home card does.
        await open(`/games/${ENV.TS_GAME ?? ''}?t=1`)
      }
      // Each angle on the game page, then back to the primary one. A live
      // game has a chip for each camera sending, and none for one alone.
      const chips = LIVE ? LABELS.slice(1, count) : LABELS.slice(1)
      for (const label of chips.length > 0 ? [...chips, 'Primary'] : []) {
        const target = await chip(label)
        await watch(
          `${count}: angle ${label}`,
          async () => [
            {
              tile: label,
              rect: (await waitFor('Watch full screen')).rect,
              counter: CONTENT !== 'real',
              named: CONTENT !== 'real'
            }
          ],
          async () => {
            await tapNode(target)
          }
        )
      }
      // Full screen: the picture itself for one angle; every angle for more.
      if (count === 1) {
        const player = await revealPlayer()
        await watch(`${count}: full screen`, tileRegions, async () => {
          // A tap that lands while the inline player is still answering a
          // scroll is taken as the player's own; the grid opens on a second.
          for (let tries = 0; tries < 3; tries++) {
            await tapNode(player)
            await pause(1000)
            await dismissSystemCards()
            const opened = await waitFor(/ angle$/, undefined, 3000).then(
              () => true,
              () => false
            )
            if (opened) break
          }
          // The grid's tiles, before anything is measured.
          await waitFor(/ angle$/, undefined, 2000)
        })
      } else {
        await tapNode(await chip('All angles'))
        await pause(1500)
        const refused = findExact(
          await tree(),
          /Multi-camera viewing is unavailable in this browser/
        )
        if (refused.length > 0) {
          steps.push({
            step: `${count}: ${count} angles`,
            pass: true,
            startMs: null,
            reasons: [],
            notes: ['this browser offers no multi-camera view (expected)']
          })
          await tapNode(await waitFor('OK'))
          expectAllPassed()
          return
        }
        // The picker starts with every angle on: keep the first `count`.
        await waitFor(/^Choose up to four angles$/)
        const switches = (await tree())
          .filter(
            node =>
              node.type.toLowerCase() === 'switch' &&
              node.rect.w > 0 &&
              node.rect.h > 0
          )
          .sort((a, b) => a.rect.y - b.rect.y)
        for (const extra of switches.slice(count)) {
          await tapNode(extra)
          await pause(300)
        }
        const go = await waitFor('Watch')
        await watch(`${count}: ${count} angles`, tileRegions, async () => {
          await tapNode(go)
          await pause(1000)
          await dismissSystemCards()
          await waitFor(/ angle$/, undefined, 3000)
        })
      }
      // Six real drags along the scrub bar, forward and back, each played
      // 10 s. The track and the game's length are read once: the bar hides
      // three seconds after it is called up, and reading an iPhone's screen
      // takes longer than that, so each drag follows its tap at once.
      const bar = await showBar()
      const track = bar.rect
      /**
       * Each tile above the scrub line: the line is drawn on the bottom of
       * the pictures, and its moving playhead and clock are not the
       * picture moving.
       */
      const pictureAboveBar = async (): Promise<
        Awaited<ReturnType<typeof tileRegions>>
      > =>
        (await tileRegions()).map(region => ({
          ...region,
          rect: {
            ...region.rect,
            h: Math.max(
              1,
              Math.min(region.rect.h, track.y - track.h - region.rect.y)
            )
          }
        }))
      const firstNodes = await tree()
      let from = knobFraction(firstNodes, track) ?? 0
      const total = findExact(firstNodes, /^\d+(:\d\d){1,2}$/)
        .filter(node => node.rect.x >= track.x + track.w - 1)
        .map(node => clockSeconds(node.text) ?? 0)[0]
      // A live game's bar runs to now, so it grows as the steps go.
      const totalReadAt = Date.now()
      const totalNow = (): number | undefined =>
        total == null
          ? undefined
          : total + (LIVE ? (Date.now() - totalReadAt) / 1000 : 0)
      for (const [index, target] of SCRUBS.entries()) {
        await watch(
          `${count}: scrub ${index + 1} to ${Math.round(target * 100)} %`,
          pictureAboveBar,
          // A drag along the bottom row is the scrub, wherever the line is
          // showing: the bar is drawn on that row.
          async () => {
            await device!.swipe(
              dragAlong(track, from, target, {
                width: screenWidth,
                height: screenHeight
              })
            )
          },
          total == null
            ? undefined
            : {
                wantSec: target * (totalNow() ?? total),
                toleranceSec: Math.max(60, (totalNow() ?? total) * 0.02)
              }
        )
        from = target
      }
      await callControls()
      await tapNode(await waitFor('Close'))
      expectAllPassed()
    })
  }
})
