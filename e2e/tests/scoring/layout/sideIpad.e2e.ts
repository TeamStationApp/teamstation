import { defineE2e } from '../../../core/spec'
import { mobileScoring } from '../../../rigs/scoringMobile'

export default defineE2e({
  id: 'scoring/layout/side-column',
  title: 'Rotate the iPad scoring field and retain its live log',
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringSidePanel.tsx',
    'src/app/field/scoringFrame.ts',
    'src/app/scoring/ScoringNoticeBar.tsx'
  ],
  stack: 'isolated',
  fixtures: ['coach-game'],
  exclusive: true,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-tablet'], hardware: 'none' }]
    },
    'web-safari-ios': {
      devices: [{ role: 'phone', needs: ['ios-tablet'], hardware: 'none' }]
    }
  },
  services: ['api', 'web'],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 15,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    ipad: async ctx => {
      await mobileScoring(ctx, true)
    }
  }
})
