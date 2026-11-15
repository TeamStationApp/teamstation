import { expect } from 'chai'

import { basicScrub, watchersFromEnv } from '../../../rigs/streaming/basicSoak'
import { minutesFromEnv } from '../../../rigs/streaming/soakSchedule'
import { defineTargeted } from '../../../rigs/streaming/targetedSpec'

/**
 * The basic streaming soak: four synthetic cameras publish steadily for 30
 * minutes (no cuts, no network shaping) while the TeamStation Develop app on
 * an iPhone and on an Android phone, Chrome and TeamStation TV watch the live
 * multi-angle view, and Safari on a second iPhone watches one angle, all
 * scrubbed on a schedule. It records whether every angle keeps
 * moving, recovers within 10 s of each scrub and lines up within a second,
 * every frame Chrome presents, and memory per process. `SOAK_MINUTES` sets
 * its length, and `BASIC_WATCHERS` (a comma list) leaves watchers out. See
 * e2e/tests/streaming/README.md.
 */
export default defineTargeted({
  group: 'basic',
  behaviour: 'four-synthetic',
  scenario: 'scrub',
  title:
    'Four synthetic cameras stream live to an iPhone, an Android phone, Chrome, TeamStation TV and iPhone Safari for 30 minutes of scrubbing, every angle moving, recovering and aligned, with no memory growth',
  minutes: 35,
  covers: [
    'e2e/rigs/streaming/**',
    'src/app/player/**',
    'src/server/live/**',
    'src/server/ingest/**'
  ],
  steps: basicScrub({
    minutes: minutesFromEnv(process.env) ?? 30,
    watchers: watchersFromEnv(process.env)
  }),
  judge: ({ failed, steps }) => {
    expect(failed, `watchers that failed a step: see ${steps}`).deep.equals([])
  }
})
