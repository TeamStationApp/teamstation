import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import type { Page } from '../../../core/web'
import {
  aimLandingAt,
  placeOffered,
  setTrajectory
} from '../../../rigs/fieldPointer'
import {
  captureScene,
  click,
  fieldOf,
  open,
  readGuide,
  type SceneProbeWindow,
  suite,
  waitReady
} from '../../../rigs/scoring/webScoring'

/**
 * E9: a pitch has no windup and its controls are back within 400 ms, and the
 * other scoring pictures play in half their old time. Each test prints the
 * in-page `performance.now()` times it measured as `pitch-timing:` lines. With
 * TS_CAPTURE_ONLY=1 (the before run, on the base revision) the same times are
 * printed and nothing is asserted.
 */
/*
 * Converted from the scoring screen's legacy browser suite: each mocha `it`
 * is a scenario of the same name, on the stack's web build and the
 * `scoring-field` world, in the Mac's Chrome (the field draws in 3D). The
 * old page-side API's switches (offline, stalled, held and refused saves,
 * a hidden opponent) are the stack's fault server and database
 * (`rigs/scoring/webScoring.ts`).
 */
const { add: it, scenarios } = suite()

const capturing = false

interface Frame {
  t: number
  presentation: string
  ballVisible: boolean
  ballZ: number
  windup: boolean
  ready: boolean
  celebration: boolean
}
interface TimelineWindow {
  qaTimeline: Frame[]
  qaStop: boolean
  /** Samples the page once more, now. */
  qaSample: () => void
}
async function openField(): Promise<Page> {
  const { page } = await open(
    '/games/g1/score',
    false,
    false,
    false,
    'right',
    true
  )
  // A phone's field: software WebGL draws it fast enough to time.
  await page.setViewport({ width: 390, height: 844 })
  // The field's opening frames finished on the GPU: software WebGL takes
  // a second over them after the page shows the field, and a tap meanwhile
  // waits. A revision before `data-field-drawn` (the before run) is timed
  // from the field's first frame, as it was.
  await page.waitForSelector(
    capturing
      ? 'canvas[data-field-ready="true"]'
      : 'canvas[data-field-drawn="true"]',
    { timeout: 30000 }
  )
  await captureScene(page)
  return page
}
/* eslint-disable @typescript-eslint/prefer-optional-chain -- Browser evaluation cannot reference generated Sucrase helpers. */
/** Records, every 10 ms, what the field and the controls show. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as SceneProbeWindow & TimelineWindow
    host.qaTimeline = []
    host.qaStop = false
    // The pitcher is the fielder on the mound.
    let pitcher: { getObjectByName: (name: string) => unknown } | undefined
    host.qaScene!.traverse(object => {
      if (
        object.name.startsWith('player-defense-') &&
        Math.abs(object.position.x) < 1 &&
        Math.abs(object.position.z + 18.44) < 1
      )
        pitcher = object
    })
    const step = (): void => {
      if (host.qaStop) {
        clearInterval(timer)
        return
      }
      const scene = host.qaScene!
      const ball = scene.getObjectByName('animated-baseball')
      const rig =
        pitcher == null ? undefined : pitcher.getObjectByName('athlete-rig')
      const field = document.querySelector('[data-presentation]')
      const control = document.querySelector('[aria-label="Ball"]')
      host.qaTimeline.push({
        t: performance.now(),
        presentation:
          field == null
            ? 'none'
            : String(field.getAttribute('data-presentation')),
        ballVisible: ball != null && ball.visible,
        ballZ: ball == null ? 0 : ball.position.z,
        // The articulated rig is drawn only while the pitcher is posed in
        // a delivery.
        windup: rig != null && (rig as { visible: boolean }).visible,
        ready:
          control != null && control.getAttribute('aria-disabled') !== 'true',
        // The scoreboard's summary names the home run while it is
        // celebrated.
        celebration:
          document.querySelector('[aria-label*="HOME RUN · "]') != null
      })
    }
    // Sampled on a timer as well as drawn frames: a slow frame must not
    // hide when the page changed.
    const timer = setInterval(step, 10)
    host.qaSample = step
    step()
  })
}
/** Taps a control in the page and returns when, by the page's clock. */
async function tap(page: Page, label: string): Promise<number> {
  return await page.evaluate(label => {
    const t = performance.now()
    document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click()
    return t
  }, label)
}
async function timeline(page: Page): Promise<Frame[]> {
  return await page.evaluate(() => {
    const host = window as unknown as TimelineWindow
    // The page may have changed after the last tick: a wait that saw the
    // change returns before the next one.
    host.qaSample()
    host.qaStop = true
    return host.qaTimeline
  })
}
/* eslint-enable @typescript-eslint/prefer-optional-chain */
/** The first frame at or after `from` that `test` holds for. */
function first(
  frames: Frame[],
  from: number,
  test: (frame: Frame) => boolean
): Frame | undefined {
  return frames.find(frame => frame.t >= from && test(frame))
}
const since = (frame: Frame | undefined, from: number): number | undefined =>
  frame == null ? undefined : frame.t - from
const ms = (n: number | undefined): string =>
  n == null ? 'never' : `${Math.round(n)} ms`

it('pitch animation: takes the next tap within 400 ms, and the pitcher never winds up', async function () {
  const page = await openField()
  try {
    await waitReady(page)
    await record(page)
    // Three pitches, each tapped as soon as the last one's controls are
    // back. The first is the screen's first: the field warmed the ball's
    // shader and the cues when it opened, so it is as fast as the others.
    const taps: number[] = []
    for (const count of [1, 2, 3]) {
      taps.push(await tap(page, 'Ball'))
      await page.waitForSelector(`[aria-label*="Pitches ${count}"]`, {
        timeout: 5000
      })
      await waitReady(page)
    }
    const frames = await timeline(page)
    const pitches = taps.map((tapped, index) => {
      const until = taps[index + 1] ?? Infinity
      const own = frames.filter(f => f.t >= tapped && f.t < until)
      const shown = first(own, tapped, f => f.presentation !== 'none')
      return {
        tapped,
        shown,
        // Two feet off the mound, on its way to the plate.
        ballOut: first(own, tapped, f => f.ballVisible && f.ballZ > -16.44),
        done: first(own, shown?.t ?? tapped, f => f.presentation === 'none'),
        ready: first(
          own,
          shown?.t ?? tapped,
          f => f.ready && f.presentation === 'none'
        ),
        windup: own.filter(f => f.windup).length,
        samples: own.length
      }
    })
    pitches.forEach((pitch, index) => {
      console.log(
        `pitch-timing: pitch ${index + 1} tap=0 ms; picture shown ${ms(since(pitch.shown, pitch.tapped))}; ` +
          `ball out of the hand toward the plate ${ms(since(pitch.ballOut, pitch.tapped))}; ` +
          `PRESENTATION_DONE (picture none) ${ms(since(pitch.done, pitch.tapped))}; ` +
          `picture lasted ${ms(pitch.done == null || pitch.shown == null ? undefined : pitch.done.t - pitch.shown.t)}; ` +
          `controls ready ${ms(since(pitch.ready, pitch.tapped))}; ` +
          (index + 1 < taps.length
            ? `next tap taken ${ms(taps[index + 1] - pitch.tapped)}; `
            : '') +
          `windup samples ${pitch.windup} of ${pitch.samples}`
      )
    })
    if (capturing) return
    for (const pitch of pitches) {
      expect(pitch.windup).equals(0)
      expect(pitch.done).not.equals(undefined)
      expect(pitch.ready).not.equals(undefined)
    }
    for (const pitch of pitches) {
      // The ball is on its way on the picture's first drawn frames.
      expect(pitch.ballOut!.t - pitch.tapped).lessThan(150)
      // The picture lasts 280 ms of its own clock; software WebGL's frames
      // and React's commit add a frame or two, and the controls take the
      // next tap within 400 ms of this one.
      expect(pitch.done!.t - pitch.shown!.t).within(260, 400)
      expect(pitch.ready!.t - pitch.tapped).at.most(400)
    }
  } finally {
    await page.close()
  }
})

it('hit flight: plays a single in half its old time', async function () {
  const page = await openField()
  try {
    await click(page, 'Swing in Play')
    await click(page, 'Single')
    await page.waitForSelector(
      '[aria-label^="Tap or drag a player to where the ball was fielded"]'
    )
    await placeOffered(fieldOf(page))
    await page.waitForSelector(
      '[aria-label^="Drag up and down for ball trajectory."]'
    )
    await record(page)
    const pressed = await page.evaluate(() => performance.now())
    await setTrajectory(fieldOf(page))
    await page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
    await page.waitForSelector('[data-presentation="none"]', {
      timeout: 30000
    })
    const frames = await timeline(page)
    const swing = first(frames, pressed, f => f.presentation === 'hit:swing')
    const flight = first(frames, pressed, f => f.presentation === 'hit:flight')
    const done = first(
      frames,
      flight?.t ?? pressed,
      f => f.presentation === 'none'
    )
    const flightMs = flight != null && done != null ? done.t - flight.t : NaN
    console.log(
      `pitch-timing: hit flight (Single) trajectory set=0 ms; swing ${ms(since(swing, pressed))}; ` +
        `contact (flight) ${ms(since(flight, pressed))}; ` +
        `motion end (picture none) ${ms(since(done, pressed))}; ` +
        `contact to end ${ms(flightMs)}`
    )
    await click(page, 'Finish at-bat')
    if (capturing) return
    // On the base revision this single's contact to end measured 1245 to
    // 1340 ms (pitch-timing.log): half of it, within a few frames.
    expect(flightMs).within(1290 / 2 - 150, 1290 / 2 + 150)
  } finally {
    await page.close()
  }
})

it('celebration: shows the home run for at most three seconds, half its old time', async function () {
  this.timeout(90000)
  const page = await openField()
  try {
    await click(page, 'Swing in Play')
    await click(page, 'Home Run')
    await page.waitForSelector('canvas[data-field-ready="true"]')
    await page.waitForSelector('[aria-label^="Drag where the ball was hit"]')
    await captureScene(page)
    const guide = await readGuide(page)
    await aimLandingAt(fieldOf(page), guide.x, guide.z)
    await page.waitForSelector(
      '[aria-label^="Drag up and down for ball trajectory."]'
    )
    await record(page)
    const pressed = await page.evaluate(() => performance.now())
    await setTrajectory(fieldOf(page))
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 45000
    })
    await page.waitForFunction(
      () => document.querySelector('[aria-label*="HOME RUN · "]') == null,
      { timeout: 20000 }
    )
    await waitReady(page)
    const frames = await timeline(page)
    const shown = first(frames, pressed, f => f.celebration)
    const gone = first(frames, shown?.t ?? pressed, f => !f.celebration)
    const flight = first(frames, pressed, f => f.presentation === 'hit:flight')
    const landed = first(
      frames,
      flight?.t ?? pressed,
      f => f.presentation === 'none'
    )
    const ready = first(frames, gone?.t ?? pressed, f => f.ready)
    const celebrationMs = shown != null && gone != null ? gone.t - shown.t : NaN
    console.log(
      `pitch-timing: home run trajectory set=0 ms; contact ${ms(since(flight, pressed))}; ` +
        `ball picture end ${ms(since(landed, pressed))}; ` +
        `celebration shown ${ms(since(shown, pressed))}; ` +
        `celebration end ${ms(since(gone, pressed))}; ` +
        `celebration lasted ${ms(celebrationMs)}; ` +
        `controls ready ${ms(since(ready, pressed))}; ` +
        `frames ${frames.length}, last ${ms(since(frames.at(-1), pressed))}`
    )
    if (capturing) return
    // At most its three seconds; the home run's play closes sooner, and
    // with it the celebration: on the base revision it ended 5194 to 5227
    // ms after the trajectory was set, and now in half that, as its
    // runners run twice as fast.
    expect(since(gone, pressed)).within(5200 / 2 - 400, 3000 + 300)
    expect(celebrationMs).at.most(3000 + 150)
  } finally {
    await page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/pitch-timing',
  title: 'Pitch animation, hit flight and celebration timing',
  kind: 'e2e',
  covers: ['src/app/scoring/**', 'src/app/field/**'],
  stack: 'isolated',
  fixtures: ['scoring-field'],
  exclusive: false,
  surfaces: {
    // The field draws in 3D: a GPU, so the Mac's Chrome.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 12,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
