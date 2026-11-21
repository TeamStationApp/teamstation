import { expect } from 'chai'

import { streamCuts } from '../../../rigs/streaming/targetedScenarios'
import { defineTargeted } from '../../../rigs/streaming/targetedSpec'

/**
 * Cuts SynthA for 64 s again and again for 30 minutes, longer each time than
 * the 45 s live cushion, while iPhone Safari's page player and Chrome watch.
 * Checks every watcher shows it again after each one, and goes on doing so
 * after the next. See e2e/tests/streaming/README.md.
 */
export default defineTargeted({
  behaviour: 'long-cuts',
  scenario: 'repeat-64s',
  title:
    'A camera cut for 64 s again and again plays again on iPhone Safari and Chrome after every cut',
  minutes: 35,
  covers: [
    'e2e/rigs/streaming/**',
    'src/app/player/**',
    'src/app/screens/GameScreen.tsx',
    'src/server/live/**',
    'src/server/ingest/**'
  ],
  steps: streamCuts(30, { ladder: [64], watchers: ['chrome', 'safari'] }),
  judge: ({ failed, steps }) => {
    expect(failed, `watchers that failed a step: see ${steps}`).deep.equals([])
  }
})
