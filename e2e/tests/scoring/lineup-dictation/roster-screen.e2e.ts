import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import {
  LINEUP_SCENARIOS,
  lineupScreen,
  runLineupScenario,
  scenarioOf
} from './lineupScreen'

/**
 * The roster sheet for a scorekeeper on the scoring screen: its tabs and
 * bar, Save Rosters lit only for a change, a lineup built by dragging and a
 * field set by dropping, and a bar that stays inside the screen. The steps
 * are `lineupScreen.ts`'s, which the dictated scenarios share.
 */
export default defineHarness({
  id: 'scoring/lineup-dictation/roster-screen',
  title:
    'The roster sheet builds and keeps a lineup and a field, its bar inside the screen',
  kind: 'e2e',
  covers: [
    'src/app/scoring/RosterEditor.tsx',
    'src/app/scoring/RosterSelector.tsx',
    'src/app/scoring/RosterSelectorDrag.tsx',
    'src/app/scoring/RosterDrag.tsx',
    'src/app/scoring/EditRosterList.tsx',
    'src/server/scoring/rosterWrites.ts'
  ],
  stack: 'isolated',
  fixtures: ['lineup-game'],
  exclusive: false,
  surfaces: {
    // The scoring screen draws in 3D: the Mac's Chrome, with its GPU.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 10,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: Object.fromEntries(
    LINEUP_SCENARIOS.roster.map(title => {
      const name = scenarioOf(title)
      return [
        name,
        async ctx => {
          const suite = lineupScreen(ctx)
          expect([...suite.tests.keys()], 'the suite runs this test').includes(
            name
          )
          await runLineupScenario(suite, name)
        }
      ]
    })
  )
})
