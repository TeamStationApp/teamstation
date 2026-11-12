import { expect } from 'chai'

import { ROOT } from '../../../core/manifest'
import { BlockedError, HarnessError } from '../../../core/result'
import { defineE2e } from '../../../core/spec'
import { runSoak } from '../../../rigs/streaming/soakRun'
import {
  minutesFromEnv,
  soakSchedule
} from '../../../rigs/streaming/soakSchedule'
import { soakParts } from '../../../rigs/streaming/soakWiring'

/**
 * Two hours of one game filmed by two phones and a synthetic camera, watched
 * at once on an iPhone (switching between the app and Safari), an Android
 * phone, an iPad, an Apple TV and Chrome, while the schedule scrubs, skips,
 * slows, cuts angles, re-enters and relaunches each surface, and cuts the
 * synthetic camera eight times. It passes when every gate held every time and
 * no device's memory grew. `SOAK_MINUTES=15` compresses it for a dry run.
 *
 * It runs against an attached stack (`e2e stack attach`), never this Mac's:
 * the stack has no fault proxy, so it proves no fault.
 */
export default defineE2e({
  id: 'streaming/soak/two-hour',
  title:
    'A two-hour game streams to six watching surfaces through scrubs, cuts, outages and relaunches without a stall or memory growth',
  kind: 'e2e',
  covers: [
    'src/app/player/**',
    'src/app/stream/**',
    'src/server/live/**',
    'src/server/ingest/**',
    'appletv/**'
  ],
  stack: 'isolated',
  fixtures: [],
  exclusive: true,
  surfaces: {
    'web-chromium': {
      devices: [
        { role: 'publisherA', needs: ['ios-phone'], hardware: 'required' },
        { role: 'publisherB', needs: ['android-phone'], hardware: 'required' },
        {
          role: 'iphone',
          needs: ['ios-phone', 'safari'],
          hardware: 'required'
        },
        { role: 'android', needs: ['android-phone'], hardware: 'required' },
        { role: 'ipad', needs: ['ipad'], hardware: 'required' },
        { role: 'tv', needs: ['apple-tv', 'ndi-output'], hardware: 'required' }
      ]
    }
  },
  services: ['web', 'api'],
  apps: ['teamstation-ios', 'teamstation-android', 'teamstation-tv'],
  secrets: [],
  costUsd: 0,
  minutes: 135,
  guards: [],
  faults: [],
  manual: false,
  scenarios: {
    'six-surfaces': async ctx => {
      const schedule = soakSchedule({ minutes: minutesFromEnv(process.env) })
      const { parts, cleanup } = await soakParts({ ctx, schedule, cwd: ROOT })
      try {
        const report = await runSoak(parts)
        if (report.exitCode === 2) {
          throw new BlockedError(
            `the soak could not judge: see ${parts.runDir}/report.md`
          )
        }
        if (report.exitCode === 3) {
          throw new HarnessError(
            `the soak's harness broke: see ${parts.runDir}/report.md`
          )
        }
        expect(
          report.exitCode,
          `the soak's gates and memory: see ${parts.runDir}/report.md`
        ).equals(0)
      } finally {
        await cleanup()
      }
    }
  }
})
