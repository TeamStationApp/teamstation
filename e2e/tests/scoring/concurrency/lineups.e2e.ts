import { defineE2e } from '../../../core/spec'
import { ConcurrentScoringRig } from '../../../rigs/concurrentScoring'

export default defineE2e({
  id: 'scoring/concurrency/lineups',
  title: 'Coach lineup changes reach both scorers before handoff',
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/scoring/scoringFollow.ts',
    'src/app/scoring/rosterLive.tsx',
    'src/app/screens/CoachGameScreen.tsx'
  ],
  stack: 'isolated',
  fixtures: ['concurrent-scoring'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['api', 'web'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'handoff-and-conflicts': async ctx => {
      const rig = new ConcurrentScoringRig(ctx)
      await rig.open()
      await rig.rosters(0)
      await rig.rosters(1)
      await rig.tap(2, '^Lineup$')
      const before = await rig.lineup(2)
      await rig.reorder(2, 3, 5)
      const after = await rig.lineup(2)
      if (JSON.stringify(before) === JSON.stringify(after))
        throw new Error('Coach reorder did not move a player')
      await rig.tap(2, '^Save Rosters$')
      await rig.expectLineup(0, after)
      await rig.expectLineup(1, after)
      await rig.capture('coach-lineup-followed')
      await rig.tap(0, '^Cancel$')
      await rig.tap(1, '^Cancel$')
      await rig.pitch(0, 'Ball')
      await rig.agree(0, '1 balls 0 strikes')
      await rig.pitch(1, 'Called Strike')
      await rig.agree(1, '1 balls 1 strikes')
      await rig.capture('lineup-handoff-after')
      await rig.rosters(0)
      await rig.rosters(1)
      await rig.reorder(0, 4, 6)
      const draft = await rig.lineup(0)
      await rig.reorder(2, 3, 5)
      const newer = await rig.lineup(2)
      await rig.tap(2, '^Save Rosters$')
      await rig.clients[0].m.assertVisible({
        id: 'Roster conflict',
        timeout: 3000
      })
      await rig.expectLineup(0, draft)
      await rig.expectLineup(1, newer)
      await rig.capture('dirty-lineup-preserved')
      await rig.tap(0, '^Cancel$')
      await rig.rosters(0)
      await rig.expectLineup(0, newer)
      await rig.tap(0, '^Cancel$')
      await rig.tap(1, '^Cancel$')

      // The coach's valid refusal during an unresolved play stays visible,
      // and the staged order survives until the play is finished.
      await rig.pitch(1, 'Called Strike')
      await rig.agree(1, '1 balls 2 strikes')
      await rig.more(1, 'Dropped Third Strike')
      await rig.expectText(0, '3 strikes')
      await rig.capture('unresolved-before-coach-edit')
      await rig.reorder(2, 3, 5)
      const held = await rig.lineup(2)
      await rig.capture('unresolved-after-coach-edit')
      // An awarded batter still occupies his base until the at-bat closes.
      // The editor refuses this state before submitting the lineup.
      await rig.expectText(
        2,
        'Choose a next batter in the lineup who is not already on base.'
      )
      await rig.clients[2].m.assertVisible({
        css: '[aria-label="Save Rosters"][aria-disabled="true"]'
      })
      await rig.expectLineup(2, held)
      await rig.tap(1, '^Safe$')
      await rig.finish(1)
      await rig.boundary(1, 1)
      await rig.tap(2, '^Save Rosters$')
      await rig.rosters(0)
      await rig.rosters(1)
      await rig.expectLineup(0, held)
      await rig.expectLineup(1, held)
      await rig.capture('lineup-conflict-recovered')
      await rig.recordCoverage()
    }
  }
})
