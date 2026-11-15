import { expect } from 'chai'

import { gapSeek } from '../../../rigs/streaming/targetedScenarios'
import { defineTargeted } from '../../../rigs/streaming/targetedSpec'

/**
 * Tests the streaming fixes' claims S06 (missing-footage notice), WEB16 (paused seek into a hole) and WEB06 (no moment before the take), on simulated video only.
 * See e2e/tests/streaming/README.md.
 */
export default defineTargeted({
  behaviour: 'gap-seek',
  scenario: 'paused',
  title:
    "A paused seek into a camera's missing footage shows its notice and holds the others at that moment; play resumes every angle; a skip before the take stays inside it",
  minutes: 15,
  covers: ['e2e/rigs/streaming/**', 'src/app/player/**', 'src/common/**'],
  steps: gapSeek,
  judge: ({ failed, steps }) => {
    expect(failed, `watchers that failed a step: see ${steps}`).deep.equals([])
  }
})
