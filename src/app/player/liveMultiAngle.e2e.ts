import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import {
  API,
  finish,
  fixture,
  GRID_VIDEOS,
  open,
  pause,
  print,
  shot,
  signedIn,
  type VideoReading,
  videoReadings,
  type WebSession,
  webSession
} from './playerLayoutsRig.e2e'

/**
 * The live multi-angle scenarios in a browser (E6, E7): the angle switch and
 * the one-angle player on one wall clock, and live tiles 45 s behind their
 * newest footage, in step, a camera that stops waited for without seeking.
 * On the fixture's live game V, whose angles publish for twenty minutes after
 * the fixture starts them (`fixture.ts --start-live`). E5, the writer at a
 * timestamp jump, is `scripts/e2e/playerLayouts/liveProbe.ts --jump`.
 *
 *   (the environment of playerLayouts.e2e.ts) \
 *     npx mocha -r sucrase/register --extension ts --timeout 900000 \
 *     src/app/player/liveMultiAngle.e2e.ts
 */
const marker = createRequire(__filename)(
  '../../../scripts/e2e/scoreboardLog/readMarker.ts'
) as {
  markerGeometry: (height: number) => unknown
  readMarkerSource: () => string
  unwrapMarker: (low32: number, nearMs: number) => number
}
const GEOMETRY = marker.markerGeometry(720)

/** Every video's reading, with the wall clock burned into its picture. */
async function read(
  session: WebSession,
  windowMs = 5000
): Promise<Array<VideoReading & { wall: number | null }>> {
  const now = Date.now()
  return (
    await videoReadings(session, marker.readMarkerSource(), GEOMETRY, windowMs)
  ).map(one => ({
    ...one,
    wall:
      one.markerLow32 == null ? null : marker.unwrapMarker(one.markerLow32, now)
  }))
}

/**
 * The FFmpeg publishing a live angle, to stop and start it: the one sending
 * to its stream's address, not the server's own writer reading from it.
 */
function publisherOf(index: number): number {
  const url = fixture().live[index].url
  const lines = execFileSync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8'
  }).split('\n')
  // FFmpeg itself: the fake broadcaster that started it names the address
  // too, and stopping that stops nothing.
  const sending = lines.find(line => {
    const program = line.trim().split(/\s+/)[1] ?? ''
    return (
      program.endsWith('/ffmpeg') &&
      line.includes(url) &&
      !line.includes(`-i ${url}`)
    )
  })
  if (sending == null) throw new Error(`angle ${index + 1} is not live`)
  return Number(sending.trim().split(/\s+/)[0])
}

describe('live multi-angle in a browser', function () {
  after(async function () {
    await finish()
  })

  it("lists the live game's two angles with playlists", async function () {
    const V = fixture().games.V
    const client = new TeamStationClient({
      baseUrl: API,
      token: await signedIn()
    })
    for (const videoId of V.videos) {
      const playback = await client.playback(videoId)
      expect(playback.url, videoId).to.be.a('string')
    }
  })

  it('switches angles on the same burned-in moment, and opens and closes the one-angle player there (E6)', async function () {
    const V = fixture().games.V
    const session = await webSession('e6', 1280, 720)
    // The grid's own readout, for a failure to say what it was waiting for.
    if (process.env.TS_PLAYER_GRID_DEBUG === '1')
      await session.page.evaluateOnNewDocument(`(() => {
        const get = URLSearchParams.prototype.get
        URLSearchParams.prototype.get = function (name) { return name === 'debug' ? '1' : get.call(this, name) }
      })()`)
    await open(session, `/games/${V.id}?tab=watch&video=${V.videos[0]}`)
    const inline = `document.querySelector('#root video')`
    const ready = async (): Promise<void> => {
      await session.page.waitForFunction(
        `(() => { const v = ${inline}; return v != null && v.readyState >= 2 && !v.seeking })()`,
        { timeout: 60_000 }
      )
    }
    await ready()
    const inlineWall = async (): Promise<number | null> =>
      (await read(session)).at(-1)?.wall ?? null
    /**
     * Picks Angle 1 or Angle 2 from the strip: the game lists others too,
     * and keeps its earlier recordings of the same names before the live
     * ones, so the last of the name is the camera publishing now.
     */
    const pick = async (index: number): Promise<void> => {
      const name = `Angle ${index + 1}`
      await session.page.evaluate(
        `(() => { [...document.querySelectorAll('[aria-label="Camera angles"] [role="tab"]')].findLast(tab => tab.textContent.trim().startsWith(${JSON.stringify(name)})).click() })()`
      )
    }
    // Played, as the page's own picture is, so it joins 45 s behind the
    // newest footage, and left playing: a switch lands on the moment the
    // picture had reached when it was asked for.
    await session.page.evaluate(`${inline}.play()`)
    await pause(3000)
    const wallNow = async (): Promise<{ wall: number | null; at: number }> => {
      const at = Date.now()
      return { wall: await inlineWall(), at }
    }
    const source = async (): Promise<string> =>
      (await session.page.evaluate(`${inline}.currentSrc`)) as string
    for (let turn = 0; turn < 5; turn++) {
      await ready()
      const before = await wallNow()
      const from = await source()
      const askedAt = Date.now()
      await pick((turn + 1) % 2)
      // The first picture of the other angle.
      await session.page.waitForFunction(
        `(() => { const v = ${inline}; return v != null && v.currentSrc !== ${JSON.stringify(from)} && v.readyState >= 2 && !v.seeking })()`,
        { timeout: 30_000 }
      )
      const landed = await wallNow()
      const playing = !((await session.page.evaluate(
        `${inline}.paused`
      )) as boolean)
      expect(before.wall, 'a clock before').not.equals(null)
      expect(landed.wall, 'a clock after').not.equals(null)
      const asked = before.wall! + (askedAt - before.at)
      print('E6 switch', { turn, asked, landed: landed.wall, playing })
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
    const reading = (await read(session, 10_000)).at(-1)!
    expect(reading.seekingPerSec, 'no re-seek after landing').equals(0)
    expect(
      Math.abs(later.wall! - settled.wall! - (later.at - settled.at)),
      'plays on in step with the wall clock'
    ).lessThan(500)
    // Held still for the one-angle player, so its opening is judged against
    // one instant.
    await session.page.evaluate(`${inline}.pause()`)
    await ready()

    // The one-angle player opens on the picture's moment, and plays on from
    // it: once it plays, its clock is no earlier than that moment and no
    // later than it plus the time since the tap.
    const atOpen = await inlineWall()
    const tapped = Date.now()
    await session.page.click('[data-testid="gameVideoOpen"]')
    try {
      await session.page.waitForFunction(
        `(() => { const v = ${GRID_VIDEOS}; return v.length === 1 && v[0].readyState >= 2 && !v[0].paused })()`,
        { timeout: 60_000 }
      )
    } catch (error) {
      print(
        'E6 player never started',
        await session.page.evaluate(
          `(() => ${GRID_VIDEOS}.map(v => ({ t: v.currentTime, paused: v.paused, readyState: v.readyState, seekable: v.seekable.length ? [v.seekable.start(0), v.seekable.end(v.seekable.length - 1)] : null, buffered: [...Array(v.buffered.length).keys()].map(i => [v.buffered.start(i), v.buffered.end(i)]), said: [...document.querySelectorAll('div')].filter(d => d.closest('#root') == null && d.childElementCount === 0).map(d => d.textContent).filter(Boolean) })))()`
        )
      )
      throw error
    }
    const tile = (await read(session))[0]
    const readAt = Date.now()
    print('E6 player opened', {
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
    const lastTile = (await read(session))[0]
    const lastAt = Date.now()
    await session.page.evaluate(
      `(() => { [...document.querySelectorAll('[aria-label="Close"]')].find(node => node.closest('#root') == null).click() })()`
    )
    const closedAt = Date.now()
    await session.page.waitForFunction(
      `(() => ${GRID_VIDEOS}.length === 0)()`,
      {
        timeout: 30_000
      }
    )
    await pause(5000)
    await ready()
    const back = await inlineWall()
    const readBackAt = Date.now()
    // The inline picture resumes playing. Its first moment is the one at
    // close, but this reading comes after it has had time to play again.
    const expected = lastTile.wall! + (closedAt - lastAt)
    print('E6 player closed', { closedAt: expected, back })
    expect(await session.page.evaluate(`${inline}.paused`)).equals(false)
    expect(back! - expected, 'resumes from the player’s moment').within(
      -750,
      readBackAt - closedAt + 750
    )
  })

  it('plays every live tile 45 s behind, in step, and waits for a camera that stops without seeking it (E7)', async function () {
    const V = fixture().games.V
    const session = await webSession('e7', 1280, 720)
    await open(
      session,
      `/games/${V.id}?angles=${V.videos.join(',')}&audio=${V.videos[0]}`
    )
    await session.page.waitForFunction(
      `(() => { const v = ${GRID_VIDEOS}; return v.length === ${V.videos.length} && v.every(one => one.readyState >= 2) })()`,
      { timeout: 90_000 }
    )
    // It starts on its own once every tile holds enough.
    await session.page.waitForFunction(
      `(() => ${GRID_VIDEOS}.every(one => !one.paused))()`,
      { timeout: 30_000 }
    )
    await pause(1000)

    const opening = (await read(session)).slice(0, 2)
    const behind = opening.map(one =>
      one.seekableEnd == null ? null : one.seekableEnd - one.currentTime
    )
    print('E7 opening', { behind, walls: opening.map(one => one.wall) })
    for (const [index, gap] of behind.entries())
      expect(gap, `tile ${index + 1} behind its newest`).closeTo(45, 3)
    expect(Math.abs(behind[0]! - behind[1]!), 'equal behind').lessThan(1)

    // A minute of reads: few seeks, clocks together.
    const offsets: number[] = []
    for (let second = 0; second < 20; second++) {
      const reads = (await read(session)).slice(0, 2)
      for (const [index, one] of reads.entries())
        expect(one.seekingPerSec, `tile ${index + 1} seeks`).lessThan(1)
      if (reads[0].wall != null && reads[1].wall != null)
        offsets.push(Math.abs(reads[0].wall - reads[1].wall))
      await pause(1000)
    }
    expect(offsets.length, 'clocks read').greaterThan(10)
    expect(Math.max(...offsets), 'clocks agree').lessThan(250)
    await shot(session, 'web-live-two-tiles-after.png')

    // Angle 2's camera stops for 25 s. Its tile plays 45 s behind with half
    // a minute in hand, so the outage is absorbed: it is never sought, and
    // angle 1 plays on. (Past the cushion a tile waits, labelled — U27; the
    // server closes a publisher silent for 30 s, so the bench cannot show
    // that and have it come back.)
    const stopped = publisherOf(1)
    process.kill(stopped, 'SIGSTOP')
    const states: string[] = []
    /** Angle 2's newest footage, as its player sees it, through the stop. */
    const ends: number[] = []
    try {
      for (let second = 0; second < 25; second++) {
        const [first, second2] = (await read(session, 1000)).slice(0, 2)
        if (second2.state != null) states.push(second2.state)
        if (second2.seekableEnd != null) ends.push(second2.seekableEnd)
        expect(first.paused, 'angle 1 plays on').equals(false)
        expect(second2.seekingPerSec, 'angle 2 never sought').equals(0)
        expect(second2.paused, 'angle 2 plays from what it holds').equals(false)
        await pause(1000)
      }
    } finally {
      process.kill(stopped, 'SIGCONT')
    }
    print('E7 angle 2 states', states)
    print('E7 angle 2 newest footage', { first: ends[0], last: ends.at(-1) })
    expect(states.length).greaterThan(20)
    // The camera really stopped: its playlist grew by no more than the
    // segments already on their way.
    expect(ends.at(-1)! - ends[0], 'angle 2 stopped publishing').lessThan(10)
    // Back: it rejoins.
    await session.page.waitForFunction(
      `(() => { const tile = ${GRID_VIDEOS}[1].closest('[data-tile-state]'); return tile != null && tile.getAttribute('data-tile-state') === 'playing' })()`,
      { timeout: 90_000 }
    )
  })
})
