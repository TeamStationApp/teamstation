import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { ROSTER_CARD_GAP } from '../../../../src/app/scoring/rosterLayout'
import {
  defineHarness,
  type HarnessContext,
  type SurfaceNeeds
} from '../../../core/spec'
import {
  type Bounds,
  centre,
  flick,
  heldDrag,
  labelOf,
  type Node,
  openPhoneScorer,
  type PhoneScorer,
  scorePath,
  sleep
} from '../../../rigs/scoring/phoneScorer'

/**
 * The roster editor's held drags on a phone (Set Team Rosters): a card held
 * and dragged moves in the lineup and the list under it stays put, a drop
 * lands one rem from its neighbours, a quick swipe still scrolls, the three
 * columns are one rem apart, a held drop fills a defensive position, and a
 * drop low on the end of the lineup lands at its end. The world's game has
 * fourteen players a side, nine in the lineup (`roster-players`).
 */

interface Card {
  name: string
  enabled: boolean
  bounds: Bounds
}

/** Lineup, roster and defense cards, and the checks on them. */
interface Editor {
  app: PhoneScorer
  /** Hierarchy units per point: 1 on iOS, the density on Android. */
  scale: number
  gap: number
  tolerance: number
  bounds: (text: string) => Promise<Bounds>
  cards: (prefix: string, suffix?: string) => Promise<Card[]>
  lineup: () => Promise<Card[]>
  settled: () => Promise<Card[]>
  shot: (name: string) => Promise<void>
  log: (line: string) => void
  check: (ok: boolean, message: string) => void
  spaced: (column: string, list: Card[]) => void
  lines: string[]
}

const order = (list: Card[]): string => list.map(c => c.name).join(', ')
const centreX = (b: Bounds): number => b.x + b.width / 2
const third = (b: Bounds): number => b.y + b.height / 3
const mid = (b: Bounds): { x: number; y: number } => centre(b)

/** The card height the editor draws, in points. */
const CARD_HEIGHT = 48

async function openEditor(ctx: HarnessContext): Promise<Editor> {
  const world = await ctx.fixture('roster-players')
  const app = await openPhoneScorer(ctx, 'scorer')
  const lines: string[] = []
  const all = async (): Promise<Node[]> => await app.nodes()
  const bounds = async (text: string): Promise<Bounds> => {
    const found = (await all()).find(n => labelOf(n) === text)?.bounds
    expect(found, `${text} is on screen`).to.not.equal(undefined)
    return found!
  }
  const cards = async (prefix: string, suffix = ''): Promise<Card[]> => {
    const seen = new Map<string, Card>()
    for (const node of await all()) {
      const name = labelOf(node)
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue
      if (node.bounds == null) continue
      seen.set(name, {
        name: name.slice(prefix.length),
        enabled: node.enabled !== false,
        bounds: node.bounds
      })
    }
    return [...seen.values()].sort((a, b) => a.bounds.y - b.bounds.y)
  }
  const lineup = async (): Promise<Card[]> => await cards('Reorder ')
  const editor: Editor = {
    app,
    scale: 1,
    gap: ROSTER_CARD_GAP,
    tolerance: 1,
    bounds,
    cards,
    lineup,
    settled: async () => {
      // Two reads 500 ms apart agree: a fling has stopped.
      let last = JSON.stringify(await lineup())
      for (let i = 0; i < 10; i++) {
        await sleep(500)
        const now = JSON.stringify(await lineup())
        if (now === last) return JSON.parse(now) as Card[]
        last = now
      }
      throw new Error('The lineup never settled')
    },
    shot: async name => {
      await app.m.takeScreenshot({
        path: ctx.artifact(`${app.platform}-${name}.png`)
      })
      editor.log(`captured ${app.platform}-${name}.png`)
    },
    log: line => {
      lines.push(line)
    },
    check: (ok, message) => {
      editor.log(`${ok ? 'ok' : 'FAIL'}: ${message}`)
      expect(ok, message).to.equal(true)
    },
    spaced: (column, list) => {
      // Neighbouring cards stand exactly one gap apart, none over another.
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1].bounds
        const next = list[i].bounds
        const between = next.y - (prev.y + prev.height)
        editor.check(
          Math.abs(between - editor.gap) <= editor.tolerance,
          `${column}: ${list[i - 1].name} to ${list[i].name} is ${(between / editor.scale).toFixed(1)} apart (want ${ROSTER_CARD_GAP})`
        )
      }
    },
    lines
  }
  await app.open(scorePath(world.ids.game))
  await app.m.tapOn({ text: 'Open scoring menu', timeout: 30000 })
  await app.m.tapOn({ text: 'Set Team Rosters', timeout: 15000 })
  await app.m.assertVisible({ text: 'Batting lineup', timeout: 15000 })
  await sleep(800)
  // Hierarchy bounds are points on iOS and pixels on Android: a lineup
  // card is 48 points tall, which gives the density.
  if (app.platform === 'android') {
    const heights = (await lineup())
      .map(c => c.bounds.height)
      .sort((a, b) => a - b)
    editor.scale = heights[Math.floor(heights.length / 2)] / CARD_HEIGHT
  }
  editor.gap = ROSTER_CARD_GAP * editor.scale
  // iOS rounds accessibility frames outward, so a 48-point card reads as 49
  // and an exact gap as one point short; allow a point either way.
  editor.tolerance = Math.max(1, editor.scale)
  return editor
}

/** Each scenario's steps, kept in the run directory whatever happened. */
async function logged(
  ctx: HarnessContext,
  name: string,
  work: (editor: Editor) => Promise<void>
): Promise<void> {
  const editor = await openEditor(ctx)
  const { platform } = editor.app
  try {
    editor.log(name)
    await work(editor)
    editor.log(`PASS ${name} on ${platform}`)
  } finally {
    writeFileSync(
      ctx.artifact(`${platform}-steps.txt`),
      editor.lines.join('\n') + '\n'
    )
  }
}

const devices = (needs: string): SurfaceNeeds => ({
  // The scoring screen's field draws in 3D: a GPU, so a physical phone.
  devices: [
    { role: 'device', needs: [needs, 'gpu'], simulator: 'never' as const }
  ]
})

export default defineHarness({
  id: 'scoring/roster-drag/held-drags',
  title: "The roster editor's held drags move cards, and swipes still scroll",
  kind: 'e2e',
  covers: [
    'src/app/scoring/rosterLayout.ts',
    'src/app/scoring/RosterEditor.tsx',
    'src/app/scoring/RosterDrag*.tsx',
    'src/app/scoring/rosterGesture.ts',
    'src/app/scoring/rosterHold.ts'
  ],
  stack: 'isolated',
  fixtures: ['roster-players'],
  exclusive: false,
  surfaces: {
    'ios-app': devices('ios-phone'),
    'android-app': devices('android-phone')
  },
  services: [],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 20,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'lineup-drag-keeps-list': async ctx => {
      await logged(ctx, 'D1 held lineup drag; the list stays put', async e => {
        const { scale } = e
        const list = await e.bounds('Batting lineup')
        await flick(
          e.app.m,
          centreX(list),
          list.y + list.height - 40 * scale,
          list.y + list.height - 160 * scale
        )
        let start = await e.settled()
        // Keep at least two cards below the visible end, so an Android
        // overscroll clamp cannot move the list after the drop.
        const last = start.at(-1)!.bounds
        if (
          last.y + last.height - (list.y + list.height) <
          2 * (last.height + e.gap)
        ) {
          await flick(
            e.app.m,
            centreX(list),
            list.y + 80 * scale,
            list.y + 140 * scale
          )
          start = await e.settled()
        }
        const k = start.findIndex(
          c => c.bounds.y + c.bounds.height / 2 > list.y + 48 * scale
        )
        expect(
          k > 0 && k + 3 < start.length,
          'A card below the auto-scroll band'
        ).to.equal(true)
        await heldDrag(e.app.m, mid(start[k].bounds), {
          x: centreX(start[k + 3].bounds),
          y: third(start[k + 3].bounds)
        })
        await sleep(800)
        const after = await e.lineup()
        await e.shot('lineup-drag-dropped')
        const names = start.map(c => c.name)
        const want = [...names]
        want.splice(k + 3, 0, ...want.splice(k, 1))
        const got = after.map(c => c.name)
        e.log(`D1 order before ${names.join(', ')}`)
        e.log(`D1 order after ${got.join(', ')}`)
        // Android lists only the cards on screen, so compare the ones both
        // reads saw. The dropped card is among them: the list did not scroll.
        e.check(
          want.filter(name => got.includes(name)).join(', ') ===
            got.filter(name => names.includes(name)).join(', ') &&
            got.indexOf(names[k]) === k + 3,
          `the held card moved from slot ${k} to slot ${k + 3}`
        )
        for (let i = 0; i < k; i++) {
          const moved = after.find(c => c.name === names[i])
          e.check(
            moved != null &&
              Math.abs(moved.bounds.y - start[i].bounds.y) <= e.tolerance,
            `${names[i]} above the held card kept its y (${start[i].bounds.y} → ${moved?.bounds.y})`
          )
        }
      })
    },

    'drop-lands-separate-before': async ctx => {
      await logged(ctx, 'D2 a drop lands separate (before edge)', async e => {
        const start = await e.lineup()
        await heldDrag(e.app.m, mid(start[0].bounds), {
          x: centreX(start[3].bounds),
          y: third(start[3].bounds)
        })
        await sleep(800)
        const after = await e.lineup()
        await e.shot('lineup-drop-overlap')
        const names = start.map(c => c.name)
        const want = [names[1], names[2], names[3], names[0], names[4]].join(
          ', '
        )
        e.log(`D2 order after ${order(after)}`)
        e.check(order(after.slice(0, 5)) === want, `the order starts ${want}`)
        const dropped = after.find(c => c.name === names[0])
        e.check(
          dropped != null &&
            Math.abs(dropped.bounds.height - start[0].bounds.height) <=
              e.tolerance,
          `${names[0]} is at full height (${dropped?.bounds.height})`
        )
        e.spaced('lineup', after)
      })
    },

    'drop-lands-separate-after-and-from-roster': async ctx => {
      await logged(
        ctx,
        'D3 a drop lands separate (after edge, and from the roster)',
        async e => {
          const start = await e.lineup()
          const names = start.map(c => c.name)
          await heldDrag(e.app.m, mid(start[1].bounds), {
            x: centreX(start[4].bounds),
            y: start[4].bounds.y + (start[4].bounds.height * 3) / 4
          })
          await sleep(800)
          const first = await e.lineup()
          const want = [
            names[0],
            names[2],
            names[3],
            names[4],
            names[5],
            names[1],
            names[6]
          ].join(', ')
          e.log(`D3 order after the first drop ${order(first)}`)
          e.check(order(first.slice(0, 7)) === want, `the order starts ${want}`)
          e.spaced('lineup', first)
          // A lineup player in view, so the remove button can be tapped and
          // the roster drag starts on screen once he is back in the roster.
          const rosterList = await e.bounds('Roster players')
          const lineupList = await e.bounds('Batting lineup')
          const inView = (b: Bounds, list: Bounds): boolean =>
            b.y >= list.y && b.y + b.height <= list.y + list.height
          const removed = first.find(c => inView(c.bounds, lineupList))?.name
          expect(removed, 'A lineup player in view').to.not.equal(undefined)
          await e.app.m.tapOn({ text: `Remove ${removed}`, timeout: 10000 })
          await sleep(600)
          const source = (await e.cards('Add ', ' to Lineup')).find(
            c => c.name === `${removed} to Lineup`
          )
          expect(
            source != null &&
              source.bounds.y + source.bounds.height <=
                rosterList.y + rosterList.height,
            `${removed} is back in the roster, in view`
          ).to.equal(true)
          const target = (await e.lineup())[2]
          await heldDrag(e.app.m, mid(source!.bounds), {
            x: centreX(target.bounds),
            y: third(target.bounds)
          })
          await sleep(800)
          const second = await e.lineup()
          e.log(`D3 order after the roster drop ${order(second)}`)
          e.check(second[2]?.name === removed, `${removed} is back at slot 2`)
          e.spaced('lineup', second)
          const roster = await e.cards('Add ', ' to Lineup')
          e.check(
            !roster.some(c => c.name === `${removed} to Lineup`),
            `${removed} left the roster once placed in the lineup`
          )
          e.spaced('roster', roster)
          await e.shot('roster-drop')
        }
      )
    },

    'quick-swipe-scrolls': async ctx => {
      await logged(ctx, 'D4 a quick swipe still scrolls', async e => {
        const list = await e.bounds('Batting lineup')
        const start = await e.lineup()
        await flick(
          e.app.m,
          centreX(list),
          list.y + list.height - 40 * e.scale,
          list.y + list.height - 130 * e.scale
        )
        const after = await e.settled()
        // A fling can carry the top card off screen; measure one both reads see.
        const seen = after.find(c => start.some(s => s.name === c.name))
        const was = start.find(c => c.name === seen?.name)
        e.check(
          seen != null &&
            was != null &&
            was.bounds.y - seen.bounds.y > 30 * e.scale,
          `the lineup scrolled (${seen?.name}: ${was?.bounds.y} → ${seen?.bounds.y})`
        )
        const common = (list: Card[], other: Card[]): string =>
          order(list.filter(c => other.some(o => o.name === c.name)))
        e.check(
          common(after, start) === common(start, after),
          'the order is unchanged'
        )
      })
    },

    'columns-one-rem-apart': async ctx => {
      await logged(ctx, 'D5 one rem apart in all three columns', async e => {
        await e.shot('roster-spacing')
        e.spaced('roster', await e.cards('Add ', ' to Lineup'))
        e.spaced('lineup', await e.lineup())
        await e.app.m.tapOn({ text: 'Defense', timeout: 10000 })
        await sleep(800)
        await e.shot('defense-spacing')
        // A defense card is the view that directly holds its Clear button.
        const defense = (await e.app.nodes())
          .filter(
            n =>
              n.bounds != null &&
              (n.children ?? []).some(c => /^Clear [A-Z0-9]+$/.test(labelOf(c)))
          )
          .map(n => ({ name: labelOf(n), enabled: true, bounds: n.bounds! }))
        const unique = [
          ...new Map(defense.map(r => [r.bounds.y, r])).values()
        ].sort((a, b) => a.bounds.y - b.bounds.y)
        e.spaced('defense', unique)
      })
    },

    'held-defensive-drop': async ctx => {
      await logged(ctx, 'D6 held defensive drop', async e => {
        await e.app.m.tapOn({ text: 'Defense', timeout: 10000 })
        await sleep(600)
        await e.app.m.tapOn({ text: 'Clear P', timeout: 10000 })
        await sleep(600)
        // In defense the roster cards are labelled with the player's name.
        const column = await e.bounds('Roster players')
        const player = (await e.app.nodes()).find(
          n =>
            n.bounds != null &&
            n.enabled !== false &&
            /^Player \d+$/.test(labelOf(n)) &&
            n.bounds.x < column.x + column.width &&
            n.bounds.height > 40 * e.scale
        )
        expect(player?.bounds, 'An enabled roster player').to.not.equal(
          undefined
        )
        const name = labelOf(player!)
        const target = await e.bounds('Unassigned')
        await heldDrag(e.app.m, mid(player!.bounds!), mid(target))
        await sleep(800)
        const nodes = await e.app.nodes()
        const clear = nodes.find(n => labelOf(n) === 'Clear P')
        e.check(clear != null && clear.enabled !== false, `${name} fills P`)
        const card = nodes.find(n => labelOf(n) === name)
        e.check(
          card?.enabled === false &&
            Math.abs(card.bounds!.height - player!.bounds!.height) <=
              e.tolerance,
          `${name}'s roster card is disabled at full height (${card?.bounds?.height})`
        )
        await e.shot('defense-drop')
      })
    },

    'drop-low-lands-at-end': async ctx => {
      await logged(
        ctx,
        'D7 a drop low on the end of the lineup lands at the end',
        async e => {
          const list = await e.bounds('Batting lineup')
          for (let i = 0; i < 4; i++)
            await flick(
              e.app.m,
              centreX(list),
              list.y + list.height - 20 * e.scale,
              list.y + 20 * e.scale
            )
          const start = await e.settled()
          const end = await e.bounds('Drop at end of lineup')
          const moving = start.find(
            c =>
              c.bounds.y >= list.y &&
              c.bounds.y + c.bounds.height <= end.y &&
              c.name !== start.at(-1)!.name
          )
          expect(
            moving,
            'A card in view above the end of the lineup'
          ).to.not.equal(undefined)
          // Low on the end target, inside the bottom auto-scroll band.
          await heldDrag(e.app.m, mid(moving!.bounds), {
            x: centreX(end),
            y: end.y + end.height - 4 * e.scale
          })
          await sleep(800)
          const after = await e.settled()
          e.log(`D7 order after ${order(after)}`)
          e.check(
            after.at(-1)?.name === moving!.name,
            `${moving!.name} is last in the lineup`
          )
        }
      )
    }
  }
})
