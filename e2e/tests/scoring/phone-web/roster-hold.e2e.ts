import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import {
  type Bounds,
  center,
  withPhoneScorer
} from '../../../rigs/scoring/phoneWebScorer'

/**
 * Holding and flicking on the roster sheet in Safari on an iPhone: a quick
 * swipe on an enabled row scrolls the list rather than lifting the row, a
 * held row drops into the lineup, a held defender drops onto Unassigned and
 * fills the cleared pitcher, and Save keeps it.
 */
export default defineHarness({
  id: 'scoring/phone-web/roster-hold',
  title:
    'Safari roster rows scroll on a quick swipe and move on a hold, in the lineup and on defense',
  kind: 'e2e',
  covers: ['src/app/scoring/**', 'src/app/field/**'],
  stack: 'isolated',
  fixtures: ['scoring-preview'],
  exclusive: false,
  surfaces: {
    'web-safari-ios': {
      // The field draws in 3D: a GPU, so a physical iPhone.
      devices: [
        { role: 'browser', needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'quick-scroll-and-held-drops': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.freshGame({ restart: true })
        await s.tap('Open scoring menu')
        await s.tap('Set Team Rosters')
        await s.visible('^Set Team Rosters$')
        await s.tap('Remove Player 2')
        await s.shot('hold-start')
        const row = async (text: string): Promise<Bounds> => {
          const n = (await s.nodes()).find(node => node.text === text)
          if (n?.bounds == null) throw new Error(`No row ${text}`)
          return n.bounds
        }
        const sourceLabel = 'Add Player 2 to Lineup'
        const from = center(await row(sourceLabel))
        await s.gesture(
          [from, { x: from.x, y: from.y - 90, duration: 250 }],
          40
        )
        await s.shot('quick-scroll')
        const shifted = await row(sourceLabel)
        expect(
          shifted.y,
          'Quick swipe must scroll enabled roster row'
        ).lessThan(from.y - 30)
        const list = await row('Roster players')
        await s.gesture(
          [
            { x: list.x + 25, y: list.y + 25 },
            { x: list.x + 25, y: list.y + list.height - 20, duration: 300 }
          ],
          40
        )
        await row(sourceLabel)
        await s.m.dragAndDrop({
          from: { text: '^Add Player 2 to Lineup$' },
          to: { text: '^Reorder Player 3$' },
          holdDuration: 600,
          duration: 800
        })
        await s.visible('^Reorder Player 2$')
        await s.shot('held-drop')
        await s.tap('Defense')
        await s.tap('Clear P')
        await s.m.dragAndDrop({
          from: { text: '^Jordan K\\.$' },
          to: { text: '^Unassigned$' },
          holdDuration: 600,
          duration: 800
        })
        const assigned = (await s.nodes()).find(n => n.text === 'Clear P')
        expect(
          assigned != null && assigned.enabled !== false,
          'Pitcher must be assigned after held defensive drop'
        ).equals(true)
        await s.shot('held-defense')
        await s.tap('Save Rosters')
        await s.visible('^Undo Set team roster$')
        s.log(
          'PASS Safari quick roster scrolling, held lineup insertion and defensive drop, Save'
        )
      })
    }
  }
})
