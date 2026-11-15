import { expect } from 'chai'

import { receiverOutage } from '../../../rigs/streaming/targetedScenarios'
import { defineTargeted } from '../../../rigs/streaming/targetedSpec'

/**
 * Tests the streaming fixes' claims S07 to S09 (recovery after a watcher's outage, with pause and rewind kept), on simulated video only.
 * See e2e/tests/streaming/README.md.
 */
export default defineTargeted({
  behaviour: 'receiver-outage',
  scenario: '180s',
  title:
    'A watcher whose own network is out for three minutes plays again within 30 s, and keeps a pause and a rewind across the outage',
  minutes: 25,
  covers: ['src/app/player/**'],
  steps: receiverOutage(),
  judge: ({ failed, steps }) => {
    expect(failed, `watchers that failed a step: see ${steps}`).deep.equals([])
  }
})
