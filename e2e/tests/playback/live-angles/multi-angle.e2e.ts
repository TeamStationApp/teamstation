import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  markerGeometry,
  readMarkerSource,
  unwrapMarker
} from '../../../rigs/media/readMarker'
import { untilBroadcast } from '../../../rigs/media/stackSpace'
import {
  type Box,
  GRID_VIDEOS,
  gridPath,
  liveGame,
  open,
  pause,
  type PlayerWeb,
  playerWeb,
  playerWorld,
  rectOf,
  setPlaying,
  shot,
  tapIn,
  type VideoReading,
  videoReadings
} from '../player-layouts/games'

/**
 * The live multi-angle scenarios in a browser (E6, E7): the angle switch and
 * the one-angle player on one wall clock, and live tiles 45 s behind their
 * newest footage, in step, a camera that stops waited for without seeking.
 * On the `player-layouts` world's live game V, its angles published into
 * the stack's own ingest by the fake broadcaster with the wall clock burned
 * into every frame. E5, the writer at a timestamp jump, is
 * `live-angles/writer-probe#jump`.
 */

const GEOMETRY = markerGeometry(720)

/** Every video's reading, with the wall clock burned into its picture. */
async function read(
  web: PlayerWeb,
  windowMs = 5000
): Promise<Array<VideoReading & { wall: number | null }>> {
  const now = Date.now()
  return (
    await videoReadings(web.page, readMarkerSource(), GEOMETRY, windowMs)
  ).map(one => ({
    ...one,
    wall: one.markerLow32 == null ? null : unwrapMarker(one.markerLow32, now)
  }))
}

async function playlists(ctx: HarnessContext): Promise<void> {
  const pw = await playerWorld(ctx)
  const V = await liveGame(pw)
  try {
    for (const videoId of V.videos) {
      const playback = await pw.client.playback(videoId)
      expect(playback.url, videoId).to.be.a('string')
    }
  } finally {
    await V.stop()
  }
}

async function angleSwitch(ctx: HarnessContext): Promise<void> {
  const pw = await playerWorld(ctx)
  const V = await liveGame(pw)
  try {
    const web = await playerWeb(pw, 1280, 720)
    const { page } = web
    await open(web, `/games/${V.id}?tab=watch&video=${V.videos[0]}`)
    const inline = `document.querySelector('#root video')`
    const ready = async (): Promise<void> => {
      await page.waitForFunction(
        `(() => { const v = ${inline}; return v != null && v.readyState >= 2 && !v.seeking })()`,
        { timeout: 60_000 }
      )
    }
    await ready()
    const inlineWall = async (): Promise<number | null> =>
      (await read(web)).at(-1)?.wall ?? null
    /**
     * Picks Angle 1 or Angle 2 from the strip: the game lists others too,
     * and keeps its earlier recordings of the same names before the live
     * ones, so the last of the name is the camera publishing now.
     */
    const pick = async (index: number): Promise<void> => {
      const name = `Angle ${index + 1}`
      const tab = (await page.evaluate(`(() => {
        const tab = [...document.querySelectorAll('[aria-label="Camera angles"] [role="tab"]')].findLast(tab => tab.textContent.trim().startsWith(${JSON.stringify(name)}))
        if (tab == null) return null
        const r = tab.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      })()`)) as Box | null
      if (tab == null) throw new Error(`no ${name} in the angle strip`)
      await tapIn(web, tab)
    }
    // Played, as the page's own picture is, so it joins 45 s behind the
    // newest footage, and left playing: a switch lands on the moment the
    // picture had reached when it was asked for.
    await setPlaying(web, false, true)
    await pause(3000)
    const wallNow = async (): Promise<{ wall: number | null; at: number }> => {
      const at = Date.now()
      return { wall: await inlineWall(), at }
    }
    const source = async (): Promise<string> =>
      (await page.evaluate(`${inline}.currentSrc`)) as string
    for (let turn = 0; turn < 5; turn++) {
      await ready()
      const before = await wallNow()
      const from = await source()
      const askedAt = Date.now()
      await pick((turn + 1) % 2)
      // The first picture of the other angle.
      await page.waitForFunction(
        `(() => { const v = ${inline}; return v != null && v.currentSrc !== ${JSON.stringify(from)} && v.readyState >= 2 && !v.seeking })()`,
        { timeout: 30_000 }
      )
      const landed = await wallNow()
      const playing = !((await page.evaluate(`${inline}.paused`)) as boolean)
      expect(before.wall, 'a clock before').not.equals(null)
      expect(landed.wall, 'a clock after').not.equals(null)
      const asked = before.wall! + (askedAt - before.at)
      pw.say('E6 switch', { turn, asked, landed: landed.wall, playing })
      expect(playing, `switch ${turn + 1} keeps it playing`).equals(true)
      // No earlier than the moment asked for, and no later than it plus what
      // has played since.
      expect(landed.wall! - asked, `switch ${turn + 1}`).within(
        -500,
        landed.at - askedAt + 500
      )
    }
    // Nothing moves it after it landed: it plays on with the wall clock.
    await pause(2000)
    const settled = await wallNow()
    await pause(10_000)
    const later = await wallNow()
    const reading = (await read(web, 10_000)).at(-1)!
    expect(reading.seekingPerSec, 'no re-seek after landing').equals(0)
    expect(
      Math.abs(later.wall! - settled.wall! - (later.at - settled.at)),
      'plays on in step with the wall clock'
    ).lessThan(500)
    // Held still for the one-angle player, so its opening is judged against
    // one instant.
    await setPlaying(web, false, false)
    await ready()

    // The one-angle player opens on the picture's moment, and plays on from
    // it: once it plays, its clock is no earlier than that moment and no
    // later than it plus the time since the tap.
    const atOpen = await inlineWall()
    const tapped = Date.now()
    // A first tap only reveals hidden controls (develop 44b04fbc7); whether
    // they showed is read from whether the player opened, and a second tap
    // inside the reveal opens it.
    const square = '#root [data-testid="gameVideoOpen"]'
    await tapIn(web, await rectOf(page, square))
    const opened = await page
      .waitForFunction(`(() => ${GRID_VIDEOS}.length > 0)()`, { timeout: 1000 })
      .then(
        () => true,
        () => false
      )
    if (!opened) await tapIn(web, await rectOf(page, square))
    try {
      await page.waitForFunction(
        `(() => { const v = ${GRID_VIDEOS}; return v.length === 1 && v[0].readyState >= 2 && !v[0].paused })()`,
        { timeout: 60_000 }
      )
    } catch (error) {
      pw.say(
        'E6 player never started',
        await page.evaluate(
          `(() => ${GRID_VIDEOS}.map(v => ({ t: v.currentTime, paused: v.paused, readyState: v.readyState, seekable: v.seekable.length ? [v.seekable.start(0), v.seekable.end(v.seekable.length - 1)] : null, buffered: [...Array(v.buffered.length).keys()].map(i => [v.buffered.start(i), v.buffered.end(i)]), said: [...document.querySelectorAll('div')].filter(d => d.closest('#root') == null && d.childElementCount === 0).map(d => d.textContent).filter(Boolean) })))()`
        )
      )
      throw error
    }
    const tile = (await read(web))[0]
    const readAt = Date.now()
    pw.say('E6 player opened', {
      atOpen,
      opened: tile.wall,
      after: readAt - tapped
    })
    expect(tile.wall, 'the player opens on the picture’s moment').not.equals(
      null
    )
    expect(tile.wall! - atOpen!, 'not before the moment').greaterThan(-500)
    // A tile placed by its recording's start until its stream's dates come
    // is moved to where they put the moment before it plays.
    expect(
      tile.wall! - atOpen!,
      'nor past it by more than it has played'
    ).lessThan(readAt - tapped + 500)
    await pause(3000)
    const lastTile = (await read(web))[0]
    const lastAt = Date.now()
    await web.m.pressKey({ key: 'tab' })
    const close = '[aria-label="Close"][tabindex="0"]'
    await page.waitForFunction(`document.querySelector('${close}')`)
    await tapIn(web, await rectOf(page, close))
    const closedAt = Date.now()
    await page.waitForFunction(`(() => ${GRID_VIDEOS}.length === 0)()`, {
      timeout: 30_000
    })
    await pause(5000)
    await ready()
    const back = await inlineWall()
    const readBackAt = Date.now()
    // The inline picture resumes playing. Its first moment is the one at
    // close, but this reading comes after it has had time to play again.
    const expected = lastTile.wall! + (closedAt - lastAt)
    pw.say('E6 player closed', { closedAt: expected, back })
    expect(await page.evaluate(`${inline}.paused`)).equals(false)
    expect(back! - expected, 'resumes from the player’s moment').within(
      -750,
      readBackAt - closedAt + 750
    )
  } finally {
    await V.stop()
  }
}

/** When angle 2's camera stops, seconds into its publish, and for how long. */
const STALL = { at: 300, seconds: 25 }

async function liveTiles(ctx: HarnessContext): Promise<void> {
  const pw = await playerWorld(ctx)
  // Angle 2's FFmpeg is held (SIGSTOP) on its own connection for 25 s, and
  // then let go, as the bench's camera that stopped was.
  const V = await liveGame(pw, { stalls: { 1: [STALL] } })
  try {
    const web = await playerWeb(pw, 1280, 720)
    const { page } = web
    await open(web, gridPath(V, V.videos.length))
    await page.waitForFunction(
      `(() => { const v = ${GRID_VIDEOS}; return v.length === ${V.videos.length} && v.every(one => one.readyState >= 2) })()`,
      { timeout: 90_000 }
    )
    // It starts on its own once every tile holds enough.
    await page.waitForFunction(
      `(() => ${GRID_VIDEOS}.every(one => !one.paused))()`,
      {
        timeout: 30_000
      }
    )
    await pause(1000)

    const opening = (await read(web)).slice(0, 2)
    const behind = opening.map(one =>
      one.seekableEnd == null ? null : one.seekableEnd - one.currentTime
    )
    pw.say('E7 opening', { behind, walls: opening.map(one => one.wall) })
    for (const [index, gap] of behind.entries())
      expect(gap, `tile ${index + 1} behind its newest`).closeTo(45, 3)
    expect(Math.abs(behind[0]! - behind[1]!), 'equal behind').lessThan(1)

    // A minute of reads: few seeks, clocks together.
    const offsets: number[] = []
    for (let second = 0; second < 20; second++) {
      const reads = (await read(web)).slice(0, 2)
      for (const [index, one] of reads.entries())
        expect(one.seekingPerSec, `tile ${index + 1} seeks`).lessThan(1)
      if (reads[0].wall != null && reads[1].wall != null)
        offsets.push(Math.abs(reads[0].wall - reads[1].wall))
      await pause(1000)
    }
    expect(offsets.length, 'clocks read').greaterThan(10)
    expect(Math.max(...offsets), 'clocks agree').lessThan(250)
    await shot(web, 'web-live-two-tiles-after.png')

    // Angle 2's camera stops for 25 s. Its tile plays 45 s behind with half
    // a minute in hand, so the outage is absorbed: it is never sought, and
    // angle 1 plays on. (Past the cushion a tile waits, labelled — U27; the
    // server closes a publisher silent for 30 s, so the bench cannot show
    // that and have it come back.)
    const second = V.broadcasts[1]
    if (Date.now() > second.t0 + STALL.at * 1000)
      throw new Error(
        `the reads above ran past angle 2's stop, ${STALL.at} s into its publish`
      )
    await untilBroadcast(
      pw.media,
      second.id,
      "angle 2's camera stopping",
      status => status.events.some(event => event.event === 'stall'),
      { timeoutMs: STALL.at * 1000 + 60_000 }
    )
    const states: string[] = []
    /** Angle 2's newest footage, as its player sees it, through the stop. */
    const ends: number[] = []
    for (let tick = 0; tick < STALL.seconds; tick++) {
      const [first, second2] = (await read(web, 1000)).slice(0, 2)
      if (second2.state != null) states.push(second2.state)
      if (second2.seekableEnd != null) ends.push(second2.seekableEnd)
      expect(first.paused, 'angle 1 plays on').equals(false)
      expect(second2.seekingPerSec, 'angle 2 never sought').equals(0)
      expect(second2.paused, 'angle 2 plays from what it holds').equals(false)
      await pause(1000)
    }
    pw.say('E7 angle 2 states', states)
    pw.say('E7 angle 2 newest footage', { first: ends[0], last: ends.at(-1) })
    expect(states.length).greaterThan(20)
    // The camera really stopped: its playlist grew by no more than the
    // segments already on their way.
    expect(ends.at(-1)! - ends[0], 'angle 2 stopped publishing').lessThan(10)
    // Back: it rejoins.
    await page.waitForFunction(
      `(() => { const tile = ${GRID_VIDEOS}[1].closest('[data-tile-state]'); return tile != null && tile.getAttribute('data-tile-state') === 'playing' })()`,
      { timeout: 90_000 }
    )
  } finally {
    await V.stop()
  }
}

export default defineHarness({
  id: 'playback/live-angles/multi-angle',
  title:
    'Live angles switch on one wall clock, play 45 s behind in step, and wait out a camera that stops without seeking',
  kind: 'e2e',
  covers: [
    'src/app/player/angleSwitch.ts',
    'src/app/player/liveCushion.ts',
    'src/app/player/liveStart.ts',
    'src/app/player/wallMapping.ts',
    'src/app/player/multiCam/**',
    'src/server/live/**'
  ],
  stack: 'isolated',
  fixtures: ['player-layouts'],
  exclusive: false,
  surfaces: {
    // The live angles are HEVC: Chrome for Testing on the Mac.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['video'], codecs: ['hevc'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 40,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'live-playlists': playlists,
    'angle-switch': angleSwitch,
    'live-tiles': liveTiles
  }
})
