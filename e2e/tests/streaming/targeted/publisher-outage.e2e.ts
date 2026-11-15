import { expect } from 'chai'

import { publisherOutage } from '../../../rigs/streaming/targetedScenarios'
import { defineTargeted } from '../../../rigs/streaming/targetedSpec'

/**
 * Tests the streaming fixes' claims IPAD02 (frozen tile after a recording gap) and S07 (publisher reconnect), on simulated video only.
 * See e2e/tests/streaming/README.md.
 */
export default defineTargeted({
  behaviour: 'publisher-outage',
  scenario: '45s',
  title:
    'A camera out for 45 s says so, then rejoins within 30 s, live and while the viewer is rewound',
  minutes: 14,
  covers: ['src/app/player/**', 'src/server/live/**', 'src/server/ingest/**'],
  steps: publisherOutage,
  judge: ({ failed, steps }) => {
    expect(failed, `watchers that failed a step: see ${steps}`).deep.equals([])
  }
})
