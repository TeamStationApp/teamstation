import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  COACH_APP,
  type CoachApp,
  flatten,
  labelOf,
  type Node,
  openCoachApp,
  type Rect
} from '../../../rigs/coach/coachApp'

/**
 * Coach Game in the phone app, on a physical iPhone (its Plan tab and
 * Defense field are drawn by the scoring screens, which need a GPU), each
 * scenario on its own lineup game (`coach-plan`), signed in through the
 * password form.
 *
 * S1 taps a cell, which opens the field picker, and taps LF on it. S8 opens
 * the picker and taps the Lineup tab, then the Box Score pill: each tap
 * closes the picker and does nothing else. S2 holds a cell and drags onto
 * C, then off the picture, which changes nothing. S3 holds a player and
 * drags him down two rows: his innings move with him and the Lineup tab
 * bats him there too. S6 holds SS on the picker and lets go, which writes
 * it; S7 holds a cell and drags to SS, which writes it. On a phone, as the
 * old run did there, only what S6 and S7 write is checked: the frames that
 * showed the enlarged box came from a simulator's own screenshots. S4: the
 * roster footer bar lowers ten points into the 34-point bottom inset, on
 * the coaching screen and on the scorekeeper's Set Team Rosters sheet; and
 * Cancel restores a lineup a player was taken out of. S5: the Defense
 * field's nine cards on six rows, each name inside its card on two lines.
 * D4 and D3 drag on the Defense tab: a vacated box takes a dropped bench
 * player; a swipe or a quick drag from a card's name lifts nobody, the same
 * quick drag from its grip does, and a held name then dragged does.
 *
 * Every drag is maestro-d's `dragAndDrop` on the handed phone, recorded
 * through maestro-d.
 */

const POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']
/** A Face ID iPhone's home indicator inset, in points. */
const BOTTOM_INSET = 34
/** How far the footer bar lowers into it. */
const FOOTER_DROP = 10

interface Point {
  x: number
  y: number
}

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const inside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x - 1 &&
  inner.y >= outer.y - 1 &&
  inner.x + inner.width <= outer.x + outer.width + 1 &&
  inner.y + inner.height <= outer.y + outer.height + 1

const centre = (b: Rect): Point => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2
})

/** The positions whose cards share a vertical band, top to bottom. */
function cardRows(cards: Map<string, Rect>): string[][] {
  const rows: Array<{ bottom: number; positions: string[] }> = []
  for (const [position, card] of [...cards].sort(([, a], [, b]) => a.y - b.y)) {
    const row = rows.at(-1)
    // iOS rounds accessibility frames outward, so cards a point apart can
    // read as touching; only a real overlap shares a band.
    if (row != null && card.y < row.bottom - 1) {
      row.positions.push(position)
      row.bottom = Math.max(row.bottom, card.y + card.height)
    } else rows.push({ bottom: card.y + card.height, positions: [position] })
  }
  return rows.map(row => row.positions.sort())
}

/** The phone, and what the scenarios read and do on it. */
interface Phone {
  app: CoachApp
  m: any
  all: () => Promise<Node[]>
  byId: (id: string) => Promise<Node>
  cellValue: (row: number, inning: number) => Promise<string>
  cellPlayer: (row: number, inning: number) => Promise<string>
  lineup: () => Promise<string[]>
  holdAndDrag: (from: Point, to: Point) => Promise<void>
  quickDrag: (from: Point, to: Point) => Promise<void>
  hold: (at: Point, ms: number) => Promise<void>
  swipe: (from: Point, to: Point) => Promise<void>
  /** Records the screen into the run directory until the stop is called. */
  record: (name: string) => Promise<() => Promise<void>>
  footer: () => Promise<{ height: number; bar: Rect }>
}

async function phoneOf(ctx: HarnessContext, app: CoachApp): Promise<Phone> {
  const m = app.m
  const all = async (): Promise<Node[]> => flatten(await m.hierarchy())
  const root = (await m.hierarchy()) as Node
  const window = root.bounds!
  // As a share of the window: maestro-d reads bare numbers as pixels.
  const share = (p: Point): string =>
    `${((p.x / window.width) * 100).toFixed(2)}%, ${((p.y / window.height) * 100).toFixed(2)}%`
  const drag = async (
    from: Point,
    to: Point,
    holdDuration: number,
    duration: number
  ): Promise<void> => {
    await m.dragAndDrop({
      from: { point: share(from) },
      to: { point: share(to) },
      holdDuration,
      duration
    })
    await pause(800)
  }
  const byId = async (id: string): Promise<Node> => {
    const found = (await all()).find(n => n.id === id && n.bounds != null)
    expect(found?.bounds, `${id} is on screen`).not.equals(undefined)
    return found!
  }
  /** A plan cell's value, which its label ends with: "Ohtani, inning 2, C". */
  const cellValue = async (row: number, inning: number): Promise<string> => {
    const text = labelOf(await byId(`Plan cell ${row}-${inning}`))
    const match = new RegExp(`, inning ${inning}(?:, (.+))?$`).exec(text)
    return match?.[1] ?? ''
  }
  return {
    app,
    m,
    all,
    byId,
    cellValue,
    cellPlayer: async (row, inning) =>
      labelOf(await byId(`Plan cell ${row}-${inning}`)).replace(
        /, inning \d+.*$/,
        ''
      ),
    /** The lineup's Remove buttons, top to bottom: its batting order. */
    lineup: async () =>
      (await all())
        .filter(n => n.bounds != null && labelOf(n).startsWith('Remove '))
        .sort((a, b) => a.bounds!.y - b.bounds!.y)
        .map(labelOf),
    // Held a second where it starts, then carried to `to`.
    holdAndDrag: async (from, to) => {
      await drag(from, to, 1000, 1500)
    },
    // Carried from one point to another with no hold.
    quickDrag: async (from, to) => {
      await drag(from, to, 1, 400)
    },
    hold: async (at, ms) => {
      await drag(at, { x: at.x, y: at.y + 1 }, ms, 300)
    },
    swipe: async (from, to) => {
      await m.swipe({ start: share(from), end: share(to), duration: 300 })
      await pause(800)
    },
    record: async name => {
      const path = ctx.artifact(name)
      try {
        await m.startRecording({ path })
      } catch (error) {
        ctx.degrade(`no recording of ${name}: ${String(error)}`)
        return async () => {}
      }
      return async () => {
        await pause(1000)
        await m.stopRecording({ path })
      }
    },
    /** The window's height and the footer bar's bounds, once settled. */
    footer: async () => {
      await m.waitForAnimationToEnd()
      await pause(500)
      const top = (await m.hierarchy()) as Node
      const height = top.bounds?.height ?? 0
      expect(height, 'the window has a height').greaterThan(0)
      const bar = flatten(top).find(
        n => n.id === 'Roster footer bar' && n.bounds != null
      )
      expect(bar?.bounds, 'the footer bar is in the hierarchy').not.equals(
        undefined
      )
      return { height, bar: bar!.bounds! }
    }
  }
}

/** Coach Game for the head coach's team, on a fresh lineup game. */
async function coachGame(
  ctx: HarnessContext
): Promise<{ phone: Phone; world: Awaited<ReturnType<typeof ctx.fixture>> }> {
  const world = await ctx.fixture('coach-plan')
  const app = await openCoachApp(ctx, 'headCoach')
  await app.openCoach(world.ids.game, world.ids.homeTeam)
  await app.m.assertVisible({ text: 'Save Rosters', timeout: 60000 })
  return { phone: await phoneOf(ctx, app), world }
}

/** Coach Game's Plan tab, its sheet's cells in the hierarchy. */
async function planTab(ctx: HarnessContext): Promise<Phone> {
  const { phone } = await coachGame(ctx)
  await phone.m.tapOn({ text: 'Plan', timeout: 15000 })
  // The sheet's cells take a moment to reach the hierarchy.
  for (let tries = 0; tries < 10; tries++) {
    if ((await phone.all()).some(n => n.id === 'Plan cell 1-1')) break
    await pause(1000)
  }
  await phone.byId('Plan cell 1-1')
  await phone.m.waitForAnimationToEnd()
  return phone
}

/** Coach Game's Defense tab. */
async function defenseTab(
  ctx: HarnessContext
): Promise<{ phone: Phone; world: Awaited<ReturnType<typeof ctx.fixture>> }> {
  const opened = await coachGame(ctx)
  await opened.phone.m.tapOn({ text: 'Defense', timeout: 15000 })
  await opened.phone.m.assertVisible({
    text: '(Clear|Assign) CF',
    timeout: 15000
  })
  await opened.phone.m.waitForAnimationToEnd()
  return opened
}

/**
 * Where the picker draws a target's enlarged box: 1.5 times its size,
 * centred over it, its bottom three quarters of the target's height above
 * it, kept inside the card's border.
 */
function enlarged(target: Rect, card: Rect): Rect {
  const width = target.width * 1.5
  const height = target.height * 1.5
  const within = { x: card.x + 1, y: card.y + 1 }
  return {
    x: Math.min(
      Math.max(target.x + (target.width - width) / 2, within.x),
      card.x + card.width - 1 - width
    ),
    y: Math.max(target.y - 0.75 * target.height - height, within.y),
    width,
    height
  }
}

/** The cell's picker, opened by a tap, its targets read, and closed. */
async function pickerOf(
  phone: Phone,
  row: number,
  inning: number,
  targets: string[]
): Promise<{ card: Rect; at: Record<string, Rect> }> {
  await phone.m.tapOn({ id: `Plan cell ${row}-${inning}` })
  await pause(800)
  const card = (await phone.byId('Plan field picker')).bounds!
  const at: Record<string, Rect> = {}
  for (const target of targets)
    at[target] = (await phone.byId(`Plan pick ${target}`)).bounds!
  await phone.m.tapOn({ id: 'Plan picker close' })
  await pause(600)
  return { card, at }
}

/** Writes `position` into a cell from its picker. */
async function pick(
  phone: Phone,
  row: number,
  inning: number,
  position: string
): Promise<void> {
  await phone.m.tapOn({ id: `Plan cell ${row}-${inning}` })
  await pause(800)
  await phone.m.tapOn({ id: `Plan pick ${position}` })
  await pause(800)
}

/** Defense cards, players on the bench, and the moves between them. */
interface DefenseTab {
  card: (at: string) => Promise<Node | undefined>
  position: (at: string) => Promise<{ held: boolean; bounds: Rect }>
  until: (at: string, held: boolean) => Promise<boolean>
  bench: () => Promise<Node[]>
}

function defenseOf(phone: Phone, names: Set<string>): DefenseTab {
  /**
   * A position's card: "Clear SS" with a fielder, "Assign SS" without. A
   * box with no height has no frame, so it is missing.
   */
  const card = async (at: string): Promise<Node | undefined> =>
    (await phone.all()).find(
      n =>
        n.bounds != null &&
        n.bounds.height > 0 &&
        new RegExp(`^(Clear|Assign) ${at}$`).test(labelOf(n))
    )
  return {
    card,
    position: async at => {
      const found = await card(at)
      expect(found?.bounds, `the ${at} card is on screen`).not.equals(undefined)
      return {
        held: labelOf(found!).startsWith('Clear'),
        bounds: found!.bounds!
      }
    },
    until: async (at, held) => {
      for (let tries = 0; tries < 10; tries++) {
        const found = await card(at)
        if (found == null && !held) return true
        if (found != null && labelOf(found).startsWith('Clear') === held)
          return true
        await pause(500)
      }
      return false
    },
    /**
     * The bench's roster cards in sight, top to bottom, left to right: wholly
     * between the field's lowest card and the footer bar. The hierarchy also
     * lists cards scrolled up under the field.
     */
    bench: async () => {
      const nodes = await phone.all()
      const top = Math.max(
        ...nodes
          .filter(
            n => n.bounds != null && /^(Clear|Assign) \S+$/.test(labelOf(n))
          )
          .map(n => n.bounds!.y + n.bounds!.height)
      )
      const bottom = (await phone.byId('Roster footer bar')).bounds!.y
      return nodes
        .filter(
          n =>
            n.bounds != null &&
            names.has(labelOf(n)) &&
            n.bounds.y >= top &&
            n.bounds.y + n.bounds.height <= bottom
        )
        .sort((a, b) =>
          a.bounds!.y === b.bounds!.y
            ? a.bounds!.x - b.bounds!.x
            : a.bounds!.y - b.bounds!.y
        )
    }
  }
}

/** A card's grip, its three bars at its left edge, and its name. */
const grip = (card: Rect): Point => ({
  x: card.x + 12,
  y: card.y + card.height / 2
})
const nameOf = (card: Rect): Point => ({
  x: card.x + card.width * 0.7,
  y: card.y + card.height / 2
})

async function homeNames(): Promise<Set<string>> {
  const { LINEUP_NAMES } =
    await import('../../../../src/server/dev/lineupFixture')
  return new Set(LINEUP_NAMES.home)
}

export default defineHarness({
  id: 'scoring/game-plan/coaching-screen-phone',
  title:
    "Coach Game's Plan tab, roster bar and Defense field take a coach's taps, holds and drags on an iPhone",
  kind: 'e2e',
  covers: [
    'src/app/screens/CoachGameScreen.tsx',
    'src/app/scoring/RosterEditor.tsx',
    'src/app/scoring/RosterDrag.native.tsx',
    'src/app/scoring/DefensiveField.tsx',
    'src/app/scoring/plan/**'
  ],
  stack: 'isolated',
  fixtures: ['coach-plan'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      // The plan and the field are drawn by the scoring screens, which only
      // a GPU draws: a physical iPhone.
      devices: [
        { role: 'device', needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    }
  },
  services: [],
  apps: [COACH_APP],
  secrets: [],
  costUsd: 0,
  minutes: 40,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    's1-tap-opens-picker-and-writes': async ctx => {
      const phone = await planTab(ctx)
      await phone.m.tapOn({ id: 'Plan cell 2-3' })
      await pause(800)
      expect(
        (await phone.all()).some(n => n.id === 'Plan field picker'),
        'S1: a tap on a cell opens the field picker'
      ).equals(true)
      await phone.m.takeScreenshot({
        path: ctx.artifact('coach-plan-phone-picker.png')
      })
      await phone.m.tapOn({ id: 'Plan pick LF' })
      await pause(800)
      expect(
        await phone.cellValue(2, 3),
        'S1: a tap on LF writes LF into the cell'
      ).equals('LF')
      expect(
        (await phone.all()).some(n => n.id === 'Plan field picker'),
        'S1: the picker closes'
      ).equals(false)
    },

    's8-tap-above-sheet-closes-picker': async ctx => {
      const phone = await planTab(ctx)
      const picking = async (): Promise<boolean> =>
        (await phone.all()).some(n => n.id === 'Plan field picker')
      const held = await phone.cellValue(4, 3)
      for (const target of ['Lineup', 'Box Score']) {
        await phone.m.tapOn({ id: 'Plan cell 4-3' })
        await pause(1200)
        expect(await picking(), `S8: the picker opens before ${target}`).equals(
          true
        )
        // The header's own control, above the sheet.
        const control = (await phone.all()).find(
          n => labelOf(n) === target && n.bounds != null && n.bounds.y < 300
        )
        expect(control, `S8: ${target} is on screen`).not.equals(undefined)
        const at = centre(control!.bounds!)
        await phone.m.tapOnPoint({ x: Math.round(at.x), y: Math.round(at.y) })
        await pause(1500)
        expect(
          await picking(),
          `S8: a tap on ${target} closes the picker`
        ).equals(false)
        expect(
          (await phone.all()).some(n => n.id === 'Plan cell 1-1'),
          `S8: a tap on ${target} stays on the Plan tab`
        ).equals(true)
      }
      expect(await phone.cellValue(4, 3), 'S8: no cell changed').equals(held)
    },

    's2-hold-and-drag-onto-position': async ctx => {
      const phone = await planTab(ctx)
      const stop = await phone.record('coach-plan-phone-drag-s2.mp4')
      try {
        // Where C is drawn for this cell: the picker opens at the same place
        // for it every time.
        await phone.m.tapOn({ id: 'Plan cell 3-2' })
        await pause(800)
        const catcher = centre((await phone.byId('Plan pick C')).bounds!)
        const helpRow = centre((await phone.byId('Plan help row')).bounds!)
        await phone.m.tapOn({ id: 'Plan picker close' })
        await pause(600)
        const cell = centre((await phone.byId('Plan cell 3-2')).bounds!)
        await phone.holdAndDrag(cell, catcher)
        expect(
          await phone.cellValue(3, 2),
          'S2: holding and dragging onto C writes C'
        ).equals('C')
        // Off the picture: the Help row above the sheet.
        await phone.holdAndDrag(cell, helpRow)
        expect(
          await phone.cellValue(3, 2),
          'S2: letting go off the picture changes nothing'
        ).equals('C')
        expect(
          (await phone.all()).some(n => n.id === 'Plan field picker'),
          'S2: the picker closes after the drag'
        ).equals(false)
      } finally {
        await stop()
      }
    },

    's3-player-dragged-down-two-rows': async ctx => {
      const phone = await planTab(ctx)
      // His second inning holds C, which must move with him.
      await pick(phone, 3, 2, 'C')
      expect(await phone.cellValue(3, 2)).equals('C')
      // The player column's names, "Alonso #3", top to bottom.
      const players = async (): Promise<string[]> => {
        const column = (await phone.byId('Plan player 1')).bounds!
        return [
          ...new Set(
            (await phone.all())
              .filter(
                n =>
                  n.bounds != null &&
                  n.bounds.x < column.x + column.width &&
                  / #\d+$/.test(labelOf(n))
              )
              .sort((a, b) => a.bounds!.y - b.bounds!.y)
              .map(labelOf)
          )
        ]
      }
      const stop = await phone.record('coach-plan-phone-drag-s3.mp4')
      try {
        const before = await players()
        const moved = await phone.cellPlayer(3, 2)
        const third = (await phone.byId('Plan player 3')).bounds!
        const fifth = (await phone.byId('Plan player 5')).bounds!
        await phone.holdAndDrag(centre(third), {
          x: third.x + third.width / 2,
          y: fifth.y + fifth.height * 0.75
        })
        await pause(800)
        const after = await players()
        expect(after, 'S3: the third player bats fifth').deep.equals([
          before[0],
          before[1],
          before[3],
          before[4],
          before[2],
          ...before.slice(5)
        ])
        expect(
          (await phone.cellPlayer(5, 2)) === moved &&
            (await phone.cellValue(5, 2)) === 'C',
          'S3: his innings moved with him'
        ).equals(true)
        await phone.m.tapOn({ text: 'Lineup', timeout: 15000 })
        await phone.m.assertVisible({ text: 'Remove .*', timeout: 15000 })
        const order = await phone.lineup()
        expect(order[4], 'S3: the Lineup tab bats him fifth').equals(
          `Remove ${moved}`
        )
      } finally {
        await stop()
      }
    },

    's6-held-position-written-on-release': async ctx => {
      const phone = await planTab(ctx)
      // The cell holds LF, which its picker lights in the box's colour.
      await pick(phone, 2, 3, 'LF')
      const { at } = await pickerOf(phone, 2, 3, ['SS', 'LF'])
      await phone.m.tapOn({ id: 'Plan cell 2-3' })
      await pause(800)
      const stop = await phone.record('plan-picker-enlarged-s6.mp4')
      try {
        await phone.hold(centre(at.SS), 2500)
      } finally {
        await stop()
      }
      expect(
        await phone.cellValue(2, 3),
        'S6: letting go of the held SS writes SS'
      ).equals('SS')
      expect(
        (await phone.all()).some(n => n.id === 'Plan field picker'),
        'S6: the picker closes'
      ).equals(false)
    },

    's7-held-cell-dragged-to-position': async ctx => {
      const phone = await planTab(ctx)
      await pick(phone, 3, 4, 'LF')
      const { card, at } = await pickerOf(phone, 3, 4, ['C', 'P', 'SS', 'LF'])
      const cell = centre((await phone.byId('Plan cell 3-4')).bounds!)
      // C's enlarged box covers P: P is still reached under it.
      const cBox = enlarged(at.C, card)
      expect(
        cBox.y < at.P.y + at.P.height && cBox.y + cBox.height > at.P.y,
        'S7: C’s enlarged box covers P, which the finger still reached'
      ).equals(true)
      ctx.degrade(
        "S7's finger goes from the cell to SS in one move: maestro-d's dragAndDrop takes two points, not the old path resting on C and P"
      )
      const stop = await phone.record('plan-picker-enlarged-s7.mp4')
      try {
        await phone.holdAndDrag(cell, centre(at.SS))
      } finally {
        await stop()
      }
      expect(
        await phone.cellValue(3, 4),
        'S7: SS is reached and written on letting go'
      ).equals('SS')
    },

    's4-footer-in-bottom-inset-and-cancel-restores': async ctx => {
      const { phone, world } = await coachGame(ctx)
      const m = phone.m
      await m.tapOn({ text: 'Lineup', timeout: 15000 })
      await m.assertVisible({ text: 'Remove .*', timeout: 15000 })
      const coaching = await phone.footer()
      const bottom = coaching.bar.y + coaching.bar.height
      expect(
        Math.abs(bottom - (coaching.height - BOTTOM_INSET - 8 + FOOTER_DROP)),
        `the coaching bar ends ${FOOTER_DROP} points into the bottom inset`
      ).at.most(1)
      const nodes = await phone.all()
      const at = (text: string): Rect | undefined =>
        nodes.find(n => labelOf(n) === text && n.bounds != null)?.bounds
      const cancel = at('Cancel')
      const save = at('Save Rosters')
      const mic = nodes.find(n => n.id === 'Roster mic' && n.bounds != null)
      expect(cancel, 'Cancel is shown').not.equals(undefined)
      expect(save, 'Save Rosters is shown').not.equals(undefined)
      expect(mic?.bounds, 'the microphone is shown').not.equals(undefined)
      expect(
        cancel!.x + cancel!.width <= mic!.bounds!.x + 1 &&
          mic!.bounds!.x + mic!.bounds!.width <= save!.x + 1,
        'Cancel is left of the microphone, Save right of it'
      ).equals(true)
      expect(
        Math.abs(cancel!.y + cancel!.height / 2 - (save!.y + save!.height / 2)),
        'Cancel is on Save Rosters’ row'
      ).at.most(4)
      await m.takeScreenshot({ path: ctx.artifact('coach-footer-phone.png') })
      // Taking the leadoff batter out moves his card off the lineup;
      // Cancel puts it back.
      const order = await phone.lineup()
      expect(order.length, 'the lineup lists its batters').greaterThan(1)
      await m.tapOn({ text: order[0] })
      await pause(1000)
      expect(await phone.lineup(), 'the lineup changed').not.deep.equals(order)
      // A tap while the lineup still settles is lost: let it come to rest.
      await m.waitForAnimationToEnd()
      await pause(1500)
      await m.tapOn({ text: 'Cancel' })
      // Cancel reads the game again; wait for its lineup.
      let restored = await phone.lineup()
      for (
        let tries = 0;
        tries < 20 && JSON.stringify(restored) !== JSON.stringify(order);
        tries++
      ) {
        await pause(500)
        restored = await phone.lineup()
      }
      // The scorekeeper's Set Team Rosters sheet.
      const scorer = await openCoachApp(ctx, 'scorekeeper')
      await scorer.m.openLink({
        link: `teamstation://games/${world.ids.game}/score`
      })
      if ((await scorer.nodes()).some(node => labelOf(node) === 'Open'))
        await scorer.m.tapOn({ text: 'Open' })
      await scorer.m.assertVisible({
        text: 'Open scoring menu',
        timeout: 60000
      })
      await pause(2000)
      for (const close of ['OK', 'Close'])
        if ((await scorer.nodes()).some(n => labelOf(n) === close))
          await scorer.m.tapOn({ text: close })
      await scorer.m.tapOn({ text: 'Open scoring menu' })
      await scorer.m.tapOn({ text: 'Set Team Rosters', timeout: 15000 })
      await scorer.m.assertVisible({ text: 'Save Rosters', timeout: 30000 })
      const sheet = await (await phoneOf(ctx, scorer)).footer()
      const sheetBottom = sheet.bar.y + sheet.bar.height
      expect(
        Math.abs(sheetBottom - (sheet.height - BOTTOM_INSET + FOOTER_DROP)),
        `the scorekeeper's bar ends ${FOOTER_DROP} points into the bottom inset`
      ).at.most(1)
      // Checked last, so the scorekeeper's bar is read whatever Cancel did.
      expect(restored, 'Cancel restored the lineup').deep.equals(order)
    },

    's5-defense-field-six-rows': async ctx => {
      const { phone } = await defenseTab(ctx)
      const nodes = await phone.all()
      const cards = new Map<string, Rect>()
      for (const position of POSITIONS) {
        const card = nodes.find(
          n =>
            n.bounds != null &&
            new RegExp(`^(Clear|Assign) ${position}$`).test(labelOf(n))
        )
        expect(card?.bounds, `the ${position} card is on screen`).not.equals(
          undefined
        )
        cards.set(position, card!.bounds!)
      }
      const rows = cardRows(cards)
      expect(
        Math.max(...rows.map(row => row.length)),
        'no three cards share a vertical band'
      ).lessThan(3)
      expect(rows, 'six rows: CF; LF RF; SS 2B; 3B 1B; P; C').deep.equals([
        ['CF'],
        ['LF', 'RF'],
        ['2B', 'SS'],
        ['1B', '3B'],
        ['P'],
        ['C']
      ])
      const at = (position: string): Rect => cards.get(position)!
      expect(
        at('CF').y + at('CF').height <= Math.min(at('LF').y, at('RF').y) + 1,
        'CF is above LF and RF'
      ).equals(true)
      expect(
        at('P').y + 1 >=
          Math.max(at('3B').y + at('3B').height, at('1B').y + at('1B').height),
        'P is below 3B and 1B'
      ).equals(true)
      // XCUITest exposes only some cards' text, so every name it does show
      // in the field must lie wholly inside one card, on DefensiveField's
      // 17-point line (11 × 1.25 = 13.75 points, × 1.2, rounded). A phone
      // whose Text Size is set larger draws it larger too, so a line may be
      // up to a quarter larger, and a point more, which a name wrapped onto
      // two lines never is.
      const line = Math.round(11 * 1.25 * 1.2)
      const fieldBottom = Math.max(
        ...[...cards.values()].map(card => card.y + card.height)
      )
      const fieldTop = Math.min(...[...cards.values()].map(card => card.y))
      // A fielder's short name: any text among the cards but a position and
      // the field's Help and Clear, chosen by where it starts.
      const shown = nodes.filter(
        n =>
          n.type === 'StaticText' &&
          n.bounds != null &&
          n.bounds.y >= fieldTop &&
          n.bounds.y < fieldBottom &&
          !POSITIONS.includes(labelOf(n)) &&
          !['Help', 'Clear'].includes(labelOf(n))
      )
      expect(shown.length, 'the hierarchy shows a fielder’s name').greaterThan(
        0
      )
      for (const text of shown) {
        const holder = POSITIONS.filter(position =>
          inside(text.bounds!, at(position))
        )
        expect(
          holder.length,
          `"${labelOf(text)}" lies inside the ${holder.join(', ')} card`
        ).equals(1)
        expect(
          text.bounds!.height >= line &&
            text.bounds!.height <= Math.ceil(line * 1.25) + 1,
          `"${labelOf(text)}" is a line ${text.bounds!.height} points tall`
        ).equals(true)
      }
      for (const position of POSITIONS)
        expect(
          at(position).height,
          `${position}'s card (${at(position).height} points) holds two lines`
        ).at.least(40)
    },

    'd4-bench-player-on-vacated-box': async ctx => {
      const { phone } = await defenseTab(ctx)
      const tab = defenseOf(phone, await homeNames())
      const stop = await phone.record('defense-grip-drag-d4.mp4')
      try {
        const shortstop = (await tab.position('SS')).bounds
        await phone.m.tapOn({ text: 'Clear 2B' })
        expect(await tab.until('2B', false), 'D4: a tap clears 2B').equals(true)
        await phone.quickDrag(
          centre(shortstop),
          centre((await tab.position('2B')).bounds)
        )
        expect(
          (await tab.until('SS', false)) && (await tab.position('2B')).held,
          'D4: the shortstop dragged onto the empty 2B plays there'
        ).equals(true)
        const vacated = (await tab.card('SS'))?.bounds
        expect(
          vacated != null && vacated.height >= shortstop.height - 2,
          `D4: the empty SS box is its card's height (${vacated?.height ?? 0} of ${shortstop.height})`
        ).equals(true)
        const player = (await tab.bench())[0]
        await phone.holdAndDrag(nameOf(player.bounds!), centre(shortstop))
        expect(
          await tab.until('SS', true),
          'D4: a bench player dropped on the empty box’s middle plays SS'
        ).equals(true)
        expect(
          (await tab.bench()).some(n => labelOf(n) === labelOf(player)),
          `D4: ${labelOf(player)} left the bench`
        ).equals(false)
      } finally {
        await stop()
      }
    },

    'd3-grip-lifts-name-scrolls': async ctx => {
      const { phone } = await defenseTab(ctx)
      const tab = defenseOf(phone, await homeNames())
      const stop = await phone.record('defense-grip-drag-d3.mp4')
      try {
        await phone.m.tapOn({ text: 'Clear Defense' })
        expect(
          await tab.until('CF', false),
          'D3: Clear Defense empties CF'
        ).equals(true)
        await phone.m.waitForAnimationToEnd()
        const first = (await tab.bench())[0]
        const from = nameOf(first.bounds!)
        await phone.swipe(from, { x: from.x, y: from.y - 160 })
        const scrolled = (await phone.all()).find(
          n => n.bounds != null && labelOf(n) === labelOf(first)
        )
        expect(
          scrolled?.bounds == null || scrolled.bounds.y < first.bounds!.y - 20,
          'D3: a swipe from a card’s name scrolls the roster'
        ).equals(true)
        const fielded = async (): Promise<string[]> => {
          const held: string[] = []
          for (const at of POSITIONS)
            if ((await tab.position(at)).held) held.push(at)
          return held
        }
        expect(await fielded(), 'D3: the swipe lifted nobody').deep.equals([])
        const centreField = centre((await tab.position('CF')).bounds)
        await phone.quickDrag(
          nameOf((await tab.bench())[0].bounds!),
          centreField
        )
        await pause(500)
        expect(
          (await tab.position('CF')).held,
          'D3: a quick drag from a card’s name lifts nothing'
        ).equals(false)
        const gripped = (await tab.bench())[0]
        await phone.quickDrag(grip(gripped.bounds!), centreField)
        expect(
          await tab.until('CF', true),
          `D3: the same quick drag from ${labelOf(gripped)}’s grip puts him at CF`
        ).equals(true)
        const held = (await tab.bench())[0]
        await phone.holdAndDrag(
          nameOf(held.bounds!),
          centre((await tab.position('LF')).bounds)
        )
        expect(
          await tab.until('LF', true),
          `D3: a half-second hold on ${labelOf(held)}’s name, then a drag, puts him at LF`
        ).equals(true)
      } finally {
        await stop()
      }
    }
  }
})
