import { defineE2e } from '../../../core/spec'
import { wideScoring } from '../../../rigs/scoringWide'
export default defineE2e({
  id: 'scoring/layout/device-matrix',
  title:
    'The scoring layout follows a continuous desktop resize across its breakpoints',
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringSidePanel.tsx',
    'src/app/field/scoringFrame.ts',
    'src/app/field/BaseballScreen.tsx'
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
    'desktop-widths': async ctx => {
      await wideScoring(ctx, true)
    }
  }
})
