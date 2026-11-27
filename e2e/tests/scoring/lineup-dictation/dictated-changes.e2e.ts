import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import {
  LINEUP_SCENARIOS,
  lineupScreen,
  runLineupScenario,
  scenarioOf
} from './lineupScreen'

/**
 * Lineup and defense changes said into the roster sheet's microphone (R)
 * and the scoring screen's (S): staged, asked about, refused, saved and
 * undone as said. The clips play into the page's fake microphone; the
 * stack's recogniser and the default model, Claude Haiku 5.5, hear them.
 * The steps are `lineupScreen.ts`'s.
 */
export default defineHarness({
  id: 'scoring/lineup-dictation/dictated-changes',
  title:
    'Dictated lineup, defense and substitution changes stage and save as said',
  kind: 'e2e',
  covers: [
    'src/app/scoring/RosterChat.tsx',
    'src/app/scoring/RosterEditor.tsx',
    'src/app/scoring/dictatedRoster.ts',
    'src/app/scoring/dictationHook.ts',
    'src/common/scoring/rosterCommands.ts',
    'src/server/dictation/route.ts'
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
  // The stack's real recogniser and dictation model hear the clips.
  services: ['dictation-model'],
  apps: [],
  secrets: [],
  costUsd: 0.5,
  minutes: 25,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: Object.fromEntries(
    LINEUP_SCENARIOS.dictated.map(title => {
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
