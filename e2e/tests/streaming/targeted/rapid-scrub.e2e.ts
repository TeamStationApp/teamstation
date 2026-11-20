import { expect } from 'chai'

import { basicScrub } from '../../../rigs/streaming/basicSoak'
import { defineTargeted } from '../../../rigs/streaming/targetedSpec'

/**
 * Twenty rapid scrubs on iPhone Safari's page player, each after a scrub to
 * the live edge in full screen: four synthetic cameras publish steadily, and
 * every 30 s Safari is scrubbed, with five quick moves along the timeline and
 * then to the live edge, in turn. Checks the picture moves again within 10 s of
 * each, and keeps moving until the next. See e2e/tests/streaming/README.md.
 */
export default defineTargeted({
  behaviour: 'rapid-scrub',
  scenario: 'safari-20',
  title:
    'Twenty rapid scrubs on iPhone Safari, each after a scrub to the live edge, the picture moving again within 10 s of each',
  minutes: 32,
  covers: [
    'e2e/rigs/streaming/**',
    'src/app/player/**',
    'src/app/screens/GameScreen.tsx',
    'src/server/live/**'
  ],
  steps: basicScrub({
    minutes: 27,
    watchers: ['safari'],
    // Safari's driver takes every other action in full screen, from the
    // page: each rapid scrub on the page player, after a scrub to the live
    // edge in full screen, as in the soak that froze.
    actions: ['rapidScrub', 'scrubRight'],
    actionEveryMs: 30_000,
    memory: false,
    frameLog: false
  }),
  judge: ({ failed, steps }) => {
    expect(failed, `watchers that failed a step: see ${steps}`).deep.equals([])
  }
})
