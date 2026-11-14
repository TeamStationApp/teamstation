import { expect } from 'chai'

import { angleEnds } from '../../../rigs/streaming/targetedScenarios'
import { defineTargeted } from '../../../rigs/streaming/targetedSpec'

/**
 * Tests the streaming fixes' claims IPAD15 (finished angle not stalled), S05 (live to recorded) and S08 (finished-game seek), on simulated video only.
 * See e2e/tests/streaming/README.md.
 */
export default defineTargeted({
  behaviour: 'angle-ends',
  scenario: 'finished-game',
  title:
    'A camera that ends says so and never "catching up"; the finished game seeks to its middle and plays on with no Retry',
  minutes: 12,
  covers: ['src/app/player/**', 'src/server/live/**'],
  steps: angleEnds,
  judge: ({ failed, steps }) => {
    expect(failed, `watchers that failed a step: see ${steps}`).deep.equals([])
  }
})
