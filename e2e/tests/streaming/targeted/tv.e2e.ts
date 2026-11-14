import { tvCameras } from '../../../rigs/streaming/targetedScenarios'
import { defineTargeted } from '../../../rigs/streaming/targetedSpec'

/**
 * Tests the streaming fixes' claims the TV's cold start, TV10 (rejoin), TVSYNC09 (remap) and S03 to S04 (TV transport and recovery), on simulated video only.
 * See e2e/tests/streaming/README.md.
 */
export default defineTargeted({
  behaviour: 'tv',
  scenario: 'cameras',
  title:
    'TeamStation TV starts cold to its code or home, offers four cameras, skips inside the take, recovers a camera after its outage and shows one ended',
  minutes: 12,
  covers: ['src/app/tv/**', 'appletv/**'],
  steps: tvCameras
})
