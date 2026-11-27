import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { topLift } from '../../../../src/app/field/fieldSafeArea'
import type { FixtureManifest } from '../../../core/fixtures'
import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  apiAs,
  type Bounds,
  type Node,
  openPhoneScorer,
  type PhoneScorer,
  type Proof,
  proofOf,
  replayStored,
  scorePath,
  sleep,
  until
} from '../../../rigs/scoring/phoneScorer'

/**
 * Sending a runner back to the base he held before the prior play, on the
 * native scoring field of an iPhone. Each scenario opens a game the
 * `prior-runner` world scored to where it starts:
 *
 * - first, second, timed: a drag of Mookie back sends him to the base he
 *   held, says so, and keeps the count and every pitch's time; the timed
 *   single is entered through the field and closed by the real Done timer,
 *   and the return survives reopening;
 * - pitched: after pitches the return asks first, Cancel leaves the game as
 *   it was, Yes sends him back; reopening keeps it, Undo takes it back and
 *   the next pitch counts;
 * - home: an optional advance from third stays scored;
 * - occupied: a retreat onto a held base does nothing;
 * - open: on a play still open, the return and a new advance are immediate.
 *
 * What the screen saved is read from the server, the stored game replayed
 * as the app's session opens it. Screen points are an iPhone's with its
 * 59-point island: the field rises `topLift` into it.
 */

const LIFT = topLift(59, 'ios')

const first = [
  { x: 196, y: 452 - LIFT },
  { x: 287, y: 528 - LIFT }
]
const second = [
  { x: 106, y: 520 - LIFT },
  { x: 196, y: 453 - LIFT }
]

interface Point {
  x: number
  y: number
  duration?: number
}

interface Field {
  app: PhoneScorer
  m: any
  world: FixtureManifest
  runner: number
  proof: () => Promise<Proof>
  open: (scenario: string) => Promise<void>
  gesture: (points: Point[], hold?: number) => Promise<void>
  tap: (text: string) => Promise<void>
  shot: (name: string) => Promise<void>
  runnerPlate: (name: string) => Promise<Bounds | undefined>
  screenHas: (fragment: string) => Promise<boolean>
  lines: string[]
}

async function openField(ctx: HarnessContext): Promise<Field> {
  const world = await ctx.fixture('prior-runner')
  const api = await apiAs(ctx, world.accounts.scorer)
  const app = await openPhoneScorer(ctx, 'scorer')
  const { m } = app
  let current = ''
  const nodes = async (): Promise<Node[]> => await app.nodes()
  const window = async (): Promise<Bounds> => {
    const root = (await m.hierarchy()) as Node
    if (root.bounds == null) throw new Error('The screen has no bounds')
    return root.bounds
  }
  return {
    app,
    m,
    world,
    runner: Number(world.ids.runner),
    lines: [],
    proof: async () =>
      await proofOf(
        await replayStored(
          await api.client.gameEvents(world.ids[current]),
          world.ids[current],
          world.ids.context
        )
      ),
    open: async scenario => {
      current = scenario
      await app.open(scorePath(world.ids[scenario]))
      await m.assertVisible({ id: 'field-nameplate', timeout: 15000 })
      await sleep(1500)
    },
    gesture: async (points, hold = 500) => {
      const size = await window()
      for (const p of points)
        expect(
          p.x >= 0 && p.x < size.width && p.y >= 0 && p.y < size.height,
          JSON.stringify({ p, size })
        ).to.equal(true)
      if (points.length === 1) {
        await m.tapOnPoint({
          x: Math.round(points[0].x),
          y: Math.round(points[0].y),
          duration: hold
        })
        return
      }
      if (points.length > 2)
        throw new BlockedError(
          'maestro-d has no one-finger touch path through more than two points (press, move, move again, lift), which re-advancing the runner onto Safe from second takes'
        )
      await m.dragAndDrop({
        from: {
          point: `${Math.round(points[0].x)},${Math.round(points[0].y)}`
        },
        to: { point: `${Math.round(points[1].x)},${Math.round(points[1].y)}` },
        holdDuration: hold,
        duration: points[1].duration ?? 850
      })
    },
    tap: async text => {
      await m.tapOn({ text: `^${text}$`, timeout: 10000 })
    },
    shot: async name => {
      await m.takeScreenshot({ path: ctx.artifact(`${name}.png`) })
    },
    // The field plate is the short label on the dirt. The lineup card and
    // the play toast sit outside this band.
    runnerPlate: async name => {
      const found = (await nodes()).filter(node => {
        const bounds = node.bounds
        return (
          node.text?.toLowerCase().includes(name.toLowerCase()) === true &&
          bounds != null &&
          bounds.height <= 40 &&
          bounds.width <= 120 &&
          bounds.y >= 400 - LIFT &&
          bounds.y <= 620 - LIFT
        )
      })
      return found.sort((a, b) => b.bounds!.y - a.bounds!.y)[0]?.bounds
    },
    screenHas: async fragment =>
      (await nodes()).some(node => node.text?.includes(fragment) === true)
  }
}

const bodyOf = (plate: Bounds): Point => ({
  x: Math.round(plate.x + plate.width / 2),
  y: Math.round(plate.y - 14)
})

/** Waits until Mookie's plate stands still at third, after a play. */
async function stillAtThird(f: Field, message: string): Promise<void> {
  await until(
    async () => {
      const plate = await f.runnerPlate('Mookie')
      if (plate == null || plate.y < 510 - LIFT) return false
      await sleep(400)
      const settled = await f.runnerPlate('Mookie')
      return (
        settled != null &&
        Math.abs(settled.x - plate.x) < 2 &&
        Math.abs(settled.y - plate.y) < 2
      )
    },
    message,
    20000
  )
}

/** A drag back to `to` (1 or 2), said and saved, with count and times kept. */
async function returned(
  f: Field,
  scenario: string,
  before: Proof,
  to: number
): Promise<Proof> {
  await f.shot(`${scenario}-return-after`)
  await f.m.assertVisible({
    text: `Runner did not advance on prior play. Sent back to ${['', '1st', '2nd', '3rd'][to]}.`,
    timeout: 3000
  })
  await until(
    async () => (await f.proof()).bases[to - 1] === f.runner,
    `The server never had Mookie back on base ${to}`,
    15000,
    500
  )
  const after = await f.proof()
  expect(after.bases[to - 1]).to.equal(f.runner)
  expect(after.count).to.deep.equal(before.count)
  expect(
    after.times,
    'Every current pitch retains its original time'
  ).to.deep.equal(before.times)
  f.lines.push(`${scenario} return, current count and original times verified`)
  return after
}

/** Reopens the game: what it shows is what the server kept. */
async function reopen(f: Field, scenario: string): Promise<void> {
  await f.open(scenario)
}

async function run(
  ctx: HarnessContext,
  work: (f: Field) => Promise<void>
): Promise<void> {
  const f = await openField(ctx)
  try {
    await work(f)
  } finally {
    writeFileSync(ctx.artifact('prior-runner.log'), f.lines.join('\n') + '\n')
  }
}

export default defineHarness({
  id: 'scoring/prior-runner/send-back',
  title: 'A runner dragged back returns to the base he held before the play',
  kind: 'e2e',
  covers: [
    'src/app/scoring/priorRunnerCorrection.tsx',
    'src/app/scoring/runnerDrag.ts',
    'src/app/field/fieldSafeArea.ts',
    'src/app/field/FieldCanvas.native.tsx'
  ],
  stack: 'isolated',
  fixtures: ['prior-runner'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      // The native field draws in 3D: a GPU, so a physical iPhone.
      devices: [
        { role: 'device', needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    }
  },
  services: [],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 20,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'back-to-first': async ctx => {
      await run(ctx, async f => {
        await f.open('first')
        const before = await f.proof()
        await f.gesture(first)
        await returned(f, 'first', before, 1)
      })
    },

    'back-to-second': async ctx => {
      await run(ctx, async f => {
        await f.open('second')
        const before = await f.proof()
        await f.gesture(second)
        await returned(f, 'second', before, 2)
      })
    },

    'after-pitches-asks-first': async ctx => {
      await run(ctx, async f => {
        await f.open('pitched')
        const before = await f.proof()
        await f.gesture(first)
        await f.m.assertVisible({
          text: 'Yes, send back runner',
          timeout: 5000
        })
        await f.shot('pitch-confirmation-after')
        expect(await f.proof(), 'Proposal is read-only').to.deep.equal(before)
        await f.tap('Cancel')
        expect(
          await f.proof(),
          'Cancel retains the full game state'
        ).to.deep.equal(before)
        await f.gesture(first)
        await f.tap('Yes, send back runner')
        const after = await returned(f, 'pitched', before, 1)
        await reopen(f, 'pitched')
        expect(
          await f.proof(),
          'Reopen keeps the corrected game'
        ).to.deep.equal(after)
        await f.m.tapOn({ text: 'Undo.*', timeout: 5000 })
        await until(
          async () => (await f.proof()).count?.balls === 1,
          'Undo never reached the server',
          15000,
          500
        )
        const undone = await f.proof()
        expect(undone.bases[0]).to.equal(f.runner)
        expect(undone.count?.balls).to.equal(1)
        await f.tap('Ball')
        await sleep(2000)
        await until(
          async () => (await f.proof()).count?.balls === 2,
          'The next pitch never reached the server',
          15000,
          500
        )
        expect((await f.proof()).count?.balls).to.equal(2)
        f.lines.push('reopen, Undo and next pitch verified')
      })
    },

    'home-stays-scored': async ctx => {
      await run(ctx, async f => {
        await f.open('home')
        const before = await f.proof()
        expect(before.score).to.equal(1)
        expect(before.bases.includes(f.runner)).to.equal(false)
        expect(before.bases[2]).to.equal(null)
        await f.shot('home-stays-scored')
        f.lines.push(
          'Optional advance from third stays scored; the plate call is not dragged back'
        )
      })
    },

    'timed-single-return': async ctx => {
      await run(ctx, async f => {
        await f.open('timed')
        await f.tap('Swing in Play')
        await f.tap('Single')
        await f.tap('Juan S')
        // One tap places the fielder. The next tap, with no vertical
        // travel, accepts the trajectory the play started at.
        await f.gesture([{ x: 196, y: 450 - LIFT }])
        await until(
          async () =>
            (await f.screenHas('Drag up and down for ball trajectory')) ||
            (await f.screenHas('Time to edit play')),
          'The single never offered a trajectory',
          20000
        )
        if (await f.screenHas('Drag up and down for ball trajectory'))
          await f.gesture([{ x: 196, y: 420 - LIFT }], 80)
        await until(
          async () => await f.screenHas('Time to edit play'),
          'The Done countdown never opened',
          30000
        )
        await until(
          async () => !(await f.screenHas('Time to edit play')),
          'The real Done countdown did not close',
          15000
        )
        await stillAtThird(f, 'Mookie never stood still at third')
        const before = await f.proof()
        expect(
          before.open,
          'The real Done countdown closed the single'
        ).to.equal(false)
        const plate = await f.runnerPlate('Mookie')
        expect(plate, 'Mookie is on the field').to.not.equal(undefined)
        await f.gesture([bodyOf(plate!), second[1]])
        const after = await returned(f, 'timed', before, 2)
        await reopen(f, 'timed')
        expect(
          await f.proof(),
          'The timed-play return survives reopening'
        ).to.deep.equal(after)
        f.lines.push(
          'Single entered through native controls, real Done timer and saved return verified'
        )
      })
    },

    'occupied-retreat-inert': async ctx => {
      await run(ctx, async f => {
        await f.open('occupied')
        const occupied = await f.proof()
        await f.gesture(first)
        await sleep(2000)
        expect(await f.proof(), 'Occupied retreat is inert').to.deep.equal(
          occupied
        )
        f.lines.push('occupied target rejected')
      })
    },

    'open-play-return-and-advance': async ctx => {
      await run(ctx, async f => {
        await f.open('open')
        expect(
          (await f.proof()).open,
          'The game is still an open play'
        ).to.equal(true)
        await until(
          async () => {
            const plate = await f.runnerPlate('Mookie')
            return (
              (await f.proof()).bases[2] === f.runner &&
              plate != null &&
              plate.y >= 510 - LIFT
            )
          },
          'Mookie never arrived at third on the open play',
          20000
        )
        const arrived = await f.runnerPlate('Mookie')
        expect(arrived, 'Mookie is on the field').to.not.equal(undefined)
        await f.gesture([bodyOf(arrived!), second[1]])
        await until(
          async () => (await f.proof()).bases[1] === f.runner,
          'The open play did not send Mookie back to second',
          15000,
          500
        )
        // Forward again only counts when the finger finishes on Safe. That
        // chip sits on the calibrated third-base point, so wait until he is
        // standing on the calibrated second-base point and use that path.
        await until(
          async () => {
            const plate = await f.runnerPlate('Mookie')
            if (plate == null) return false
            const body = bodyOf(plate)
            return Math.hypot(body.x - 196, body.y - (452 - LIFT)) <= 30
          },
          'Mookie never settled back on second',
          15000
        )
        await f.gesture([
          { x: 196, y: 452 - LIFT },
          { x: 106, y: 528 - LIFT },
          { x: 46, y: 491 - LIFT }
        ])
        await until(
          async () => (await f.proof()).bases[2] === f.runner,
          'The re-advance never reached the server',
          15000,
          500
        )
        await f.shot('open-return-forward-after')
        f.lines.push('open return and re-advance remain immediate')
      })
    }
  }
})
