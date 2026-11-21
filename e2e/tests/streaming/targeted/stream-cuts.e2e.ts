import { expect } from 'chai'

import { streamCuts } from '../../../rigs/streaming/targetedScenarios'
import { defineTargeted } from '../../../rigs/streaming/targetedSpec'

/**
 * Cuts a camera for 4, 8, 16, 32 and 64 s in turn: the whole ladder at least
 * once, then on for the rest of 15 minutes. Checks every watcher shows it
 * again within 5 s of its return.
 * See e2e/tests/streaming/README.md.
 */
export default defineTargeted({
  behaviour: 'stream-cuts',
  scenario: 'ladder-15min',
  title:
    'A camera cut for 4 to 64 s plays again on every watcher within 5 s of its return',
  minutes: 30,
  covers: [
    'e2e/rigs/streaming/**',
    'src/app/player/**',
    'src/app/tv/**',
    'src/app/screens/GameScreen.tsx',
    'src/server/live/**',
    'src/server/ingest/**'
  ],
  steps: streamCuts(15, { fullLadders: 1 }),
  judge: ({ failed, steps }) => {
    expect(failed, `watchers that failed a step: see ${steps}`).deep.equals([])
  }
})
