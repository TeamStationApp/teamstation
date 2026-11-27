import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'

import type { FixtureManifest } from '../../../../src/server/dev/fixtures/accounts'
import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { stillFrames, videoSize } from '../../../core/video'
import { stackApi, stackControl } from '../../../rigs/media/stackSpace'
import {
  ChromePage,
  framesOver,
  type VideoFrames
} from '../../../rigs/playback/chrome'
import {
  type CounterReading,
  judgeCounter,
  namesAngle,
  readCounter,
  readLabel
} from '../../../rigs/playback/counter'
import {
  centre,
  chipFor,
  clockSeconds,
  type DeviceDriver,
  dragAlong,
  findExact,
  findWebView,
  flatten,
  type Found,
  knobFraction,
  pngHeight,
  pngWidth,
  sampleScreens,
  scrollToFit,
  type Shot,
  statusBarBottomOf,
  toPixels
} from '../../../rigs/playback/device'
import {
  analyzeMotion,
  CAMERA_MOTION_RULES,
  diffSeries,
  MOTION_RULES,
  type Rect,
  samplesOf
} from '../../../rigs/playback/motion'
import {
  judgeReadout,
  parseReadout,
  type Readout
} from '../../../rigs/playback/readout'
import { type RunReport, writeReport } from '../../../rigs/playback/report'
import {
  ANGLES,
  contentRect,
  counterBox,
  DURATION_SEC,
  labelBox,
  PATTERN_FPS
} from '../../../rigs/playback/testPattern'
import {
  type Content,
  judgeStep,
  STEP_RULES,
  type StepVerdict,
  type TileEvidence
} from '../../../rigs/playback/verdict'

/**
 * Playback reliability on a phone, through its real UI: real taps and real
 * drags, nothing driving the player from behind. Safari on an iPhone,
 * Chrome on an Android phone, or the app on either, each a hub phone.
 *
 * Every start — the home card, Watch, each angle, full screen and each scrub
 * landing — must move within 4 s and then play 10 s clean (`verdict.ts`).
 * A failing step is recorded, not thrown, so one hang does not hide the
 * rest: the scenario fails at its end if any step did.
 *
 * The game is the `production-shape` world's: a finished, scored game whose
 * four program angles are moving test pattern made on the stack, each
 * frame's number, the angle's name and the wall clock burned in, so a
 * frozen or repeated frame is beyond doubt. A live scenario watches the
 * world's live game instead: home's "Live now" card, and only the cameras
 * sending to it, the first `count` angles of the pattern sent live.
 */

const PLAY_MS = 10_000
const SAMPLE_MS = 400
/** How often Chrome's page is asked for the readout while a step plays. */
const READOUT_POLL_MS = 250
/** Screen fractions of the scrub track: three forward moves, three back. */
const SCRUBS = [0.25, 0.7, 0.4, 0.9, 0.1, 0.55]
/** The take's very end and start. */
const END_SCRUBS = [0.997, 0, 0.997, 0]
/** A recording's pictures a second, when the phone is filmed for a step. */
const FILM_FPS = 10
/** How long a live angle is sent for: longer than any scenario plays it. */
const LIVE_SECONDS = 3600
/** The pattern, test pattern with the real game's structure (plays, box score). */
const CONTENT: Content = 'tp+'

type Device = DeviceDriver & {
  startRecording: (options: { path: string }) => Promise<unknown>
  stopRecording: (options: { path: string }) => Promise<unknown>
  artifact: (file: string) => Promise<Uint8Array>
}

interface Options {
  count: number
  live: boolean
  /**
   * `recording` films the phone with maestro-d for every step instead of
   * taking screenshots: a screenshot makes the phone stop and copy its own
   * screen, which on a Pixel 10 knocked a tile of a four-angle grid behind
   * for good.
   */
  sampling: 'screenshots' | 'recording'
  scrubs: number[]
}

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A remux action the stack does not have yet: blocked, naming it. */
async function remux(
  ctx: HarnessContext,
  body: Record<string, unknown>
): Promise<any> {
  try {
    return await stackControl(ctx).remux(body)
  } catch (error) {
    if (String(error).includes('action is one of')) {
      throw new BlockedError(
        `the stack's remux route has no "${String(body.action)}" action: it makes no test-pattern media (a burned-in frame counter, the angle's name and the wall clock, rigs/playback/testPattern.ts patternArgs)`
      )
    }
    throw error
  }
}

/**
 * The finished game's four angles of test pattern, made on the stack at the
 * uploads' length and shape, and put under the game as its program videos.
 */
async function recordedAngles(
  ctx: HarnessContext,
  world: FixtureManifest
): Promise<void> {
  for (const label of ANGLES) {
    await remux(ctx, {
      action: 'test-pattern',
      gameId: world.ids.playedGame,
      title: label,
      label,
      startAt: world.ids.playedStartAt,
      seconds: DURATION_SEC
    })
  }
}

/** The first `count` angles of the pattern sent live to the live game, as cameras of the scorer's. */
async function liveAngles(
  ctx: HarnessContext,
  world: FixtureManifest,
  count: number
): Promise<string[]> {
  const { signInTestAccount } =
    await import('../../../../src/test/passwordFixtures')
  const api = stackApi(ctx)
  const token = await signInTestAccount(api, world.accounts.scorer)
  const sending: string[] = []
  for (const label of ANGLES.slice(0, count)) {
    const made = await fetch(
      `${api}/games/${encodeURIComponent(world.ids.liveGame)}/live-streams`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ label })
      }
    )
    expect(made.status, `a camera for ${label}`).equals(201)
    const { url } = (await made.json()) as { url: string }
    const sent = (await remux(ctx, {
      action: 'test-pattern-live',
      url,
      label,
      seconds: LIVE_SECONDS
    })) as { id: string }
    sending.push(sent.id)
  }
  return sending
}

async function playbackReliability(
  ctx: HarnessContext,
  options: Options
): Promise<void> {
  const { count, live, sampling } = options
  const browserSurface =
    ctx.surface === 'web-safari-ios' || ctx.surface === 'web-chrome-android'
  const platform =
    ctx.surface === 'web-safari-ios' || ctx.surface === 'ios-app'
      ? 'ios'
      : 'android'
  const appKind = platform === 'ios' ? 'teamstation-ios' : 'teamstation-android'
  const world = await ctx.fixture('production-shape')
  const sending = live ? await liveAngles(ctx, world, count) : []
  if (!live) await recordedAngles(ctx, world)
  const origin = ctx.stack.origin.replace(/\/+$/, '')
  const artifacts = ctx.artifact('reliability')
  mkdirSync(artifacts, { recursive: true })
  const steps: Array<StepVerdict & { evidence?: unknown }> = []
  const startedAt = new Date().toISOString()

  const device: Device = browserSurface
    ? await ctx.mobileBrowser('phone', `${origin}/?debug=1`)
    : ctx.attached('phone')
  let screenWidth = 0
  let screenHeight = 0
  /** Chrome's own page on Android, which the accessibility tree cannot be trusted for. */
  let page: ChromePage | undefined
  /** Where Chrome's page ends on the screen with its toolbar showing. */
  let contentBottom = 0
  /** The bottom of the status bar: the highest Chrome's page can start. */
  let pageTop = 0

  const tree = async (): Promise<Found[]> => {
    if (page != null) return await page.nodes(contentBottom, pageTop)
    const root = await device.hierarchy()
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
    await device.tapOn({ point: `${at.x},${at.y}` })
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
        writeFileSync(`${base}.png`, await device.screenshot())
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
    if (!browserSurface) {
      // The app has no addresses to open; home is where it starts.
      if (path !== '/') throw new Error(`the app cannot open ${path}`)
      await device.stopApp({ appId: ctx.app(appKind) })
      await device.launchApp({ appId: ctx.app(appKind) })
      await pause(5000)
      return
    }
    // The readout is remembered per tab, and a link can land in a new one.
    const url = `${origin}${path}${path.includes('?') ? '&' : '?'}debug=1`
    await device.openLink({ link: url, browser: true })
    await pause(4000)
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
    const slug = `${steps.length + 1}-${name.replace(/[^A-Za-z0-9]+/g, '-')}`
    const dir = join(artifacts, 'shots', slug)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    // Filmed: the phone's own recording runs from before the action to the
    // end of the play window.
    const filming = sampling === 'recording'
    let filmedFromMs = 0
    if (filming) {
      await device.startRecording({ path: slug })
      filmedFromMs = Date.now()
    }
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
    // Where reading the page is cheap (Chrome's page) the readout is read
    // alongside the pictures, four times a second, so a start is seen where
    // it happens and not at the next picture; where it is the system tree,
    // between batches of pictures.
    const polling =
      page == null
        ? null
        : (async () => {
            while (Date.now() < deadline) {
              await readReadout()
              await pause(READOUT_POLL_MS)
            }
          })()
    let shots: Shot[] = []
    let rounds = 0
    if (filming) {
      while (Date.now() < deadline) {
        await pause(200)
        rounds++
      }
    } else {
      while (Date.now() < deadline) {
        shots.push(
          ...(await sampleScreens(
            device,
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
    /** The filmed pictures' size over the screen's, when filmed. */
    let filmScale = 0
    if (filming) {
      const stopped = (await device.stopRecording({ path: slug })) as {
        data?: unknown
      } | null
      const video = join(dir, 'step.mp4')
      writeFileSync(
        video,
        await device.artifact(
          typeof stopped?.data === 'string' && stopped.data !== ''
            ? stopped.data
            : `recordings/${slug}.mp4`
        )
      )
      // Every picture, as the motion series runs over every file in the
      // folder; each is timed, and the start is measured from the release.
      shots = stillFrames(video, dir, FILM_FPS).map(still => ({
        file: still.file,
        atMs: filmedFromMs + Math.round(still.atSec * 1000)
      }))
      filmScale = videoSize(video).width / screenWidth
    }
    const frames =
      page != null && framesBefore != null
        ? framesOver(framesBefore, (await page.videos()) as VideoFrames[])
        : undefined
    if (shots.length === 0) throw new Error(`${name}: no pictures`)
    const scale = filming
      ? filmScale
      : pngWidth(readFileSync(shots[0].file)) / screenWidth
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
      writeFileSync(join(dir, 'nothing.png'), await device.screenshot())
      steps.push(verdict)
      return verdict
    }
    // A filmed step's pictures judge motion, as the bench camera's did; the
    // browser's own frame counts and the readout judge the playing.
    if (filming) {
      for (const region of watched) {
        region.counter = false
        region.named = false
      }
    }
    for (const region of watched) {
      const rect = toPixels(region.rect, scale)
      const diffs = await diffSeries({ pattern: join(dir, '%06d.png') }, rect)
      const motion = analyzeMotion(
        samplesOf(
          shots.map(shot => shot.atMs),
          diffs
        ),
        releaseAtMs,
        filming ? CAMERA_MOTION_RULES : MOTION_RULES
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
          seen.push(namesAngle(text, [...ANGLES]))
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
    // still be the readout from before the seek, while the last one cannot.
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
      readout:
        windowed.length >= 2
          ? judgeReadout(windowed, undefined, landing != null)
          : undefined,
      readoutStartMs,
      frames,
      // Filmed with no readout (the app), nothing can say where a scrub
      // landed: the counter is not read from a filmed step. Not judged, and
      // said so, rather than failed.
      landing:
        landing == null || (filming && gotSec == null)
          ? undefined
          : { ...landing, gotSec }
    })
    if (landing != null && filming && gotSec == null) {
      verdict.notes.push(
        'where the scrub landed was not measured (filmed, no readout)'
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
        readout: snapshots,
        rounds,
        shots: shots.length,
        videos: !verdict.pass && page != null ? await page.videos() : undefined,
        early: !verdict.pass ? early : undefined,
        pointers:
          page != null
            ? [...pointers, ...((await page.pointers()) as unknown[])]
            : undefined
      }
    })
    return verdict
  }

  /** The full-screen tiles, by their accessible names. */
  const tileRegions = async (): Promise<
    Array<{ tile: string; rect: Rect; counter: boolean }>
  > =>
    findExact(await tree(), / angle$/).map(node => ({
      tile: node.text.replace(/ angle$/, ''),
      rect: node.rect,
      counter: true
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
   * controls up together; only a later visible gesture can seek.
   */
  const callBar = async (): Promise<void> => {
    await device.tapOn({ point: await gridRow(3) })
  }

  /** A top-centre square calls the controls above the line up, the ✕ among them, and does nothing else. */
  const callControls = async (): Promise<void> => {
    await device.tapOn({ point: await gridRow(0) })
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
        await device.swipe(swipe)
        await pause(1200)
      } else {
        // Scrolled past it — the browser keeps a page's scroll across a
        // reload — the player sticks to the top and drops out of Android's
        // tree; scroll back towards the top and look again.
        await device.swipe({ start: '50%,30%', end: '50%,75%', duration: 600 })
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

  try {
    if (!browserSurface) await open('/')
    if (platform === 'android') {
      // An Android root has no bounds: the screen is the screenshot's size,
      // in the same pixels the taps are given in.
      const shot = await device.screenshot()
      screenWidth = pngWidth(shot)
      screenHeight = pngHeight(shot)
    }
    if (ctx.surface === 'web-chrome-android') {
      // Read the page from here on. Where Chrome's page ends, and where the
      // status bar does, come from the system tree, once.
      const root = await device.hierarchy()
      const web = findWebView(root)
      if (web == null) throw new Error('no Chrome page on screen')
      contentBottom = web.y + web.height
      pageTop = statusBarBottomOf(root)
      page = new ChromePage(device as never)
    }
    if (findExact(await tree(), /^E-MAIL ADDRESS$/i).length > 0) {
      await ctx.signIn('viewer', device)
    }

    const first = steps.length
    const cardLabel = live ? /^live now$/i : /^RECENT GAME$/i
    const cardButton = live ? /(^|\s)Watch live$/ : /(^|\s)Watch$/
    // The home card, then Watch, from home every time.
    await open('/')
    // The browser can bring a page back where it was last scrolled to: the
    // card and its Watch button, on screen first.
    for (let tries = 0; tries < 4; tries++) {
      const label = await waitFor(cardLabel)
      const button = await waitFor(cardButton)
      const swipe = scrollToFit(
        label.rect.y,
        button.rect.y + button.rect.h,
        screenHeight
      )
      if (swipe == null) break
      await device.swipe(swipe)
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
    // Each angle on the game page, then back to the primary one. A live
    // game has a chip for each camera sending, and none for one alone.
    const labels: string[] = [...ANGLES]
    const chips = live ? labels.slice(1, count) : labels.slice(1)
    for (const label of chips.length > 0 ? [...chips, 'Primary'] : []) {
      const target = await chip(label)
      await watch(
        `${count}: angle ${label}`,
        async () => [
          {
            tile: label,
            rect: (await waitFor('Watch full screen')).rect,
            counter: true,
            named: true
          }
        ],
        async () => {
          await tapNode(target)
        }
      )
    }
    // Full screen: the picture itself for one angle; every angle for more.
    let grid = true
    if (count === 1) {
      const player = await revealPlayer()
      await watch(`${count}: full screen`, tileRegions, async () => {
        // A tap that lands while the inline player is still answering a
        // scroll is taken as the player's own; the grid opens on a second.
        for (let tries = 0; tries < 3; tries++) {
          await tapNode(player)
          // A hidden fullscreen target reveals first. Check promptly so the
          // second touch arrives before the shared two-second expiry.
          await pause(100)
          if ((await tileRegions()).length === 0) await tapNode(player)
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
        grid = false
      } else {
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
        // Chrome's page also holds the Watch label on the page behind the
        // picker. Use the visible dialog label, not that offscreen one.
        const go =
          page == null
            ? await waitFor('Watch', 'Button')
            : findExact(await tree(), 'Watch').findLast(
                node =>
                  node.rect.y >= 0 && node.rect.y + node.rect.h <= screenHeight
              )
        if (go == null) throw new Error('no visible Watch action in the picker')
        await watch(`${count}: ${count} angles`, tileRegions, async () => {
          await tapNode(go)
          await pause(1000)
          await dismissSystemCards()
          await waitFor(/ angle$/, undefined, 3000)
        })
      }
    }
    if (grid) {
      // Real drags along the scrub bar, forward and back, each played 10 s.
      // The track and the game's length are read once: the bar hides two
      // seconds after it is called up, and reading an iPhone's screen takes
      // longer than that, so each drag follows its tap at once.
      const bar = await showBar()
      const track = bar.rect
      /**
       * Each tile above the scrub line: the line is drawn on the bottom of
       * the pictures, and its moving playhead and clock are not the picture
       * moving.
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
        .filter(
          node =>
            node.rect.x >= track.x + track.w - 1 &&
            node.rect.y < track.y + track.h &&
            node.rect.y + node.rect.h > track.y
        )
        .map(node => clockSeconds(node.text) ?? 0)[0]
      // A live game's bar runs to now, so it grows as the steps go.
      const totalReadAt = Date.now()
      const totalNow = (): number | undefined =>
        total == null
          ? undefined
          : total + (live ? (Date.now() - totalReadAt) / 1000 : 0)
      for (const [index, target] of options.scrubs.entries()) {
        await watch(
          `${count}: scrub ${index + 1} to ${Math.round(target * 100)} %`,
          pictureAboveBar,
          // Reveal immediately before the drag; a hidden drag only reveals.
          async () => {
            await callControls()
            // The reveal's pointer-up is not the drag's release. Android's
            // swipe returns early, so watch must wait for the new release.
            if (page != null) await page.pointers()
            await device.swipe(
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
    }
    // Every step of this scenario passed, or it fails with their reasons.
    const failed = steps.slice(first).filter(step => !step.pass)
    expect(
      failed.map(step => `${step.step}: ${step.reasons.join('; ')}`)
    ).deep.equals([])
  } finally {
    const report: RunReport = {
      target: ctx.surface,
      content: CONTENT,
      command: `npm run e2e -- run e2e/tests/playback/reliability/phone-playback.e2e.ts --scenario ${ctx.scenarioId} --surface ${ctx.surface}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps
    }
    writeReport(artifacts, report)
    for (const id of sending) {
      await remux(ctx, { action: 'broadcast-stop', id }).catch(() => undefined)
    }
  }
}

const recorded =
  (count: number, scrubs = SCRUBS) =>
  async (ctx: HarnessContext): Promise<void> => {
    await playbackReliability(ctx, {
      count,
      live: false,
      sampling: 'screenshots',
      scrubs
    })
  }

const liveGame =
  (count: number) =>
  async (ctx: HarnessContext): Promise<void> => {
    await playbackReliability(ctx, {
      count,
      live: true,
      sampling: 'screenshots',
      scrubs: SCRUBS
    })
  }

export default defineHarness({
  id: 'playback/reliability/phone-playback',
  title:
    'On a phone, every start of a game’s video moves within 4 s and plays 10 s clean, through every angle, the grid and six scrubs',
  kind: 'e2e',
  covers: [
    'src/app/player/**',
    'src/app/screens/HomeScreen.tsx',
    'src/app/components/GameHeroCard.tsx',
    'src/server/routes/media.ts',
    'src/server/routes/live.ts'
  ],
  stack: 'isolated',
  fixtures: ['production-shape'],
  exclusive: false,
  // A real phone's own decoders and touch are what is measured, so never a
  // simulator.
  surfaces: {
    'web-safari-ios': {
      devices: [{ role: 'phone', needs: ['ios-phone'], simulator: 'never' }]
    },
    'web-chrome-android': {
      devices: [{ role: 'phone', needs: ['android-phone'], simulator: 'never' }]
    },
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], simulator: 'never' }]
    },
    'android-app': {
      devices: [{ role: 'phone', needs: ['android-phone'], simulator: 'never' }]
    }
  },
  services: [],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 120,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'recorded-one-angle': recorded(1),
    'recorded-two-angles': recorded(2),
    'recorded-three-angles': recorded(3),
    'recorded-four-angles': recorded(4),
    // The take's very end and start, which a scrub to the edge reaches.
    'recorded-one-angle-take-ends': recorded(1, END_SCRUBS),
    // Filmed through maestro-d's recording instead of screenshots, which
    // knocked a Pixel 10's four-angle grid behind.
    'recorded-four-angles-filmed': async ctx => {
      await playbackReliability(ctx, {
        count: 4,
        live: false,
        sampling: 'recording',
        scrubs: SCRUBS
      })
    },
    'live-one-angle': liveGame(1),
    'live-two-angles': liveGame(2),
    'live-three-angles': liveGame(3),
    'live-four-angles': liveGame(4),
    'brave-on-iphone': async () => {
      throw new BlockedError(
        'Brave on an iPhone has no surface: the harness runs Safari (web-safari-ios) and Chrome (web-chrome-android) only'
      )
    },
    'real-game': async () => {
      throw new BlockedError(
        "a real game's footage is production's, which a stack does not hold: only the test pattern can run on a stack"
      )
    }
  }
})
