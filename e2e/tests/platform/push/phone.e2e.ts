import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'
import { pushRun } from '../../../rigs/push/pushRun'

/**
 * N5 on an Android emulator and N6 on an iPhone simulator, in the app built
 * from this checkout for measuring (the debug build on Android, the Release
 * simulator build on iOS), against an API the run starts on this machine with
 * the chat fixture in a database of its own (`e2e/rigs/push/pushRun.ts`): a
 * DM and a mention notify the phone and open their conversation, and a
 * reminder for an RSVPed event opens it. Pass the emulator or simulator as
 * `--device phone=<serial or udid>`; it is never chosen for you. The Android
 * build needs `JAVA_HOME`, `ANDROID_HOME` and `TS_ANDROID_DEBUG_KEYSTORE`. The
 * steps' logs and screenshots are under `notifications/` in the run directory.
 */
export default defineE2e({
  id: 'platform/push/phone',
  title:
    'A DM, a mention and an RSVPed event’s reminder notify the phone, decrypted on it, and a tap opens what each is about',
  kind: 'e2e',
  covers: [
    'android/app/src/*/java/app/teamstation/app/push/**',
    'e2e/rigs/push/**',
    'ios/TeamStation/Push/**',
    'ios/TeamStationNotifications/**',
    'mobile/test/teamStationAppNotifications.e2e.ts',
    'scripts/push-coverage.mjs',
    'src/app/platform/notificationSwitches*',
    'src/app/platform/pushDevice*',
    'src/app/platform/pushState.ts',
    'src/app/push/**',
    'src/server/push/**',
    'src/server/routes/push.ts'
  ],
  stack: 'none',
  fixtures: [],
  // The run's push queue has a fixed Valkey prefix: one at a time.
  exclusive: true,
  surfaces: {
    'android-app': {
      devices: [{ role: 'phone', needs: ['android-phone'], hardware: 'none' }]
    },
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'none' }]
    }
  },
  services: ['api'],
  // The run builds and installs its own app: no prepared Mason build.
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 25,
  guards: [],
  faults: [],
  manual: false,
  scenarios: {
    'dms-mentions-reminders': async ctx => {
      const run = await pushRun(
        ctx,
        ctx.surface === 'ios-app' ? 'ios' : 'android'
      )
      expect(run.code, `N5/N6 failed: see ${run.log}`).equals(0)
    }
  }
})
