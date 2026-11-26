import { defineE2e } from '../../../core/spec'
import { wideScoring } from '../../../rigs/scoringWide'
export default defineE2e({
  id: 'scoring/layout/side-column',
  title:
    'The side column frames both outfield corners and shows the live box score',
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringSidePanel.tsx',
    'src/app/field/scoringFrame.ts',
    'src/app/field/BaseballScreen.tsx',
    'src/app/scoring/OutcomePicker.tsx',
    'src/app/scoring/scoringMenuAnchor.ts'
  ],
  stack: 'isolated',
  fixtures: ['coach-game'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['api', 'web'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 8,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    web: async ctx => {
      await wideScoring(ctx, false)
    }
  }
})
