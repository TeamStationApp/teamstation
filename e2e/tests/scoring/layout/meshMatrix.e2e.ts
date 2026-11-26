import { defineE2e } from '../../../core/spec'
import { mobileScoring } from '../../../rigs/scoringMobile'

export default defineE2e({
  id: 'scoring/layout/device-matrix',
  title: 'Score from a leased device online, offline and during reconnect',
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
      devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'none' }]
    },
    'android-app': {
      devices: [{ role: 'phone', needs: ['android-phone'], hardware: 'none' }]
    },
    'web-safari-ios': {
      devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'none' }]
    },
    'web-chrome-android': {
      devices: [{ role: 'phone', needs: ['android-phone'], hardware: 'none' }]
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
    'mesh-devices': async ctx => {
      await mobileScoring(ctx, false)
    }
  }
})
