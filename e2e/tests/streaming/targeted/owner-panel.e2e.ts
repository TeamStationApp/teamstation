import { ownerPanel } from '../../../rigs/streaming/targetedScenarios'
import { defineTargeted } from '../../../rigs/streaming/targetedSpec'

/**
 * Tests the streaming fixes' claims WEB11 (camera panel stuck after an unanswered read), on simulated video only.
 * See e2e/tests/streaming/README.md.
 */
export default defineTargeted({
  behaviour: 'owner-panel',
  scenario: 'unanswered-read',
  title:
    "The owner's camera panel shows a camera ended after one of its reads went unanswered for 90 s, without a reload",
  minutes: 6,
  covers: ['src/app/stream/**'],
  steps: ownerPanel
})
