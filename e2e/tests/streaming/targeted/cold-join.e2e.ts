import { expect } from 'chai'

import { coldJoin } from '../../../rigs/streaming/targetedScenarios'
import { defineTargeted } from '../../../rigs/streaming/targetedSpec'

/**
 * Tests the streaming fixes' claims ANDROID04 (cold grid never opens) and IPAD03 (grid moment from a reloaded tile), on simulated video only.
 * See e2e/tests/streaming/README.md.
 */
export default defineTargeted({
  behaviour: 'cold-join',
  scenario: 'grid-opens',
  title:
    'A cold start opens the live grid with every angle moving within 20 s, without a seek, five times on each watcher',
  minutes: 20,
  covers: ['e2e/rigs/streaming/**', 'src/app/player/**'],
  steps: coldJoin,
  judge: ({ failed, steps }) => {
    expect(failed, `watchers that failed a step: see ${steps}`).deep.equals([])
  }
})
