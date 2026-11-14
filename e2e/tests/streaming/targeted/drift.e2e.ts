import { drift } from '../../../rigs/streaming/targetedScenarios'
import { defineTargeted } from '../../../rigs/streaming/targetedSpec'

/**
 * Tests the streaming fixes' claims IPADSYNC08 (sub-second drift) and S10 (30-minute alignment), on simulated video only.
 * See e2e/tests/streaming/README.md.
 */
export default defineTargeted({
  behaviour: 'drift',
  scenario: '30min',
  title:
    'For 30 minutes every watcher shows the angles within 500 ms of each other, by their burned-in clocks',
  minutes: 36,
  covers: ['src/app/player/**'],
  steps: drift
})
