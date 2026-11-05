import { defineE2e } from '../../../core/spec'
import { ConcurrentScoringRig } from '../../../rigs/concurrentScoring'

export default defineE2e({
  id: 'scoring/concurrency/follow',
  title: 'Scoring observers follow intermediate plays and the next batter',
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/scoring/scoringFollow.ts',
    'src/common/scoring/session.ts'
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
  faults: ['scoring-observer-stall'],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'intermediate-phases': async ctx => {
      const rig = new ConcurrentScoringRig(ctx)
      await rig.open()
      if (ctx.fault === 'scoring-observer-stall') {
        // External transport failure on the passive client only; scoring and
        // authentication on the other two sessions remain available.
        await rig.clients[1].page.setOfflineMode(true)
      }
      await rig.tap(0, '^Called Strike$')
      await rig.agree(0, '0 balls 1 strikes')
      await rig.tap(0, '^Called Strike$')
      await rig.agree(0, '0 balls 2 strikes')
      await rig.tap(0, '^More$')
      await rig.tap(0, '^Dropped Third Strike$')
      await rig.expectText(1, '3 strikes')
      await rig.capture('observer-before')
      await rig.tap(0, '^Safe$')
      await rig.finish(0)
      await rig.tap(0, '^Ball$')
      await rig.expectText(0, '1 balls 0 strikes', 10000)
      await rig.expectText(1, '1 balls 0 strikes')
      await rig.capture('observer-after')
      const events = await rig.api.gameEvents(rig.fixture.ids.game)
      if (
        events.plays.length !== 1 ||
        events.plays[0].result?.description !== 'Dropped Third Strike'
      )
        throw new Error('Dropped third strike was not saved exactly once')
      // The former watcher now scores. Both stay on their original routes.
      await rig.strikeout(1)
      await rig.agree(1, '0 balls 0 strikes 1 outs')
      await rig.hit(0, 'Single')
      await rig.expectText(1, 'Finish at-bat')
      await rig.finish(0)
      await rig.pitch(0, 'Ball')
      await rig.agree(0, '1 balls 0 strikes 1 outs')
    }
  }
})
