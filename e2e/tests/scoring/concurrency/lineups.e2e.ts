import { defineE2e } from '../../../core/spec'
import { ConcurrentScoringRig } from '../../../rigs/concurrentScoring'

export default defineE2e({
  id: 'scoring/concurrency/lineups',
  title: 'Coach lineup changes reach both scorers before handoff',
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/scoring/scoringFollow.ts',
    'src/app/scoring/rosterLive.ts'
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
    }
  }
})
